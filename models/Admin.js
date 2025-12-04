const db = require('../db');

const getDashboardStats = (callback) => {
    const stats = {};
    db.query('SELECT COUNT(*) AS totalProducts FROM products', (err, productRows) => {
        if (err) return callback(err);
        stats.products = productRows[0]?.totalProducts || 0;

        db.query('SELECT COUNT(*) AS totalUsers FROM users', (userErr, userRows) => {
            if (userErr) return callback(userErr);
            stats.users = userRows[0]?.totalUsers || 0;

            db.query('SELECT COUNT(*) AS totalOrders FROM orders', (orderErr, orderRows) => {
                if (orderErr) return callback(orderErr);
                stats.orders = orderRows[0]?.totalOrders || 0;
                return callback(null, stats);
            });
        });
    });
};

const getUsers = (callback) => {
    const sql = 'SELECT id, username, email, role, address, contact FROM users ORDER BY id DESC';
    db.query(sql, callback);
};

const updateUserInfo = (userId, email, address, contact, callback) => {
    const sql = 'UPDATE users SET email = ?, address = ?, contact = ? WHERE id = ?';
    db.query(sql, [email, address, contact, userId], callback);
};

const deleteUser = (userId, callback) => {
    const sql = 'UPDATE users SET role = "deleted" WHERE id = ?';
    db.query(sql, [userId], callback);
};

const getOrders = (callback) => {
    const sql = 'SELECT * FROM orders ORDER BY id DESC';
    db.query(sql, callback);
};

const getRatingSummary = (callback) => {
    const sql = `
      SELECT rating, COUNT(*) AS count
      FROM reviews
      GROUP BY rating
    `;
    db.query(sql, callback);
};

const getRecentReviews = (callback) => {
    const sql = `
      SELECT r.*, u.username, p.productName
      FROM reviews r
      LEFT JOIN users u ON u.id = r.userId
      LEFT JOIN products p ON p.id = r.productId
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 5
    `;
    db.query(sql, callback);
};

const getRecentOrders = (callback) => {
    const sql = `
      SELECT o.*, u.username
      FROM orders o
      LEFT JOIN users u ON u.id = o.userId
      ORDER BY o.createdAt DESC, o.id DESC
      LIMIT 6
    `;
    db.query(sql, callback);
};

module.exports = {
    getDashboardStats,
    getUsers,
    updateUserInfo,
    deleteUser,
    getOrders,
    getRecentOrders,
    getRecentReviews,
    getRatingSummary
};
