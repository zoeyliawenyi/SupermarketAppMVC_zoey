const connection = require('../db');

const Order = {
  create: (order, cb) => {
    const sql = 'INSERT INTO orders (userId, total, paymentMethod, deliveryType, address, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, NOW())';
    connection.query(sql, [
      order.userId,
      order.total,
      order.paymentMethod,
      order.deliveryType,
      order.address,
      order.status || 'placed'
    ], (err, result) => {
      if (err) return cb(err);
      cb(null, result.insertId);
    });
  },

  findByUser: (userId, cb) => {
    const sql = 'SELECT * FROM orders WHERE userId = ? ORDER BY createdAt DESC';
    connection.query(sql, [userId], cb);
  },

  findAll: (cb) => {
    const sql = 'SELECT o.*, u.username FROM orders o LEFT JOIN users u ON o.userId = u.id ORDER BY o.createdAt DESC';
    connection.query(sql, cb);
  },

  updateStatus: (id, status, cb) => {
    const sql = 'UPDATE orders SET status = ? WHERE id = ?';
    connection.query(sql, [status, id], cb);
  }
};

module.exports = Order;
