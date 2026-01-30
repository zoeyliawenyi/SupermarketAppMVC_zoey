const User = require('../models/User');
const Subscription = require('../models/Subscription');
const UsageRecord = require('../models/UsageRecord');
const { getStripe } = require('../services/stripe');

const buildPlans = () => {
  const monthlyPriceId = (process.env.STRIPE_PRICE_ZOZOPLUS || '').trim();
  const usagePriceId = (process.env.STRIPE_PRICE_ZOZOPLUS_USAGE || '').trim();
  return [
    {
      id: 'zozoplus_monthly',
      name: 'ZozoPlus Membership',
      description: 'Monthly subscription with member perks',
      priceLabel: 'S$9.90 / month',
      priceId: monthlyPriceId,
      usagePriceId: usagePriceId,
      features: ['Free delivery for orders over $30', 'Priority support', 'Exclusive deals'],
    },
  ];
};

const ensureStripeCustomer = async (user) => {
  if (user && user.stripeCustomerId) return user.stripeCustomerId;
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.username,
    metadata: { userId: String(user.id) },
  });
  await new Promise((resolve, reject) => {
    User.updateStripeCustomerId(user.id, customer.id, (err) =>
      err ? reject(err) : resolve()
    );
  });
  return customer.id;
};

const SubscriptionController = {
  plans: (req, res) => {
    const plans = buildPlans();
    res.render('subscriptionPlans', {
      user: req.session.user,
      plans,
      canceled: req.query.canceled === '1'
    });
  },

  createCheckoutSession: async (req, res) => {
    try {
      const stripe = getStripe();
      const userId = req.session.user?.id;
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const planId = req.body.priceId || '';
      const plans = buildPlans();
      const plan = plans.find((p) => p.priceId === planId);
      if (!plan || !plan.priceId) {
        return res.status(400).json({ success: false, message: 'Invalid plan selection' });
      }

      const user = await new Promise((resolve, reject) => {
        User.findById(userId, (err, row) => (err ? reject(err) : resolve(row)));
      });

      const stripeCustomerId = await ensureStripeCustomer(user);
      const baseUrl = `${req.protocol}://${req.get('host')}`;

      const lineItems = [
        { price: plan.priceId, quantity: 1 }
      ];
      if (plan.usagePriceId) {
        lineItems.push({ price: plan.usagePriceId, quantity: 1 });
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: stripeCustomerId,
        line_items: lineItems,
        success_url: `${baseUrl}/subscriptions/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/subscriptions/plans?canceled=1`,
        client_reference_id: String(userId),
        metadata: { userId: String(userId), planId: plan.id },
      });

      res.json({ success: true, url: session.url, sessionId: session.id });
    } catch (error) {
      console.error('Stripe checkout session error:', error);
      res.status(500).json({ success: false, message: 'Unable to create Stripe Checkout session.' });
    }
  },

  success: (req, res) => {
    res.render('subscriptionSuccess', { user: req.session.user });
  },

  manage: (req, res) => {
    const userId = req.session.user?.id;
    Subscription.getByUser(userId, (err, subscription) => {
      if (err) {
        console.error('Subscription manage error:', err);
        return res.render('subscriptionManage', { user: req.session.user, subscription: null, error: 'Unable to load subscription.' });
      }
      res.render('subscriptionManage', { user: req.session.user, subscription: subscription || null, error: null });
    });
  },

  cancel: async (req, res) => {
    try {
      const userId = req.session.user?.id;
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const subscription = await new Promise((resolve, reject) => {
        Subscription.getByUser(userId, (err, row) => (err ? reject(err) : resolve(row)));
      });
      if (!subscription) {
        return res.status(400).json({ success: false, message: 'No subscription found.' });
      }

      const stripe = getStripe();
      const updated = await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });

      await new Promise((resolve, reject) => {
        Subscription.updateStatusByStripeId(
          updated.id,
          updated.status,
          new Date(updated.current_period_start * 1000),
          new Date(updated.current_period_end * 1000),
          updated.cancel_at_period_end,
          (err) => (err ? reject(err) : resolve())
        );
      });

      res.json({ success: true, status: updated.status, cancelAtPeriodEnd: updated.cancel_at_period_end });
    } catch (error) {
      console.error('Stripe cancel subscription error:', error);
      res.status(500).json({ success: false, message: 'Unable to cancel subscription.' });
    }
  },

  recordUsage: async (req, res) => {
    try {
      const userId = req.session.user?.id;
      const { eventType, quantity } = req.body || {};
      const qty = parseInt(quantity, 10);
      if (!eventType || Number.isNaN(qty) || qty <= 0) {
        return res.status(400).json({ success: false, message: 'Invalid usage record input.' });
      }

      const subscription = await new Promise((resolve, reject) => {
        Subscription.getByUser(userId, (err, row) => (err ? reject(err) : resolve(row)));
      });
      if (!subscription || !subscription.stripeSubscriptionId) {
        return res.status(400).json({ success: false, message: 'No active subscription found.' });
      }

      const stripe = getStripe();
      const stripeSub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
      const usagePriceId = (process.env.STRIPE_PRICE_ZOZOPLUS_USAGE || '').trim();
      const item = stripeSub.items.data.find((i) => (usagePriceId ? i.price.id === usagePriceId : true));
      if (!item) {
        return res.status(400).json({ success: false, message: 'No metered subscription item configured.' });
      }

      // Stripe usage records require a metered price configuration.
      await stripe.subscriptionItems.createUsageRecord(item.id, {
        quantity: qty,
        timestamp: 'now',
        action: 'increment',
      });

      await new Promise((resolve, reject) => {
        UsageRecord.create(userId, item.id, qty, eventType, (err) => (err ? reject(err) : resolve()));
      });

      res.json({ success: true, subscriptionItemId: item.id });
    } catch (error) {
      console.error('Stripe usage record error:', error);
      res.status(500).json({ success: false, message: 'Unable to record usage.' });
    }
  },
};

module.exports = SubscriptionController;
