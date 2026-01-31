const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Product = require('../models/Product');
const Cart = require('../models/Cart');
const { normalizeStatus } = require('../utils/status');

const getOrderById = (orderId) =>
  new Promise((resolve, reject) =>
    Order.findByIdWithAgg(orderId, (err, order) => (err ? reject(err) : resolve(order)))
  );

const getOrderItems = (orderId) =>
  new Promise((resolve, reject) =>
    OrderItem.findByOrderId(orderId, (err, items) => (err ? reject(err) : resolve(items || [])))
  );

const updateOrderStatus = (orderId, status) =>
  new Promise((resolve, reject) =>
    Order.updateStatus(orderId, status, (err) => (err ? reject(err) : resolve()))
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

const clearCartItems = (userId, productIds) =>
  new Promise((resolve, reject) =>
    Cart.clearItems(userId, productIds, (err) => (err ? reject(err) : resolve()))
  );

const finalizePaidOrder = async (req, orderId) => {
  const order = await getOrderById(orderId);
  if (!order) throw new Error('Order not found');

  const statusKey = normalizeStatus(order.status || '');
  if (statusKey === 'payment_successful') return { order, alreadyPaid: true };
  if (statusKey.startsWith('cancelled') || ['refunded', 'refund_completed', 'refund_requested', 'partially_refunded'].includes(statusKey)) {
    return { order, blocked: true };
  }

  const items = await getOrderItems(order.id);
  if (!items.length) {
    await updateOrderStatus(order.id, 'payment_successful');
    return { order, alreadyPaid: false };
  }

  await decrementStock(items);
  const orderedProductIds = items.map((item) => item.productId).filter(Boolean);
  if (req?.session?.user?.id && orderedProductIds.length) {
    await clearCartItems(req.session.user.id, orderedProductIds);
  }
  await updateOrderStatus(order.id, 'payment_successful');

  if (req?.session) {
    req.session.lastOrder = { id: order.id, items };
    req.session.checkoutSelection = [];
  }

  return { order, alreadyPaid: false };
};

const finalizePaidOrderSystem = async (orderId) => {
  const order = await getOrderById(orderId);
  if (!order) throw new Error('Order not found');

  const statusKey = normalizeStatus(order.status || '');
  if (statusKey === 'payment_successful') return { order, alreadyPaid: true };
  if (statusKey.startsWith('cancelled') || ['refunded', 'refund_completed', 'refund_requested', 'partially_refunded'].includes(statusKey)) {
    return { order, blocked: true };
  }

  const items = await getOrderItems(order.id);
  if (!items.length) {
    await updateOrderStatus(order.id, 'payment_successful');
    return { order, alreadyPaid: false };
  }

  await decrementStock(items);
  const orderedProductIds = items.map((item) => item.productId).filter(Boolean);
  if (order.userId && orderedProductIds.length) {
    await clearCartItems(order.userId, orderedProductIds);
  }
  await updateOrderStatus(order.id, 'payment_successful');

  return { order, alreadyPaid: false };
};

module.exports = {
  finalizePaidOrder,
  finalizePaidOrderSystem,
  getOrderById,
  getOrderItems,
  updateOrderStatus,
};
