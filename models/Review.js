const db = require('../db');

const Review = {
  create({ productId, userId, rating, comment }, cb) {
    const sql = 'INSERT INTO reviews (productId, userId, rating, comment, created_at) VALUES (?, ?, ?, ?, NOW())';
    db.query(sql, [productId, userId, rating, comment], cb);
  },
  listByUser(userId, cb) {
    const sql = `
      SELECT r.*, p.productName, p.image
      FROM reviews r
      LEFT JOIN products p ON p.id = r.productId
      WHERE r.userId = ?
      ORDER BY r.created_at DESC, r.id DESC
    `;
    db.query(sql, [userId], cb);
  },
  listAll(cb) {
    const sql = `
      SELECT r.*, u.username, u.role AS userRole, p.productName, p.image
      FROM reviews r
      LEFT JOIN users u ON u.id = r.userId
      LEFT JOIN products p ON p.id = r.productId
      ORDER BY r.created_at DESC, r.id DESC
    `;
    db.query(sql, cb);
  },
  update(id, { rating, comment }, cb) {
    const sql = 'UPDATE reviews SET rating = ?, comment = ? WHERE id = ?';
    db.query(sql, [rating, comment, id], cb);
  },
  remove(id, cb) {
    const sql = 'DELETE FROM reviews WHERE id = ?';
    db.query(sql, [id], cb);
  }
};

module.exports = Review;
