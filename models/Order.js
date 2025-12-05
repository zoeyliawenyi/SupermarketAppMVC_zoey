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
    const sql = `
      SELECT o.*, t.totalQty, t.firstImage
      FROM orders o
      LEFT JOIN (
        SELECT oi.orderId,
               SUM(oi.quantity) AS totalQty,
               MIN(p.image) AS firstImage
        FROM order_items oi
        LEFT JOIN products p
          ON p.id = oi.productId
          OR (oi.productId IS NULL AND LOWER(oi.productName) = LOWER(p.productName))
        GROUP BY oi.orderId
      ) t ON t.orderId = o.id
      WHERE o.userId = ?
      ORDER BY o.createdAt DESC
    `;
    connection.query(sql, [userId], (err, rows) => {
      if (err) {
        const fallback = 'SELECT * FROM orders WHERE userId = ? ORDER BY createdAt DESC';
        return connection.query(fallback, [userId], cb);
      }
      cb(null, rows);
    });
  },

  findAll: (cb) => {
    const sql = 'SELECT o.*, u.username, u.role AS userRole FROM orders o LEFT JOIN users u ON o.userId = u.id ORDER BY o.createdAt DESC';
    connection.query(sql, cb);
  },

  updateStatus: (id, status, cb) => {
    const sql = 'UPDATE orders SET status = ? WHERE id = ?';
    connection.query(sql, [status, id], cb);
  },

  findByIdWithAgg: (id, cb) => {
    const sql = `
      SELECT o.*, t.totalQty, t.firstImage
      FROM orders o
      LEFT JOIN (
        SELECT oi.orderId,
               SUM(oi.quantity) AS totalQty,
               MIN(p.image) AS firstImage
        FROM order_items oi
        LEFT JOIN products p
          ON p.id = oi.productId
          OR (oi.productId IS NULL AND oi.productName = p.productName)
        GROUP BY oi.orderId
      ) t ON t.orderId = o.id
      WHERE o.id = ?
      LIMIT 1
    `;
    connection.query(sql, [id], (err, rows) => {
      if (err) {
        const fallback = 'SELECT * FROM orders WHERE id = ? LIMIT 1';
        return connection.query(fallback, [id], (err2, basic) => {
          if (err2) return cb(err2);
          cb(null, basic && basic[0] ? basic[0] : null);
        });
      }
      cb(null, rows && rows[0] ? rows[0] : null);
    });
  },

  getProductImages: ({ ids = [], names = [] }, cb) => {
    const queries = [];
    if (ids.length) {
      queries.push(new Promise((resolve, reject) => {
        connection.query('SELECT id, image FROM products WHERE id IN (?)', [ids], (e, rows) => e ? reject(e) : resolve(rows || []));
      }));
    }
    if (names.length) {
      queries.push(new Promise((resolve, reject) => {
        connection.query('SELECT productName, image FROM products WHERE productName IN (?)', [names], (e, rows) => e ? reject(e) : resolve(rows || []));
      }));
    }
    Promise.all(queries).then(results => {
      const imgsById = {};
      const imgsByName = {};
      results.flat().forEach(r => {
        if (r.id) imgsById[r.id] = r.image;
        if (r.productName) imgsByName[r.productName.toLowerCase()] = r.image;
      });
      cb(null, { imgsById, imgsByName });
    }).catch(cb);
  }
};

module.exports = Order;
