const Favorite = require('../models/Favorite');
const db = require('../db');

const list = (req, res) => {
    const userId = req.session.user.id;
    Favorite.listWithProducts(userId, (err, favorites) => {
        if (err) {
            console.error('DB error /favorites list:', err);
            return res.status(500).send('Database error');
        }
        res.render('favorites', { user: req.session.user, favorites: favorites || [] });
    });
};

const toggle = (req, res) => {
    const userId = req.session.user.id;
    const productId = parseInt(req.params.productId, 10);
    if (!productId) return res.status(400).json({ success: false, message: 'Invalid product' });
    Favorite.toggle(userId, productId, (err, favorited) => {
        if (err) {
            console.error('DB error /favorites toggle:', err);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        return res.json({ success: true, favorited });
    });
};

// For initial page render flags
const getIds = (req, res, next) => {
    if (!req.session.user) return next();
    Favorite.listProductIdsByUser(req.session.user.id, (err, ids) => {
        if (err) {
            console.error('DB error /favorites ids:', err);
            res.locals.favoriteIds = [];
            return next();
        }
        res.locals.favoriteIds = ids || [];
        next();
    });
};

module.exports = { list, toggle, getIds };
