const Order = require('../models/Order');

exports.listUserOrders = (req, res) => {
  const userId = req.session.user.id;
  Order.findByUser(userId, (err, results) => {
    if (err) {
      console.error('DB error /orders:', err);
      req.flash('error', 'Could not load orders.');
      return res.render('orders', { user: req.session.user, orders: [] });
    }
    res.render('orders', { user: req.session.user, orders: results || [], order: null });
  });
};

exports.listAll = (req, res) => {
  Order.findAll((err, results) => {
    if (err) {
      console.error('DB error /admin/orders:', err);
      return res.render('adminOrders', { orders: [] });
    }
    res.render('adminOrders', { orders: results || [], user: req.session.user });
  });
};
