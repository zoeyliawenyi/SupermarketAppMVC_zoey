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

const updateUserRole = (userId, role, callback) => {
    const allowedRoles = ['admin', 'user'];
    if (!allowedRoles.includes(role)) {
        return callback(new Error('Invalid role'));
    }
    const sql = 'UPDATE users SET role = ? WHERE id = ?';
    db.query(sql, [role, userId], callback);
};

const deleteUser = (userId, callback) => {
    const sql = 'DELETE FROM users WHERE id = ?';
    db.query(sql, [userId], callback);
};

const getOrders = (callback) => {
    const sql = 'SELECT * FROM orders ORDER BY id DESC';
    db.query(sql, callback);
};

module.exports = {
    getDashboardStats,
    getUsers,
    updateUserRole,
    deleteUser,
    getOrders
};
