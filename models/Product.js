const db = require('../db');

const Product = {
    getAll: (callback) => {
        const sql = `
            SELECT p.*, 
                   COALESCE(AVG(r.rating), 0) AS avgRating, 
                   COUNT(r.id) AS reviewCount
            FROM products p
            LEFT JOIN reviews r ON r.productId = p.id
            GROUP BY p.id
            ORDER BY p.id DESC
        `;
        db.query(sql, callback);
    },

    getLimited: (limit, callback) => {
        const sql = 'SELECT * FROM products ORDER BY id DESC LIMIT ?';
        db.query(sql, [limit], callback);
    },

    getById: (id, callback) => {
        const sql = `
            SELECT p.*, 
                   COALESCE(AVG(r.rating), 0) AS avgRating, 
                   COUNT(r.id) AS reviewCount
            FROM products p
            LEFT JOIN reviews r ON r.productId = p.id
            WHERE p.id = ?
            GROUP BY p.id
        `;
        db.query(sql, [id], (err, results) => {
            if (err) return callback(err);
            callback(null, results[0]);
        });
    },

    create: (data, callback) => {
        const { name, stock, price, image, category, description, dietary } = data;
        const sql = 'INSERT INTO products (productName, stock, price, image, category, description, dietary) VALUES (?, ?, ?, ?, ?, ?, ?)';
        db.query(sql, [name, stock, price, image, category, description, dietary], callback);
    },

    update: (id, data, callback) => {
        const { name, stock, price, image, category, description, dietary } = data;
        const sql = 'UPDATE products SET productName = ?, stock = ?, price = ?, image = ?, category = ?, description = ?, dietary = ? WHERE id = ?';
        db.query(sql, [name, stock, price, image, category, description, dietary, id], callback);
    },

    updateStock: (id, stock, callback) => {
        const sql = 'UPDATE products SET stock = ? WHERE id = ?';
        db.query(sql, [stock, id], callback);
    },

    incrementStock: (id, quantity, callback) => {
        const sql = 'UPDATE products SET stock = stock + ? WHERE id = ?';
        db.query(sql, [quantity, id], callback);
    },

    decrementStock: (id, quantity, callback) => {
        const sql = 'UPDATE products SET stock = GREATEST(stock - ?, 0) WHERE id = ?';
        db.query(sql, [quantity, id], callback);
    },

    delete: (id, callback) => {
        // Use a transaction or sequential deletes to handle dependencies
        db.beginTransaction((err) => {
            if (err) return callback(err);

            const queries = [
                ['DELETE FROM reviews WHERE productId = ?', [id]],
                ['DELETE FROM favorites WHERE productId = ?', [id]],
                ['DELETE FROM order_items WHERE productId = ?', [id]],
                ['DELETE FROM products WHERE id = ?', [id]]
            ];

            let completed = 0;
            const runNext = () => {
                if (completed === queries.length) {
                    return db.commit((commitErr) => {
                        if (commitErr) return db.rollback(() => callback(commitErr));
                        callback(null);
                    });
                }
                const [sql, params] = queries[completed];
                db.query(sql, params, (queryErr) => {
                    if (queryErr) return db.rollback(() => callback(queryErr));
                    completed++;
                    runNext();
                });
            };
            runNext();
        });
    }
};

module.exports = Product;
