const db = require('../db');

const User = {
    findByEmailAndPassword: (email, password, callback) => {
        const sql = 'SELECT * FROM users WHERE email = ? AND password = SHA1(?)';
        db.query(sql, [email, password], (err, results) => {
            if (err) return callback(err);
            callback(null, results[0]);
        });
    },

    findByUsernameOrEmail: (username, email, callback) => {
        const sql = 'SELECT username, email FROM users WHERE username = ? OR email = ? LIMIT 1';
        db.query(sql, [username, email], (err, results) => {
            if (err) return callback(err);
            callback(null, results[0]);
        });
    },

    create: (data, callback) => {
        const { username, email, password, address, contact, role } = data;
        const sql = 'INSERT INTO users (username, email, password, address, contact, role) VALUES (?, ?, SHA1(?), ?, ?, ?)';
        db.query(sql, [username, email, password, address, contact, role || 'user'], callback);
    },

    updateProfile: (id, data, callback) => {
        const { username, address, contact } = data;
        const sql = 'UPDATE users SET username = ?, address = ?, contact = ? WHERE id = ?';
        db.query(sql, [username, address, contact, id], callback);
    },

    updatePassword: (email, password, callback) => {
        const sql = 'UPDATE users SET password = SHA1(?) WHERE email = ?';
        db.query(sql, [password, email], callback);
    },

    softDelete: (id, callback) => {
        const sql = 'UPDATE users SET role = "deleted" WHERE id = ?';
        db.query(sql, [id], callback);
    }
};

module.exports = User;
