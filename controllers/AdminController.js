const Admin = require('../models/Admin');

const renderError = (res, message, err) => {
    console.error(message, err);
    return res.status(500).send(message);
};

const dashboard = (req, res) => {
    Admin.getDashboardStats((err, stats) => {
        if (err) return renderError(res, 'Error loading dashboard data', err);
        Admin.getRecentOrders((orderErr, orders) => {
            if (orderErr) return renderError(res, 'Error loading recent orders', orderErr);
            Admin.getRecentReviews((reviewErr, reviews) => {
                if (reviewErr) return renderError(res, 'Error loading recent reviews', reviewErr);
                Admin.getRatingSummary((ratingErr, ratingRows) => {
                    if (ratingErr) return renderError(res, 'Error loading ratings summary', ratingErr);
                    stats.recentOrders = orders || [];
                    stats.recentReviews = reviews || [];
                    stats.ratingSummary = ratingRows || [];
                    res.render('adminDashboard', { user: req.session.user, stats });
                });
            });
        });
    });
};

const listUsers = (req, res) => {
    Admin.getUsers((err, users) => {
        if (err) return renderError(res, 'Error loading users', err);
        const activeMembers = (users || []).filter(
            (u) => (u.zozoPlusStatus || '').toLowerCase() === 'active'
        ).length;
        res.render('adminUsers', { user: req.session.user, users, activeMembers });
    });
};

const updateUserInfo = (req, res) => {
    const userId = req.params.id;
    const { email, address, contact } = req.body;
    Admin.updateUserInfo(userId, email, address, contact, (err) => {
        if (err) return renderError(res, 'Error updating user', err);
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
    Admin.getOrderSummary((summaryErr, summary) => {
        if (summaryErr) console.warn('Admin order summary error:', summaryErr);
        Admin.getOrders((err, orders) => {
            if (err) return renderError(res, 'Error loading orders', err);
            res.render('adminOrders', { user: req.session.user, orders, summary: summary || { netSales: 0, netLoss: 0 } });
        });
    });
};

module.exports = {
    dashboard,
    listUsers,
    updateUserInfo,
    removeUser,
    listOrders
};
