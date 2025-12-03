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

exports.updateStatus = (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body;
  if (!status) return res.status(400).json({ success: false });
  Order.updateStatus(id, status, (err) => {
    if (err) {
      console.error('DB error /admin/orders status:', err);
      return res.status(500).json({ success: false });
    }
    res.json({ success: true });
  });
};
