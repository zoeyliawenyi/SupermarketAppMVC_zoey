const Cart = require('../models/Cart');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const User = require('../models/User');
const UserSubscription = require('../models/UserSubscription');
const { getStripe } = require('../services/stripe');
const { buildCheckoutSnapshot } = require('../services/checkout');
const { finalizePaidOrder, finalizePaidOrderSystem, getOrderById, updateOrderStatus } = require('../services/orderFinalize');
const { normalizeStatus, isPaidStatus, isCancelledStatus } = require('../utils/status');

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

const clearCartItems = (userId, productIds) =>
  new Promise((resolve, reject) =>
    Cart.clearItems(userId, productIds, (err) => (err ? reject(err) : resolve()))
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

const processedStripeEvents = new Set();
const isDuplicateEvent = (eventId) => {
  if (!eventId) return false;
  if (processedStripeEvents.has(eventId)) return true;
  processedStripeEvents.add(eventId);
  if (processedStripeEvents.size > 500) {
    const first = processedStripeEvents.values().next().value;
    processedStripeEvents.delete(first);
  }
  return false;
};

const isTerminalSuccessStatus = (statusKey = '') =>
  isCancelledStatus(statusKey) ||
  isPaidStatus(statusKey) ||
  ['refund_requested', 'refund_completed'].includes(statusKey);

const mapStripeSubStatus = (status) => {
  const normalized = (status || '').toLowerCase();
  if (['active', 'trialing'].includes(normalized)) return 'active';
  if (['past_due', 'unpaid'].includes(normalized)) return 'payment_failed';
  return 'inactive';
};

const normalizeSubscriptionStatus = (status) => (status || 'inactive');

const upsertSubscriptionRecord = (userId, customerId, subscriptionId, status, priceId, periodEnd) =>
  new Promise((resolve, reject) => {
    UserSubscription.upsertFromStripe(
      {
        userId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        status: normalizeSubscriptionStatus(status),
        priceId,
        currentPeriodEnd: periodEnd,
      },
      (err) => (err ? reject(err) : resolve())
    );
  });

const updateZozoPlusByCustomerOrSubscription = async (customerId, subscriptionId, status, currentPeriodEnd) => {
  if (subscriptionId) {
    return new Promise((resolve, reject) => {
      User.setZozoPlusStatusBySubscriptionId(subscriptionId, status, currentPeriodEnd, (err) =>
        err ? reject(err) : resolve()
      );
    });
  }
  if (customerId) {
    return new Promise((resolve, reject) => {
      User.setZozoPlusStatusByCustomerId(customerId, status, currentPeriodEnd, (err) =>
        err ? reject(err) : resolve()
      );
    });
  }
};

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
    const intentId = intent && intent.id ? intent.id : null;
    if (!intentId) return;

    let order = await new Promise((resolve, reject) => {
      Order.findByStripePaymentIntentId(intentId, (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!order) {
      const metadata = intent && intent.metadata ? intent.metadata : {};
      const orderId = metadata && metadata.orderId ? parseInt(metadata.orderId, 10) : null;
      if (orderId) {
        order = await getOrderById(orderId);
      }
    }
    if (!order) {
      console.log('[stripe] payment_intent.payment_failed no order found', { intentId });
      return;
    }
    const currentStatus = normalizeStatus(order.status || '');
    const blocked = isTerminalSuccessStatus(currentStatus);
    console.log('[stripe] payment_intent.payment_failed', {
      orderId: order.id,
      currentStatus,
      attempted: 'payment_failed',
      blocked
    });
    if (blocked) return;
    await new Promise((resolve, reject) => {
      Order.updateStatusByStripePaymentIntentId(intentId, 'payment_failed', (err) =>
        err ? reject(err) : resolve()
      );
    });
    return;
  }

  if (type === 'checkout.session.completed') {
    const session = event.data.object;
    if (!session || session.mode !== 'subscription') return;

    const userId = parseInt(session.client_reference_id || session.metadata?.userId, 10);
    const stripeCustomerId = session.customer;
    const stripeSubscriptionId = session.subscription;
    let periodEnd = null;
    let subStatus = 'active';
    let priceId = null;
    if (stripeSubscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
        periodEnd = toDate(sub.current_period_end);
        subStatus = sub.status || 'active';
        priceId = sub.items?.data?.[0]?.price?.id || null;
      } catch (err) {
        console.error('[stripe] subscription retrieve failed', err?.message || err);
      }
    }

    if (userId && stripeCustomerId) {
      await upsertSubscriptionRecord(userId, stripeCustomerId, stripeSubscriptionId, subStatus, priceId, periodEnd);
      await new Promise((resolve, reject) => {
        User.setZozoPlusActive(userId, stripeCustomerId, stripeSubscriptionId, periodEnd, (err) =>
          err ? reject(err) : resolve()
        );
      });
      console.log('[stripe] zozoplus active', { userId, stripeCustomerId, stripeSubscriptionId });
    }
    return;
  }

  if (
    type === 'customer.subscription.created' ||
    type === 'customer.subscription.updated'
  ) {
    const sub = event.data.object;
    if (!sub) return;
    const status = sub.status || 'active';
    const periodEnd = toDate(sub.current_period_end);
    const priceId = sub.items?.data?.[0]?.price?.id || null;
    if (sub.metadata?.userId) {
      const userId = parseInt(sub.metadata.userId, 10);
      if (!Number.isNaN(userId)) {
        await upsertSubscriptionRecord(userId, sub.customer, sub.id, status, priceId, periodEnd);
      }
    } else {
      const subRow = await new Promise((resolve, reject) => {
        UserSubscription.findByStripeSubscriptionId(sub.id, (err, row) =>
          err ? reject(err) : resolve(row)
        );
      });
      if (subRow?.userId) {
        await upsertSubscriptionRecord(subRow.userId, sub.customer, sub.id, status, priceId, periodEnd);
      }
    }
    await updateZozoPlusByCustomerOrSubscription(sub.customer, sub.id, status, periodEnd);
    console.log('[stripe] zozoplus update', { customer: sub.customer, subscription: sub.id, status });
    return;
  }

  if (type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    if (!sub) return;
    const periodEnd = toDate(sub.current_period_end);
    const priceId = sub.items?.data?.[0]?.price?.id || null;
    const subRow = await new Promise((resolve, reject) => {
      UserSubscription.findByStripeSubscriptionId(sub.id, (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (subRow?.userId) {
      await upsertSubscriptionRecord(subRow.userId, sub.customer, sub.id, 'canceled', priceId, periodEnd);
    }
    await updateZozoPlusByCustomerOrSubscription(sub.customer, sub.id, 'inactive', periodEnd);
    console.log('[stripe] zozoplus inactive', { customer: sub.customer, subscription: sub.id });
    return;
  }

  if (type === 'invoice.paid' || type === 'invoice.payment_failed' || type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    if (!invoice) return;
    const status = (type === 'invoice.paid' || type === 'invoice.payment_succeeded') ? 'active' : 'past_due';
    const periodEnd = toDate(invoice.lines?.data?.[0]?.period?.end);
    if (invoice.subscription) {
      await new Promise((resolve, reject) => {
        UserSubscription.updateStatusBySubscriptionId(invoice.subscription, status, periodEnd, (err) =>
          err ? reject(err) : resolve()
        );
      });
    }
    await updateZozoPlusByCustomerOrSubscription(invoice.customer, invoice.subscription, status, periodEnd);
    console.log('[stripe] zozoplus invoice', { customer: invoice.customer, subscription: invoice.subscription, status });
  }
};

const StripeController = {
  createIntent: async (req, res) => {
    try {
      const stripe = getStripe();
      const userId = req.session.user?.id;
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
      const user = await new Promise((resolve, reject) => {
        User.findById(userId, (err, row) => (err ? reject(err) : resolve(row)));
      });
      if (user) {
        req.session.user = { ...req.session.user, ...user };
      }

      if (req.session.pendingStripeOrder?.orderId) {
        const pending = await getOrderById(req.session.pendingStripeOrder.orderId);
        const pendingStatus = normalizeStatus(pending?.status || '');
        if (pendingStatus === 'payment_failed') {
          req.session.pendingStripeOrder = null;
        }
      }

      const requestedOrderId = parseInt(req.body?.orderId, 10);
      let order = null;
      if (!Number.isNaN(requestedOrderId)) {
        const existing = await getOrderById(requestedOrderId);
        const statusLower = normalizeStatus(existing?.status || '');
        const methodMatch = existing && (existing.paymentMethod || '').toLowerCase() === 'stripe';
        const isRetryStatus = statusLower === 'pending_payment' || statusLower === 'payment_failed';
        if (!existing || existing.userId !== userId) {
          return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!methodMatch || !isRetryStatus) {
          return res.status(400).json({ success: false, message: 'Order not eligible for Stripe retry' });
        }
        order = existing;
      }

      let snapshot = null;
      if (!order) {
        const cart = await getCartByUser(userId);
        if (!cart.length) {
          return res.status(400).json({ success: false, message: 'Your cart is empty' });
        }

        snapshot = buildCheckoutSnapshot(req, cart, 'stripe');
        if (!snapshot.cartForOrder.length) {
          return res.status(400).json({ success: false, message: 'No items selected for checkout' });
        }
      }

    if (!order) {
      const snapshotForOrder = {
        ...snapshot,
        shipping: {
          ...snapshot.shipping,
          address: snapshot.shipping.address || req.session.user?.address
        }
      };
      const orderId = await new Promise((resolve, reject) => {
        Order.createPendingStripeOrder(userId, snapshotForOrder, (err, id) =>
          err ? reject(err) : resolve(id)
        );
      });
      order = await getOrderById(orderId);
    }

      const statusLower = normalizeStatus(order.status || '');
      if (statusLower === 'payment_successful') {
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
        selection: snapshot ? snapshot.selection : null,
        shipping: snapshot ? snapshot.shipping : null,
        total: snapshot ? snapshot.total : order.total,
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
          await updateOrderStatus(order.id, 'payment_failed');
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
        await updateOrderStatus(order.id, 'payment_failed');
        return res.status(400).json({ success: false, message: 'Stripe payment amount mismatch.' });
      }

      await updateOrderPaymentIntent(order.id, paymentIntentId);
      await finalizePaidOrder(req, order.id);
      req.session.pendingStripeOrder = null;
      res.json({ success: true, orderId: order.id, redirect: `/orders/success?id=${order.id}` });
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
        status: 'payment_successful',
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
    if (isDuplicateEvent(event.id)) {
      console.log('[stripe] duplicate webhook ignored', { eventId: event.id, type: event.type });
      return res.json({ received: true, duplicate: true });
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
