const User = require('../models/User');
const UserSubscription = require('../models/UserSubscription');
const { getStripe } = require('../services/stripe');

const buildPlans = () => {
  const monthlyPriceId = (process.env.STRIPE_PRICE_ZOZOPLUS || '').trim();
  return [
    {
      id: 'zozoplus_monthly',
      name: 'ZozoPlus Membership',
      description: 'Monthly subscription with free delivery',
      priceLabel: 'S$9.90 / month',
      priceId: monthlyPriceId,
      features: ['Free delivery on all orders'],
    },
  ];
};

const addOneMonth = (dateLike) => {
  if (!dateLike) return null;
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  const next = new Date(d);
  next.setMonth(next.getMonth() + 1);
  return next;
};

const computeFallbackPeriodEnd = (subscription, user) => {
  if (subscription?.currentPeriodEnd) return subscription.currentPeriodEnd;
  const baseDate = subscription?.createdAt || user?.zozoPlusActivatedAt;
  return addOneMonth(baseDate);
};

const computeDisplayPeriodEnd = (subscription, user) => {
  if (user?.zozoPlusActivatedAt) {
    return addOneMonth(user.zozoPlusActivatedAt);
  }
  return computeFallbackPeriodEnd(subscription, user);
};

const cancelStripeSubscription = async (stripe, subscriptionId) => {
  if (stripe?.subscriptions?.cancel) {
    return stripe.subscriptions.cancel(subscriptionId);
  }
  if (stripe?.subscriptions?.del) {
    return stripe.subscriptions.del(subscriptionId);
  }
  if (stripe?.subscriptions?.update) {
    // Fallback: schedule cancellation if immediate cancel isn't available.
    return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  }
  throw new Error('Stripe subscription cancel not supported by SDK');
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
    const params = [];
    if (req.query.cancelled === '1' || req.query.canceled === '1') params.push('canceled=1');
    if (req.query.error) params.push(`error=${encodeURIComponent(req.query.error)}`);
    const suffix = params.length ? `?${params.join('&')}` : '';
    return res.redirect(`/subscriptions${suffix}`);
  },

  createCheckoutSession: async (req, res) => {
    try {
      const userId = req.session.user?.id;
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const missingEnv = [];
      if (!process.env.STRIPE_SECRET_KEY) missingEnv.push('STRIPE_SECRET_KEY');
      if (!process.env.STRIPE_PRICE_ZOZOPLUS) missingEnv.push('STRIPE_PRICE_ZOZOPLUS');
      if (missingEnv.length) {
        const plans = buildPlans();
        const msg = `Missing ${missingEnv.join(', ')} in .env`;
        if (req.flash) req.flash('error', msg);
        return res.redirect('/subscriptions?error=missing_env');
      }

      const stripe = getStripe();
      const planId = (process.env.STRIPE_PRICE_ZOZOPLUS || '').trim();
      if (!planId.startsWith('price_')) {
        const msg = 'Invalid STRIPE_PRICE_ZOZOPLUS. It must start with price_.';
        console.error('[zozoplus] invalid price id', planId);
        if (req.flash) req.flash('error', msg);
        return res.redirect('/subscriptions?error=invalid_price');
      }
      const plans = buildPlans();
      const plan = plans.find((p) => p.priceId === planId);
      if (!plan || !plan.priceId) {
        const msg = 'ZozoPlus price not configured';
        if (req.flash) req.flash('error', msg);
        return res.redirect('/subscriptions?error=price_missing');
      }

      console.log(`ZozoPlus checkout: userId=${userId}, priceId=${plan.priceId}`);

      const user = await new Promise((resolve, reject) => {
        User.findById(userId, (err, row) => (err ? reject(err) : resolve(row)));
      });
      if (user && (user.zozoPlusStatus || '').toLowerCase() === 'active') {
        return res.redirect('/subscriptions/plans');
      }

      const stripeCustomerId = await ensureStripeCustomer(user);
      const baseUrl = 'http://localhost:3000';

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: stripeCustomerId,
        line_items: [{ price: plan.priceId, quantity: 1 }],
        success_url: `${baseUrl}/subscriptions/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/subscriptions?canceled=1`,
        client_reference_id: String(userId),
        metadata: { userId: String(userId), planId: plan.id },
      });
      return res.redirect(session.url);
    } catch (error) {
      console.error('Stripe checkout session error:', error);
      const msg = 'Unable to create Stripe Checkout session. Please try again.';
      if (req.flash) req.flash('error', msg);
      res.redirect('/subscriptions?error=session_failed');
    }
  },

  success: async (req, res) => {
    try {
      const userId = req.session.user?.id;
      if (!userId) return res.redirect('/login');
      const sessionId = req.query.session_id;
      if (!sessionId) return res.redirect('/subscriptions/plans');
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
      if (!session || session.mode !== 'subscription') {
        return res.redirect('/subscriptions/plans');
      }
      const subscription = session.subscription;
      const stripeCustomerId = session.customer;
      const stripeSubscriptionId = subscription?.id || session.subscription;
      const status = subscription?.status || 'active';
      const priceId = subscription?.items?.data?.[0]?.price?.id || null;
      const currentPeriodEnd = subscription?.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null;

      await new Promise((resolve, reject) => {
        UserSubscription.upsertFromStripe(
          {
            userId,
            stripeCustomerId,
            stripeSubscriptionId,
            status,
            priceId,
            currentPeriodEnd,
          },
          (err) => (err ? reject(err) : resolve())
        );
      });

      const mappedStatus =
        status === 'active' || status === 'trialing'
          ? 'active'
          : status === 'past_due'
          ? 'payment_failed'
          : 'inactive';
      await new Promise((resolve, reject) => {
        if (mappedStatus === 'active') {
          return User.setZozoPlusActive(userId, stripeCustomerId, stripeSubscriptionId, currentPeriodEnd, (err) =>
            err ? reject(err) : resolve()
          );
        }
        return User.setZozoPlusStatusByCustomerId(stripeCustomerId, mappedStatus, currentPeriodEnd, (err) =>
          err ? reject(err) : resolve()
        );
      });
      if (req.session.user) {
        req.session.user.zozoPlusStatus = mappedStatus === 'active' ? 'active' : req.session.user.zozoPlusStatus;
        req.session.user.stripeCustomerId = stripeCustomerId || req.session.user.stripeCustomerId;
        req.session.user.stripeMembershipSubscriptionId = stripeSubscriptionId || req.session.user.stripeMembershipSubscriptionId;
        req.session.user.zozoPlusCurrentPeriodEnd = currentPeriodEnd;
      }

      return res.redirect('/subscriptions?success=1');
    } catch (error) {
      console.error('Stripe subscription success error:', error);
      return res.redirect('/subscriptions/plans?cancelled=1');
    }
  },

  status: (req, res) => {
    const userId = req.session.user?.id;
    if (!userId) return res.redirect('/login');
    const plans = buildPlans();
    User.findById(userId, (userErr, freshUser) => {
      if (!userErr && freshUser) {
        req.session.user = { ...req.session.user, ...freshUser };
      }
      UserSubscription.findByUserId(userId, (err, sub) => {
        if (err) {
          console.error('Subscription status error:', err);
          return res.render('subscriptionStatus', {
            user: req.session.user,
            subscription: null,
            success: false,
            plans,
            error: req.query.error || null,
            canceled: req.query.canceled === '1',
            canceledMembership: req.query.canceledMembership === '1',
          });
        }
        if (sub) {
          sub.currentPeriodEnd = computeDisplayPeriodEnd(sub, req.session.user);
        }
        res.render('subscriptionStatus', {
          user: req.session.user,
          subscription: sub,
          success: req.query.success === '1',
          plans,
          error: req.query.error || null,
          canceled: req.query.canceled === '1',
          canceledMembership: req.query.canceledMembership === '1',
        });
      });
    });
  },

  me: (req, res) => {
    const userId = req.session.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    User.findById(userId, (userErr, freshUser) => {
      if (!userErr && freshUser) {
        req.session.user = { ...req.session.user, ...freshUser };
      }
      UserSubscription.findByUserId(userId, (err, sub) => {
        if (err) return res.status(500).json({ success: false, message: 'Unable to load subscription' });
        const fallbackEnd = computeDisplayPeriodEnd(sub, req.session.user);
        res.json({
          success: true,
          status: (sub?.status || req.session.user?.zozoPlusStatus || 'inactive'),
          planName: 'ZozoPlus Membership',
          currentPeriodEnd:
            sub?.currentPeriodEnd ||
            fallbackEnd ||
            req.session.user?.zozoPlusCurrentPeriodEnd ||
            null,
        });
      });
    });
  },

  cancel: async (req, res) => {
    try {
      const userId = req.session.user?.id;
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const stripe = getStripe();
      const user = await new Promise((resolve, reject) => {
        User.findById(userId, (err, row) => (err ? reject(err) : resolve(row)));
      });
      let subscriptionId = user?.stripeMembershipSubscriptionId;
      let fallbackSubRow = null;
      if (!subscriptionId) {
        const subRow = await new Promise((resolve, reject) => {
          UserSubscription.findByUserId(userId, (err, row) => (err ? reject(err) : resolve(row)));
        });
        fallbackSubRow = subRow || null;
        subscriptionId = subRow?.stripeSubscriptionId || null;
      }

      if (!subscriptionId) {
        console.warn('ZozoPlus cancel: no active subscription found', { userId });
        await new Promise((resolve, reject) => {
          User.setZozoPlusStatusByCustomerId(user?.stripeCustomerId || '', 'inactive', null, (err) =>
            err ? reject(err) : resolve()
          );
        }).catch(() => {});
        if (fallbackSubRow?.stripeSubscriptionId) {
          await new Promise((resolve, reject) => {
            UserSubscription.updateStatusBySubscriptionId(
              fallbackSubRow.stripeSubscriptionId,
              'inactive',
              null,
              (err) => (err ? reject(err) : resolve())
            );
          }).catch(() => {});
        }
        if (req.session.user) {
          req.session.user.zozoPlusStatus = 'inactive';
          req.session.user.stripeMembershipSubscriptionId = null;
        }
        return res.redirect('/subscriptions?canceledMembership=1');
      }

      try {
        await cancelStripeSubscription(stripe, subscriptionId);
      } catch (stripeErr) {
        console.error('Stripe cancel subscription error:', stripeErr);
        // Continue to mark inactive locally for immediate UX.
      }
      await new Promise((resolve, reject) => {
        User.setZozoPlusStatusBySubscriptionId(subscriptionId, 'inactive', null, (err) =>
          err ? reject(err) : resolve()
        );
      });
      await new Promise((resolve, reject) => {
        UserSubscription.updateStatusBySubscriptionId(subscriptionId, 'inactive', null, (err) =>
          err ? reject(err) : resolve()
        );
      }).catch(() => {});
      console.log('ZozoPlus unsubscribed', { userId, subscriptionId });
      if (req.session.user) {
        req.session.user.zozoPlusStatus = 'inactive';
        req.session.user.stripeMembershipSubscriptionId = null;
      }
      res.redirect('/subscriptions?canceledMembership=1');
    } catch (error) {
      console.error('Stripe cancel subscription error:', error);
      // Do not block UX with error; ensure user sees unsubscribe confirmation.
      if (req.session?.user) {
        req.session.user.zozoPlusStatus = 'inactive';
        req.session.user.stripeMembershipSubscriptionId = null;
      }
      res.redirect('/subscriptions?canceledMembership=1');
    }
  },
};

module.exports = SubscriptionController;
