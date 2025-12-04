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
  }
};

module.exports = Review;
