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

                // low stock items
                db.query('SELECT id, productName, stock, image FROM products WHERE stock < 20 ORDER BY stock ASC LIMIT 20', (lsErr, lowRows) => {
                    if (lsErr) return callback(lsErr);
                    stats.lowStock = lowRows || [];
                    const salesSql = `
                      SELECT IFNULL(SUM(o.total - IFNULL(rf.refundedAmount, 0)), 0) AS salesNet
                      FROM orders o
                      LEFT JOIN (
                        SELECT r.orderId, IFNULL(SUM(ri.lineRefundAmount), 0) AS refundedAmount
                        FROM refunds r
                        JOIN refund_items ri ON ri.refundId = r.id
                        WHERE r.status IN ('refunded','completed')
                        GROUP BY r.orderId
                      ) rf ON rf.orderId = o.id
                      WHERE o.status IN ('payment_successful','packing','ready_for_pickup','out_for_delivery','completed','partially_refunded')
                    `;
                    db.query(salesSql, (salesErr, salesRows) => {
                        if (salesErr) return callback(salesErr);
                        stats.salesNet = salesRows && salesRows[0] ? Number(salesRows[0].salesNet || 0) : 0;
                        return callback(null, stats);
                    });
                });
            });
        });
    });
};

const getUsers = (callback) => {
    const sql = `
      SELECT id, username, email, role, address, contact,
             zozoPlusStatus, zozoPlusActivatedAt, zozoPlusCurrentPeriodEnd
      FROM users
      ORDER BY id DESC
    `;
    db.query(sql, (err, results) => {
        if (err && err.code === 'ER_BAD_FIELD_ERROR') {
            console.warn('[admin] users table missing ZozoPlus columns, using fallback query');
            const fallbackSql = 'SELECT id, username, email, role, address, contact FROM users ORDER BY id DESC';
            return db.query(fallbackSql, callback);
        }
        return callback(err, results);
    });
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

const getOrderSummary = (callback) => {
    const summary = { netSales: 0, netLoss: 0 };
    const netSalesSql = `
      SELECT IFNULL(SUM(o.total - IFNULL(rf.refundedAmount, 0)), 0) AS salesNet
      FROM orders o
      LEFT JOIN (
        SELECT r.orderId, IFNULL(SUM(ri.lineRefundAmount), 0) AS refundedAmount
        FROM refunds r
        JOIN refund_items ri ON ri.refundId = r.id
        WHERE r.status IN ('refunded','completed')
        GROUP BY r.orderId
      ) rf ON rf.orderId = o.id
      WHERE o.status IN ('payment_successful','packing','ready_for_pickup','out_for_delivery','completed','partially_refunded')
    `;
    const netLossSql = `
      SELECT IFNULL(SUM(ri.lineRefundAmount), 0) AS refundTotal
      FROM refunds r
      JOIN refund_items ri ON ri.refundId = r.id
      WHERE r.status IN ('refunded','completed')
    `;
    db.query(netSalesSql, (salesErr, salesRows) => {
        if (salesErr) return callback(salesErr);
        summary.netSales = salesRows && salesRows[0] ? Number(salesRows[0].salesNet || 0) : 0;
        db.query(netLossSql, (lossErr, lossRows) => {
            if (lossErr) return callback(lossErr);
            summary.netLoss = lossRows && lossRows[0] ? Number(lossRows[0].refundTotal || 0) : 0;
            return callback(null, summary);
        });
    });
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
    getOrderSummary,
    getRecentOrders,
    getRecentReviews,
    getRatingSummary
};
