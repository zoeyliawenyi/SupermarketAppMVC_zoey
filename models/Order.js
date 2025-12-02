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
    const sql = 'SELECT * FROM orders ORDER BY createdAt DESC';
    connection.query(sql, cb);
  }
};

module.exports = Order;
