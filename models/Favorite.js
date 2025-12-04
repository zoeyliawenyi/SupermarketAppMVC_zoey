const db = require('../db');

const Favorite = {
    listProductIdsByUser(userId, cb) {
        db.query('SELECT productId FROM favorites WHERE userId = ?', [userId], (err, rows) => {
            if (err) return cb(err);
            cb(null, rows.map(r => r.productId));
        });
    },
    listWithProducts(userId, cb) {
        const sql = `
            SELECT f.id, f.productId, f.createdAt,
                   p.productName, p.price, p.image, p.category, p.dietary
            FROM favorites f
            JOIN products p ON p.id = f.productId
            WHERE f.userId = ?
            ORDER BY f.createdAt DESC, f.id DESC
        `;
        db.query(sql, [userId], cb);
    },
    add(userId, productId, cb) {
        const sql = 'INSERT IGNORE INTO favorites (userId, productId, createdAt) VALUES (?, ?, NOW())';
        db.query(sql, [userId, productId], cb);
    },
    remove(userId, productId, cb) {
        db.query('DELETE FROM favorites WHERE userId = ? AND productId = ?', [userId, productId], cb);
    },
    toggle(userId, productId, cb) {
        Favorite.add(userId, productId, (err, result) => {
            if (err) return cb(err);
            if (result && result.affectedRows > 0) {
                return cb(null, true);
            }
            Favorite.remove(userId, productId, (remErr) => {
                if (remErr) return cb(remErr);
                cb(null, false);
            });
        });
    }
};

module.exports = Favorite;
