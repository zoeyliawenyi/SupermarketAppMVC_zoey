const Cart = require('../models/Cart');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Product = require('../models/Product');
const paypalService = require('../services/paypal');

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

const decrementStock = (items) =>
  Promise.all(
    (items || []).map(
      (item) =>
        new Promise((resolve, reject) =>
          Product.decrementStock(item.productId, item.quantity, (err) =>
            err ? reject(err) : resolve()
          )
        )
    )
  );

const buildCheckoutSnapshot = (req, cart) => {
  const selection = Array.isArray(req.session.checkoutSelection)
    ? req.session.checkoutSelection.map((v) => Number(v))
    : [];
  const cartForOrder = selection.length
    ? cart.filter((item) => selection.includes(Number(item.productId)))
    : cart;

  const shipping = req.session.checkoutShipping || {
    contact: req.session.user?.contact || '',
    address: req.session.user?.address || '',
    option: 'pickup',
    payment: 'paypal',
  };

  const shippingCost = shipping.option === 'delivery' ? 2.0 : 0;
  const subtotal = (cartForOrder || []).reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );
  const total = subtotal + shippingCost;

  return {
    cartForOrder,
    shipping,
    selection,
    shippingCost,
    subtotal,
    total,
  };
};

const finalizePendingOrder = async (req, status) => {
  const userId = req.session.user?.id;
  if (!userId) throw new Error('Missing session user');

  const pending = req.session.pendingPaypalOrder || {};
  const selection = Array.isArray(pending.selection)
    ? pending.selection.map((v) => Number(v))
    : [];
  const cart = await getCartByUser(userId);
  const cartForOrder = selection.length
    ? cart.filter((item) => selection.includes(Number(item.productId)))
    : cart;

  if (!cartForOrder.length) throw new Error('No items selected for checkout');

  const shipping =
    pending.shipping ||
    req.session.checkoutShipping || {
      option: 'pickup',
      payment: 'paypal',
      contact: '',
      address: '',
    };

  const shippingCost = shipping.option === 'delivery' ? 2.0 : 0;
  const subtotal = cartForOrder.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const total =
    typeof pending.total === 'number' && pending.total >= 0
      ? pending.total
      : subtotal + shippingCost;

  const orderPayload = {
    userId,
    total,
    paymentMethod: 'paypal',
    deliveryType: shipping.option,
    address: shipping.address || req.session.user?.address,
    status,
  };

  const orderId = await createOrderRecord(orderPayload);
  await createOrderItems(orderId, cartForOrder);
  await decrementStock(cartForOrder);
  const orderedProductIds = cartForOrder.map((item) => item.productId);
  await clearCartItems(userId, orderedProductIds);

  req.session.lastOrder = { id: orderId, items: cartForOrder };
  req.session.checkoutSelection = [];
  req.session.pendingPaypalOrder = null;

  return orderId;
};

const PayPalController = {
  createOrder: async (req, res) => {
    try {
      const userId = req.session.user?.id;
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const cart = await getCartByUser(userId);
      if (!cart.length) {
        return res.status(400).json({ success: false, message: 'Your cart is empty' });
      }

      const snapshot = buildCheckoutSnapshot(req, cart);
      if (!snapshot.cartForOrder.length) {
        return res.status(400).json({ success: false, message: 'No items selected for checkout' });
      }

      const paypalOrder = await paypalService.createOrder(snapshot.total);
      req.session.pendingPaypalOrder = {
        selection: snapshot.selection,
        shipping: snapshot.shipping,
        total: snapshot.total,
      };
      res.json({
        success: true,
        orderId: paypalOrder.id,
        status: paypalOrder.status,
        amount: snapshot.total,
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
      const userId = req.session.user?.id;
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const { orderID } = req.body || {};
      if (!orderID) {
        return res.status(400).json({ success: false, message: 'Missing orderID' });
      }

      const captureResult = await paypalService.captureOrder(orderID);
      const captureStatus =
        captureResult?.status ||
        captureResult?.purchase_units?.[0]?.payments?.captures?.[0]?.status ||
        '';
      const success =
        typeof captureStatus === 'string' && captureStatus.toUpperCase() === 'COMPLETED';

      if (!success) {
        return res.status(400).json({
          success: false,
          message: 'PayPal payment was not completed.',
          detail: captureStatus,
        });
      }

      const orderId = await finalizePendingOrder(req, 'payment successful');
      res.json({
        success: true,
        orderId,
        redirect: `/orders/success?id=${orderId}`,
      });
    } catch (error) {
      console.error('PayPal capture order error:', error);
      res
        .status(500)
        .json({ success: false, message: 'Unable to confirm PayPal payment. Please try again.' });
    }
  },
};

module.exports = PayPalController;
