const db = require('../db');

const Cart = {
    getByUserId: (userId, callback) => {
        const sql = `
            SELECT c.id, c.productId, c.quantity, p.productName, p.price, p.image, p.stock
            FROM cart_items c
            JOIN products p ON c.productId = p.id
            WHERE c.userId = ?
        `;
        db.query(sql, [userId], callback);
    },

    addItem: (userId, productId, quantity, callback) => {
        // Check if item already exists
        const checkSql = 'SELECT id, quantity FROM cart_items WHERE userId = ? AND productId = ?';
        db.query(checkSql, [userId, productId], (err, results) => {
            if (err) return callback(err);

            if (results.length > 0) {
                // Update quantity
                const newQty = results[0].quantity + quantity;
                const updateSql = 'UPDATE cart_items SET quantity = ? WHERE id = ?';
                db.query(updateSql, [newQty, results[0].id], callback);
            } else {
                // Insert new item
                const insertSql = 'INSERT INTO cart_items (userId, productId, quantity) VALUES (?, ?, ?)';
                db.query(insertSql, [userId, productId, quantity], callback);
            }
        });
    },

    updateQuantity: (userId, productId, quantity, callback) => {
        const sql = 'UPDATE cart_items SET quantity = ? WHERE userId = ? AND productId = ?';
        db.query(sql, [quantity, userId, productId], callback);
    },

    removeItem: (userId, productId, callback) => {
        const sql = 'DELETE FROM cart_items WHERE userId = ? AND productId = ?';
        db.query(sql, [userId, productId], callback);
    },

    clearItems: (userId, productIds, callback) => {
        if (!productIds || productIds.length === 0) {
            const sql = 'DELETE FROM cart_items WHERE userId = ?';
            return db.query(sql, [userId], callback);
        }
        const sql = 'DELETE FROM cart_items WHERE userId = ? AND productId IN (?)';
        db.query(sql, [userId, productIds], callback);
    }
};

module.exports = Cart;
