const Cart = require('../models/Cart');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const { getStripe } = require('../services/stripe');
const { buildCheckoutSnapshot } = require('../services/checkout');
const { finalizePaidOrder, finalizePaidOrderSystem, getOrderById, updateOrderStatus } = require('../services/orderFinalize');

const getCartByUser = (userId) =>
  new Promise((resolve, reject) =>
    Cart.getByUserId(userId, (err, cart) => (err ? reject(err) : resolve(cart || [])))
  );

const createOrderRecord = (payload) =>
  new Promise((resolve, reject) =>
    Order.create(payload, (err, orderId) => (err ? reject(err) : resolve(orderId)))
  );

const createOrderItems = (orderId, items) =>
  new Promise((resolve, reject) =>
    OrderItem.createMany(orderId, items, (err) => (err ? reject(err) : resolve()))
  );


const generatePickupCodeIfNeeded = (deliveryType) =>
  new Promise((resolve, reject) => {
    const isPickup = (deliveryType || '').toLowerCase() === 'pickup';
    if (!isPickup) return resolve(null);
    Order.generatePickupCode((err, code) => (err ? reject(err) : resolve(code)));
  });

const updateOrderPaymentIntent = (orderId, paymentIntentId) =>
  new Promise((resolve, reject) =>
    Order.updateStripePaymentIntent(orderId, paymentIntentId, (err) =>
      err ? reject(err) : resolve()
    )
  );

const toDate = (unix) => (unix ? new Date(unix * 1000) : null);

const handleStripeEvent = async (event) => {
  const stripe = getStripe();
  const type = event.type;
  console.log('[stripe] event', type, event.id);

  if (type === 'payment_intent.succeeded') {
    const intent = event && event.data ? event.data.object : null;
    const metadata = intent && intent.metadata ? intent.metadata : {};
    const orderId = metadata && metadata.orderId ? metadata.orderId : null;
    console.log('[stripe] payment_intent.succeeded', {
      id: intent ? intent.id : null,
      amount: intent ? intent.amount : null,
      metadata: metadata || {}
    });
    let order = null;
    if (orderId) {
      order = await getOrderById(parseInt(orderId, 10));
    }
    if (!order && intent && intent.id) {
      order = await new Promise((resolve, reject) => {
        Order.findByStripePaymentIntentId(intent.id, (err, row) =>
          err ? reject(err) : resolve(row)
        );
      });
    }
    if (!order) {
      console.log('[stripe] No order found for payment_intent.succeeded, skipping DB update');
      return;
    }
    await finalizePaidOrderSystem(order.id);
    return;
  }

  if (type === 'payment_intent.payment_failed') {
    const intent = event && event.data ? event.data.object : null;
    if (intent && intent.id) {
      await new Promise((resolve, reject) => {
        Order.updateStatusByStripePaymentIntentId(intent.id, 'payment failed', (err) =>
          err ? reject(err) : resolve()
        );
      });
    }
    return;
  }

  if (type === 'checkout.session.completed') {
    const session = event.data.object;
    if (!session || session.mode !== 'subscription') return;

    const userId = parseInt(session.client_reference_id, 10);
    const stripeCustomerId = session.customer;
    const stripeSubscriptionId = session.subscription;

    if (userId && stripeCustomerId) {
      await new Promise((resolve, reject) => {
        User.updateStripeCustomerId(userId, stripeCustomerId, (err) =>
          err ? reject(err) : resolve()
        );
      });
    }

    if (stripeSubscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
      const priceId = subscription.items?.data?.[0]?.price?.id || '';
      const payload = {
        userId: userId || null,
        stripeSubscriptionId,
        stripePriceId: priceId,
        stripeCustomerId: stripeCustomerId || subscription.customer,
        status: subscription.status,
        currentPeriodStart: toDate(subscription.current_period_start),
        currentPeriodEnd: toDate(subscription.current_period_end),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      };
      await new Promise((resolve, reject) => {
        Subscription.upsertFromStripe(payload, (err) => (err ? reject(err) : resolve()));
      });
    }
    return;
  }

  if (
    type === 'customer.subscription.created' ||
    type === 'customer.subscription.updated' ||
    type === 'customer.subscription.deleted'
  ) {
    const sub = event.data.object;
    if (!sub) return;
    const stripeCustomerId = sub.customer;
    const user = await new Promise((resolve, reject) => {
      User.findByStripeCustomerId(stripeCustomerId, (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    const userId = user ? user.id : null;
    const priceId = sub.items?.data?.[0]?.price?.id || '';
    const payload = {
      userId: userId || null,
      stripeSubscriptionId: sub.id,
      stripePriceId: priceId,
      stripeCustomerId,
      status: sub.status,
      currentPeriodStart: toDate(sub.current_period_start),
      currentPeriodEnd: toDate(sub.current_period_end),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    };
    await new Promise((resolve, reject) => {
      Subscription.upsertFromStripe(payload, (err) => (err ? reject(err) : resolve()));
    });
    return;
  }

  if (type === 'invoice.paid' || type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    if (!invoice || !invoice.subscription) return;
    const status = type === 'invoice.paid' ? 'active' : 'past_due';
    let sub = null;
    try {
      sub = await stripe.subscriptions.retrieve(invoice.subscription);
    } catch (err) {
      sub = null;
    }
    const periodStart = sub ? toDate(sub.current_period_start) : null;
    const periodEnd = sub ? toDate(sub.current_period_end) : null;
    const cancelAtPeriodEnd = sub ? sub.cancel_at_period_end : 0;
    await new Promise((resolve, reject) => {
      Subscription.updateStatusByStripeId(invoice.subscription, status, periodStart, periodEnd, cancelAtPeriodEnd, (err) =>
        err ? reject(err) : resolve()
      );
    });
  }
};

const StripeController = {
  createIntent: async (req, res) => {
    try {
      const stripe = getStripe();
      const userId = req.session.user?.id;
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const requestedOrderId = parseInt(req.body?.orderId, 10);
      const cart = await getCartByUser(userId);
      if (!cart.length) {
        return res.status(400).json({ success: false, message: 'Your cart is empty' });
      }

      const snapshot = buildCheckoutSnapshot(req, cart, 'stripe');
      if (!snapshot.cartForOrder.length) {
        return res.status(400).json({ success: false, message: 'No items selected for checkout' });
      }

      let order = null;
      if (!Number.isNaN(requestedOrderId)) {
        const existing = await getOrderById(requestedOrderId);
        const statusLower = (existing?.status || '').toLowerCase();
        const totalMatch = existing && Number(existing.total || 0).toFixed(2) === Number(snapshot.total || 0).toFixed(2);
        const methodMatch = existing && (existing.paymentMethod || '').toLowerCase() === 'stripe';
        if (!existing || existing.userId !== userId) {
          return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (existing && statusLower === 'pending_payment' && totalMatch && methodMatch) {
          order = existing;
        }
      }

      const amount = Math.round(snapshot.total * 100);
      const user = await new Promise((resolve, reject) => {
        User.findById(userId, (err, row) => (err ? reject(err) : resolve(row)));
      });

      if (!order) {
        const pickupCode = await generatePickupCodeIfNeeded(snapshot.shipping.option);
        const orderPayload = {
          userId,
          total: snapshot.total,
          paymentMethod: 'stripe',
          paymentProvider: 'stripe',
          stripePaymentIntentId: null,
          deliveryType: snapshot.shipping.option,
          address: snapshot.shipping.address || req.session.user?.address,
          pickupCode,
          pickupCodeStatus: pickupCode ? 'active' : null,
          pickupCodeRedeemedAt: null,
          status: 'pending_payment',
        };
        const orderId = await createOrderRecord(orderPayload);
        await createOrderItems(orderId, snapshot.cartForOrder);
        order = await getOrderById(orderId);
      }

      const statusLower = (order.status || '').toLowerCase();
      if (statusLower === 'payment successful') {
        return res.json({ success: true, orderId: order.id, alreadyPaid: true });
      }

      if (order.stripePaymentIntentId) {
        const existingIntent = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
        if (existingIntent && existingIntent.client_secret) {
          return res.json({
            success: true,
            paymentIntentId: existingIntent.id,
            clientSecret: existingIntent.client_secret,
            orderId: order.id,
            amount: order.total,
            reused: true,
          });
        }
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(order.total * 100),
        currency: 'sgd',
        customer: user && user.stripeCustomerId ? user.stripeCustomerId : undefined,
        metadata: {
          userId: String(userId),
          orderId: String(order.id),
          source: 'zozomart',
        },
      }, {
        idempotencyKey: `stripe-${order.id}`,
      });

      await updateOrderPaymentIntent(order.id, paymentIntent.id);
      req.session.pendingStripeOrder = {
        orderId: order.id,
        selection: snapshot.selection,
        shipping: snapshot.shipping,
        total: snapshot.total,
      };

      console.log('[stripe] intent created', {
        paymentIntentId: paymentIntent.id,
        hasClientSecret: !!paymentIntent.client_secret,
        orderId: order.id,
      });

      res.json({
        success: true,
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        orderId: order.id,
        amount: order.total,
      });
    } catch (error) {
      console.error('Stripe create intent error:', error?.code || error?.message || error);
      res.status(500).json({ success: false, message: 'Unable to create Stripe payment intent.' });
    }
  },

  confirmPayment: async (req, res) => {
    try {
      const stripe = getStripe();
      const { paymentIntentId, orderId } = req.body || {};
      if (!paymentIntentId) {
        return res.status(400).json({ success: false, message: 'Missing paymentIntentId' });
      }

      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (!intent || intent.status !== 'succeeded') {
        let order = null;
        try {
          order = await new Promise((resolve, reject) => {
            Order.findByStripePaymentIntentId(paymentIntentId, (err, row) =>
              err ? reject(err) : resolve(row)
            );
          });
        } catch (e) {
          order = null;
        }
        if (order) {
          await updateOrderStatus(order.id, 'payment failed');
        }
        console.error('[stripe] confirm failed', {
          paymentIntentId,
          status: intent ? intent.status : null,
          lastError: intent && intent.last_payment_error ? intent.last_payment_error.code : null,
        });
        return res.status(400).json({
          success: false,
          message: 'Payment not completed yet.',
          status: intent ? intent.status : null,
        });
      }

      let order = null;
      if (orderId) {
        order = await getOrderById(parseInt(orderId, 10));
      }
      if (!order) {
        order = await new Promise((resolve, reject) => {
          Order.findByStripePaymentIntentId(paymentIntentId, (err, row) =>
            err ? reject(err) : resolve(row)
          );
        });
      }
      if (!order) {
        return res.status(400).json({ success: false, message: 'Order not found for this payment.' });
      }
      if (order.userId !== req.session.user.id) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }

      const expectedAmount = Math.round(Number(order.total || 0) * 100);
      const receivedAmount = intent && typeof intent.amount_received === 'number' ? intent.amount_received : null;
      if (receivedAmount !== null && receivedAmount !== expectedAmount) {
        await updateOrderStatus(order.id, 'payment failed');
        return res.status(400).json({ success: false, message: 'Stripe payment amount mismatch.' });
      }

      await updateOrderPaymentIntent(order.id, paymentIntentId);
      await finalizePaidOrder(req, order.id);
      req.session.pendingStripeOrder = null;
      res.json({ success: true, orderId: order.id, redirect: `/orders/${order.id}` });
    } catch (error) {
      console.error('Stripe confirm payment error:', error?.code || error?.message || error);
      res.status(500).json({ success: false, message: 'Unable to confirm Stripe payment.' });
    }
  },

  devConfirmIntent: async (req, res) => {
    try {
      const stripe = getStripe();
      const { paymentIntentId } = req.body || {};
      if (!paymentIntentId) {
        return res.status(400).json({ success: false, message: 'Missing paymentIntentId' });
      }

      let intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (intent && intent.status !== 'succeeded') {
        intent = await stripe.paymentIntents.confirm(paymentIntentId, {
          payment_method: 'pm_card_visa',
        });
      }

      if (!intent || intent.status !== 'succeeded') {
        return res.status(400).json({ success: false, message: 'Stripe test confirmation failed.' });
      }

      const order = await new Promise((resolve, reject) => {
        Order.findByStripePaymentIntentId(paymentIntentId, (err, row) =>
          err ? reject(err) : resolve(row)
        );
      });
      if (order) {
        await finalizePaidOrder(req, order.id);
        return res.json({ success: true, orderId: order.id, status: intent.status, redirect: `/orders/success?id=${order.id}` });
      }
      const orderId = await createOrderRecord({
        userId: req.session.user?.id,
        total: 0,
        paymentMethod: 'stripe',
        paymentProvider: 'stripe',
        stripePaymentIntentId: paymentIntentId,
        deliveryType: 'pickup',
        address: '',
        status: 'payment successful',
      });
      res.json({ success: true, orderId, status: intent.status, redirect: `/orders/success?id=${orderId}` });
    } catch (error) {
      console.error('Stripe dev confirm error:', error);
      res.status(500).json({ success: false, message: 'Unable to run Stripe dev confirm.' });
    }
  },

  webhook: async (req, res) => {
    const stripe = getStripe();
    const signature = req.headers['stripe-signature'];
    const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!secret) {
      return res.status(500).send('Stripe webhook secret not configured');
    }
    let event = null;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, secret);
    } catch (error) {
      console.error('Stripe webhook signature verification failed:', error.message || error);
      return res.status(400).send(`Webhook Error: ${error.message || 'Invalid signature'}`);
    }
    try {
      await handleStripeEvent(event);
    } catch (error) {
      console.error('Stripe webhook handler error:', error.message || error);
      // Do not fail the webhook after signature verification.
    }
    return res.json({ received: true });
  },

  devSimulateWebhook: async (req, res) => {
    try {
      const {
        type,
        eventType,
        stripeSubscriptionId,
        subscriptionId,
        stripeCustomerId,
        status,
        priceId,
      } = req.body || {};
      const resolvedType = eventType || type;
      const resolvedSubId = stripeSubscriptionId || subscriptionId;
      if (!resolvedType) return res.status(400).json({ success: false, message: 'Missing eventType' });

      const fakeEvent = {
        type: resolvedType,
        data: {
          object: {
            id: resolvedSubId || 'sub_test',
            customer: stripeCustomerId || 'cus_test',
            status: status || 'active',
            items: { data: [{ price: { id: priceId || 'price_test' } }] },
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            cancel_at_period_end: false,
            subscription: resolvedSubId || 'sub_test',
            mode: resolvedType === 'checkout.session.completed' ? 'subscription' : undefined,
            client_reference_id: req.session.user?.id ? String(req.session.user.id) : '1',
          },
        },
      };

      await handleStripeEvent(fakeEvent);
      res.json({ success: true });
    } catch (error) {
      console.error('Stripe dev webhook simulate error:', error);
      res.status(500).json({ success: false, message: 'Unable to simulate webhook' });
    }
  },
};

module.exports = StripeController;
