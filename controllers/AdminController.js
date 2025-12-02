const Admin = require('../models/Admin');

const renderError = (res, message, err) => {
    console.error(message, err);
    return res.status(500).send(message);
};

const dashboard = (req, res) => {
    Admin.getDashboardStats((err, stats) => {
        if (err) return renderError(res, 'Error loading dashboard data', err);
        res.render('adminDashboard', { user: req.session.user, stats });
    });
};

const listUsers = (req, res) => {
    Admin.getUsers((err, users) => {
        if (err) return renderError(res, 'Error loading users', err);
        res.render('adminUsers', { user: req.session.user, users });
    });
};

const changeUserRole = (req, res) => {
    const userId = req.params.id;
    const { role } = req.body;
    Admin.updateUserRole(userId, role, (err) => {
        if (err) return renderError(res, 'Error updating user role', err);
        res.redirect('/admin/users');
    });
};

const removeUser = (req, res) => {
    const userId = req.params.id;
    Admin.deleteUser(userId, (err) => {
        if (err) return renderError(res, 'Error deleting user', err);
        res.redirect('/admin/users');
    });
};

const listOrders = (req, res) => {
    Admin.getOrders((err, orders) => {
        if (err) return renderError(res, 'Error loading orders', err);
        res.render('adminOrders', { user: req.session.user, orders });
    });
};

module.exports = {
    dashboard,
    listUsers,
    changeUserRole,
    removeUser,
    listOrders
};
