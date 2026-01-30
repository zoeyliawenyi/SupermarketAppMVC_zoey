const Cart = require('../models/Cart');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const db = require('../db');
const paypalService = require('../services/paypal');
const { buildCheckoutSnapshot } = require('../services/checkout');
const { finalizePaidOrder, getOrderById, updateOrderStatus } = require('../services/orderFinalize');

const getCartByUser = (userId) =>
  new Promise((resolve, reject) =>
    Cart.getByUserId(userId, (err, cart) => (err ? reject(err) : resolve(cart || [])))
  );

const generatePickupCodeIfNeeded = (deliveryType) =>
  new Promise((resolve, reject) => {
    const isPickup = (deliveryType || '').toLowerCase() === 'pickup';
    if (!isPickup) return resolve(null);
    Order.generatePickupCode((err, code) => (err ? reject(err) : resolve(code)));
  });

const createPendingOrder = async (req, snapshot) => {
  const userId = req.session.user?.id;
  if (!userId) throw new Error('Missing session user');
  const pickupCode = await generatePickupCodeIfNeeded(snapshot.shipping.option);

  return new Promise((resolve, reject) => {
    db.beginTransaction((txErr) => {
      if (txErr) return reject(txErr);
      const payload = {
        userId,
        total: snapshot.total,
        paymentMethod: 'paypal',
        paymentProvider: 'paypal',
        deliveryType: snapshot.shipping.option,
        address: snapshot.shipping.address || req.session.user?.address,
        pickupCode,
        pickupCodeStatus: pickupCode ? 'active' : null,
        pickupCodeRedeemedAt: null,
        status: 'pending_payment',
      };
      Order.create(payload, (orderErr, orderId) => {
        if (orderErr) {
          return db.rollback(() => reject(orderErr));
        }
        OrderItem.createMany(orderId, snapshot.cartForOrder, (itemErr) => {
          if (itemErr) {
            return db.rollback(() => reject(itemErr));
          }
          db.commit((commitErr) => {
            if (commitErr) return db.rollback(() => reject(commitErr));
            resolve(orderId);
          });
        });
      });
    });
  });
};

const PayPalController = {
  capturePayPalOrder: async (req, orderID) => {
    const userId = req.session.user?.id;
    if (!userId) return { success: false, status: 401, message: 'Unauthorized' };
    if (!orderID) return { success: false, status: 400, message: 'Missing orderID' };

    let order = await new Promise((resolve, reject) => {
      Order.findByPayPalOrderId(orderID, (err, row) => (err ? reject(err) : resolve(row)));
    });
    if (!order && req.session.pendingPaypalOrderId) {
      order = await getOrderById(req.session.pendingPaypalOrderId);
    }
    if (!order) {
      return { success: false, status: 400, message: 'Order not found for this PayPal order.' };
    }
    if (order.userId !== userId) {
      return { success: false, status: 403, message: 'Access denied.' };
    }
    const statusLower = (order.status || '').toLowerCase();
    if (statusLower === 'payment successful') {
      return { success: true, orderId: order.id };
    }

    const captureResult = await paypalService.captureOrder(orderID);
    const captureStatus =
      captureResult?.status ||
      captureResult?.purchase_units?.[0]?.payments?.captures?.[0]?.status ||
      '';
    const success =
      typeof captureStatus === 'string' && captureStatus.toUpperCase() === 'COMPLETED';

    if (!success) {
      await updateOrderStatus(order.id, 'payment failed');
      return {
        success: false,
        status: 400,
        message: 'PayPal payment was not completed.',
        detail: captureStatus,
      };
    }

    const captureId =
      captureResult?.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;
    const captureAmount =
      captureResult?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || null;
    if (captureAmount && Number(captureAmount).toFixed(2) !== Number(order.total || 0).toFixed(2)) {
      await updateOrderStatus(order.id, 'payment failed');
      return { success: false, status: 400, message: 'PayPal capture amount mismatch.' };
    }
    await new Promise((resolve, reject) => {
      Order.updatePayPalRefs(order.id, orderID, captureId, (err) =>
        err ? reject(err) : resolve()
      );
    });

    await finalizePaidOrder(req, order.id);
    req.session.pendingPaypalOrderId = null;
    req.session.pendingPaypalOrder = null;
    console.log('[paypal] capture completed', { orderId: order.id, paypalOrderId: orderID });
    return { success: true, orderId: order.id };
  },

  createOrder: async (req, res) => {
    try {
      const userId = req.session.user?.id;
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const cart = await getCartByUser(userId);
      if (!cart.length) {
        return res.status(400).json({ success: false, message: 'Your cart is empty' });
      }

      const snapshot = buildCheckoutSnapshot(req, cart, 'paypal');
      if (!snapshot.cartForOrder.length) {
        return res.status(400).json({ success: false, message: 'No items selected for checkout' });
      }

      let orderId = req.session.pendingPaypalOrderId || null;
      let order = null;
      if (orderId) {
        order = await getOrderById(orderId);
        const statusLower = (order?.status || '').toLowerCase();
        const totalMatch = order && Number(order.total || 0).toFixed(2) === Number(snapshot.total || 0).toFixed(2);
        const methodMatch = order && (order.paymentMethod || '').toLowerCase() === 'paypal';
        if (!order || order.userId !== userId || statusLower !== 'pending_payment' || !totalMatch || !methodMatch) {
          order = null;
        }
      }

      if (!order) {
        orderId = await createPendingOrder(req, snapshot);
        order = await getOrderById(orderId);
        req.session.pendingPaypalOrderId = orderId;
      }

      const idempotencyKey = `paypal-${orderId}`;
      const returnUrl = `${req.protocol}://${req.get('host')}/paypal/return`;
      const cancelUrl = `${req.protocol}://${req.get('host')}/paypal/cancel`;
      const paypalOrder = await paypalService.createOrder(order.total, {
        idempotencyKey,
        returnUrl,
        cancelUrl,
      });

      await new Promise((resolve, reject) => {
        Order.updatePayPalRefs(orderId, paypalOrder.id, null, (err) =>
          err ? reject(err) : resolve()
        );
      });
      req.session.pendingPaypalOrderId = orderId;
      req.session.pendingPaypalOrder = {
        orderId,
        paypalOrderId: paypalOrder.id,
      };
      console.log('[paypal] order created', { orderId, paypalOrderId: paypalOrder.id, amount: order.total });

      const approveLink = (paypalOrder.links || []).find((l) => l.rel === 'approve');
      res.json({
        success: true,
        orderId,
        paypalOrderId: paypalOrder.id,
        status: paypalOrder.status,
        amount: order.total,
        approveUrl: approveLink ? approveLink.href : null,
      });
    } catch (error) {
      console.error('PayPal create order error:', error);
      res
        .status(500)
        .json({ success: false, message: 'Unable to create PayPal order. Please try again.' });
    }
  },

  captureOrder: async (req, res) => {
    try {
      const { orderID } = req.body || {};
      const result = await PayPalController.capturePayPalOrder(req, orderID);
      if (!result.success) {
        return res.status(result.status || 500).json({ success: false, message: result.message, detail: result.detail });
      }
      res.json({ success: true, orderId: result.orderId, redirect: `/orders/success?id=${result.orderId}` });
    } catch (error) {
      console.error('PayPal capture order error:', error);
      res
        .status(500)
        .json({ success: false, message: 'Unable to confirm PayPal payment. Please try again.' });
    }
  },

  return: async (req, res) => {
    try {
      const orderID = req.query.token || req.query.orderID;
      if (!orderID) {
        req.flash('error', 'Missing PayPal order reference.');
        return res.redirect('/checkout');
      }
      const result = await PayPalController.capturePayPalOrder(req, orderID);
      if (!result.success) {
        req.flash('error', result.message || 'PayPal payment was not completed.');
        return res.redirect('/orders/fail');
      }
      res.redirect(`/orders/success?id=${result.orderId}`);
    } catch (error) {
      console.error('PayPal return error:', error);
      req.flash('error', 'PayPal payment could not be confirmed.');
      res.redirect('/checkout');
    }
  },

  cancel: async (req, res) => {
    try {
      const orderId = req.session.pendingPaypalOrderId;
      if (orderId) {
        await updateOrderStatus(orderId, 'payment failed');
      }
    } catch (e) {
      // ignore
    }
    req.flash('error', 'PayPal payment was cancelled.');
    res.redirect('/checkout');
  },
};

module.exports = PayPalController;
