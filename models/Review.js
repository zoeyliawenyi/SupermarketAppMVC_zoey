const db = require('../db');

const Review = {
  create({ productId, userId, rating, comment }, cb) {
    const sql = 'INSERT INTO reviews (productId, userId, rating, comment, created_at) VALUES (?, ?, ?, ?, NOW())';
    db.query(sql, [productId, userId, rating, comment], cb);
  },
  listByUser(userId, cb) {
    const sql = `
      SELECT r.*, p.productName, p.image, IFNULL(r.reply,'') AS reply
      FROM reviews r
      LEFT JOIN products p ON p.id = r.productId
      WHERE r.userId = ?
      ORDER BY r.created_at DESC, r.id DESC
    `;
    db.query(sql, [userId], (err, rows) => {
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        // fallback if reply column not present
        const fallback = `
          SELECT r.*, p.productName, p.image, '' AS reply
          FROM reviews r
          LEFT JOIN products p ON p.id = r.productId
          WHERE r.userId = ?
          ORDER BY r.created_at DESC, r.id DESC
        `;
        return db.query(fallback, [userId], cb);
      }
      cb(err, rows);
    });
  },
  listAll(cb) {
    const sql = `
      SELECT r.*, u.username, u.role AS userRole, p.productName, p.image, IFNULL(r.reply,'') AS reply
      FROM reviews r
      LEFT JOIN users u ON u.id = r.userId
      LEFT JOIN products p ON p.id = r.productId
      ORDER BY r.created_at DESC, r.id DESC
    `;
    db.query(sql, (err, rows) => {
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        const fallback = `
          SELECT r.*, u.username, u.role AS userRole, p.productName, p.image, '' AS reply
          FROM reviews r
          LEFT JOIN users u ON u.id = r.userId
          LEFT JOIN products p ON p.id = r.productId
          ORDER BY r.created_at DESC, r.id DESC
        `;
        return db.query(fallback, cb);
      }
      cb(err, rows);
    });
  },
  getProductInfo(productId, cb) {
    const sql = 'SELECT id, productName, image FROM products WHERE id = ? LIMIT 1';
    db.query(sql, [productId], cb);
  },
  update(id, { rating, comment }, cb) {
    const sql = 'UPDATE reviews SET rating = ?, comment = ? WHERE id = ?';
    db.query(sql, [rating, comment, id], cb);
  },
  remove(id, cb) {
    const sql = 'DELETE FROM reviews WHERE id = ?';
    db.query(sql, [id], cb);
  },
  reply(id, text, cb) {
    const sql = 'UPDATE reviews SET reply = ? WHERE id = ?';
    db.query(sql, [text, id], (err) => {
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        console.warn('Reply column missing, skipping reply save.');
        return cb(null);
      }
      cb(err);
    });
  }
};

module.exports = Review;
