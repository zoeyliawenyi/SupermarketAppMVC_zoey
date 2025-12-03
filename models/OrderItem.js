const db = require('../db');

const OrderItem = {
  createMany: (orderId, items, cb) => {
    if (!items || !items.length) return cb(null);
    const values = items.map(it => [
      orderId,
      it.productId || null,
      it.productName || '',
      it.quantity || 1,
      it.price || 0
    ]);
    const sql = 'INSERT INTO order_items (orderId, productId, productName, quantity, price) VALUES ?';
    db.query(sql, [values], (err) => cb(err));
  },

  findByOrderIds: (orderIds, cb) => {
    if (!orderIds || !orderIds.length) return cb(null, []);
    const sql = `
      SELECT oi.*, p.image AS productImage
      FROM order_items oi
      LEFT JOIN products p
        ON p.id = oi.productId
        OR (oi.productId IS NULL AND LOWER(oi.productName) = LOWER(p.productName))
      WHERE orderId IN (?)
    `;
    db.query(sql, [orderIds], (err, rows) => {
      if (err) {
        // fallback without join if schema differs
        const fallback = 'SELECT * FROM order_items WHERE orderId IN (?)';
        return db.query(fallback, [orderIds], (err2, rows2) => cb(err2, rows2 || []));
      }
      cb(null, rows || []);
    });
  },

  findByOrderId: (orderId, cb) => {
    const sql = `
      SELECT oi.*, p.image AS productImage
      FROM order_items oi
      LEFT JOIN products p
        ON p.id = oi.productId
        OR (oi.productId IS NULL AND LOWER(oi.productName) = LOWER(p.productName))
      WHERE orderId = ?
    `;
    db.query(sql, [orderId], (err, rows) => {
      if (err) {
        const fallback = 'SELECT * FROM order_items WHERE orderId = ?';
        return db.query(fallback, [orderId], (err2, rows2) => cb(err2, rows2 || []));
      }
      cb(null, rows || []);
    });
  }
};

module.exports = OrderItem;
