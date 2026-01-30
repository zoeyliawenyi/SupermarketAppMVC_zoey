require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const path = require('path');
const app = express();

// Controllers
const userController = require('./controllers/UserController');
const productController = require('./controllers/ProductController');
const adminController = require('./controllers/AdminController');
const orderController = require('./controllers/OrderController');
const favoriteController = require('./controllers/FavoriteController');
const reviewController = require('./controllers/ReviewController');
const adminReviewController = require('./controllers/AdminReviewController');
const netsController = require('./controllers/NetsController');
const paypalController = require('./controllers/PayPalController');
const stripeController = require('./controllers/StripeController');
const subscriptionController = require('./controllers/SubscriptionController');
const refundController = require('./controllers/RefundController');
const adminRefundController = require('./controllers/AdminRefundController');

// Multer setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/images'),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });
const refundUpload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 3, fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (allowed.includes(file.mimetype)) return cb(null, true);
        cb(new Error('Only JPG, PNG, or WEBP images are allowed.'));
    }
});

// Express setup
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: false }));
// Stripe webhook must receive raw body before JSON middleware
app.get('/webhooks/stripe', (req, res) => {
    res.status(200).send('Stripe webhook endpoint is alive. Use POST for events.');
});
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeController.webhook);
app.use(express.json());

// Cookie helper
app.use((req, res, next) => {
    req.cookies = {};
    const raw = req.headers.cookie || '';
    raw.split(';').forEach(part => {
        const [k, v] = part.split('=');
        if (!k || v === undefined) return;
        try { req.cookies[k.trim()] = decodeURIComponent(v.trim()); } catch (e) { req.cookies[k.trim()] = v.trim(); }
    });
    res.setClientCookie = (name, value, opts = {}) => {
        const maxAge = opts.maxAge || (7 * 24 * 60 * 60 * 1000);
        const cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${Math.floor(maxAge/1000)}; Path=/`;
        res.append('Set-Cookie', cookie);
    };
    next();
});

// Session
app.use(session({
    secret: 'secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } 
}));
app.use(flash());

// Global locals
const Cart = require('./models/Cart');
app.use((req, res, next) => {
    res.locals.user = req.session.user;
    if (req.session.user) {
        Cart.getByUserId(req.session.user.id, (err, cart) => {
            res.locals.cartCount = (cart || []).reduce((sum, item) => sum + (item.quantity || 0), 0);
            next();
        });
    } else {
        res.locals.cartCount = 0;
        next();
    }
});

// Auth Middlewares
const checkAuthenticated = (req, res, next) => {
    if (req.session.user) return next();
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.xhr || (req.path || '').startsWith('/api/');
    if (wantsJson) return res.status(401).json({ success: false, message: 'Unauthorized' });
    req.flash('error', 'Please log in to view this resource');
    res.redirect('/login');
};
const checkAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') return next();
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.xhr || (req.path || '').startsWith('/api/');
    if (wantsJson) return res.status(403).json({ success: false, message: 'Forbidden' });
    res.status(403).send('Forbidden');
};

// Validation Middleware
const validateRegistration = (req, res, next) => {
    const { username, email, password, address, countryCode, contactNumber } = req.body;
    if (!username || !email || !password || !address || !countryCode || !contactNumber) {
        req.flash('error', 'All fields are required.');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }
    if (password.length < 6) {
        req.flash('error', 'Password should be at least 6 or more characters long');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }
    const digits = (contactNumber || '').replace(/\D/g, '');
    if (digits.length !== 8) {
        req.flash('error', 'Contact number must be 8 digits.');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }
    next();
};

// --- Routes ---

// Public
app.get('/', productController.showHome);
app.get('/register', userController.showRegister);
app.post('/register', validateRegistration, userController.register);
app.get('/login', userController.showLogin);
app.post('/login', userController.login);
app.get('/logout', userController.logout);
app.get('/forgot-password', userController.showForgotPassword);
app.post('/forgot-password', userController.forgotPassword);
app.post('/reset-password', userController.resetPassword);

// User Protected
app.get('/shopping', checkAuthenticated, favoriteController.getIds, productController.showShopping);
app.get('/product/:id', checkAuthenticated, productController.showProductDetail);
app.get('/account', checkAuthenticated, userController.showAccount);
app.post('/account', checkAuthenticated, userController.updateAccount);
app.post('/account/delete', checkAuthenticated, userController.deleteAccount);

// Favorites
app.get('/favorites', checkAuthenticated, favoriteController.list);
app.post('/favorites/:productId/toggle', checkAuthenticated, favoriteController.toggle);

// Reviews
app.get('/reviews', checkAuthenticated, reviewController.list);
app.post('/reviews', checkAuthenticated, reviewController.create);

// Cart & Checkout (To be updated to DB-based in next phase)
// For now, keeping them as they are but moving logic if needed
// (I will implement the DB-based cart in the next phase as planned)
const CartController = require('./controllers/CartController'); // We'll create this
app.get('/cart', checkAuthenticated, CartController.showCart);
app.post('/add-to-cart/:id', checkAuthenticated, CartController.addToCart);
app.post('/cart/update/:id', checkAuthenticated, CartController.updateCart);
app.post('/cart/delete/:id', checkAuthenticated, CartController.deleteFromCart);
app.post('/cart/select', checkAuthenticated, CartController.selectItems);

app.get('/checkout', checkAuthenticated, CartController.showCheckout);
app.post('/checkout/shipping', checkAuthenticated, CartController.updateShipping);
app.post('/checkout/option', checkAuthenticated, CartController.updateOption);
app.post('/checkout/payment', checkAuthenticated, CartController.updatePayment);
app.post('/place-order', checkAuthenticated, CartController.placeOrder);
app.post('/nets-qr/request', checkAuthenticated, netsController.start);
app.get('/sse/payment-status/:txnRetrievalRef', checkAuthenticated, netsController.sseStatus);
app.get('/nets-qr/success', checkAuthenticated, netsController.success);
app.get('/nets-qr/fail', checkAuthenticated, netsController.fail);
app.get('/nets/status/:requestId', checkAuthenticated, netsController.status);
app.get('/nets/simulate-success/:requestId', checkAuthenticated, netsController.simulateSuccess);
app.get('/nets/simulate-failure/:requestId', checkAuthenticated, netsController.simulateFailure);
app.post('/nets/cancel/:requestId', checkAuthenticated, netsController.cancel);
app.get('/dev/nets/tx/:orderId', checkAuthenticated, netsController.devTxn);

app.post('/api/paypal/create-order', checkAuthenticated, paypalController.createOrder);
app.post('/api/paypal/capture-order', checkAuthenticated, paypalController.captureOrder);
app.get('/paypal/return', checkAuthenticated, paypalController.return);
app.get('/paypal/cancel', checkAuthenticated, paypalController.cancel);
app.post('/payments/stripe/create-intent', checkAuthenticated, stripeController.createIntent);
app.post('/payments/stripe/confirm', checkAuthenticated, stripeController.confirmPayment);
app.post('/dev/stripe/intent/succeed', checkAuthenticated, stripeController.devConfirmIntent);

app.get('/orders', checkAuthenticated, orderController.listUserOrders);
app.get('/orders/success', checkAuthenticated, (req, res) => {
    const id = req.query.id || (req.session.lastOrder && req.session.lastOrder.id);
    if (!id) return res.render('orderSuccess', { orderId: '' });
    const Order = require('./models/Order');
    Order.findByIdWithAgg(id, (err, order) => {
        if (err || !order) return res.render('orderSuccess', { orderId: id || '' });
        const statusLower = (order.status || '').trim().toLowerCase();
        if (statusLower !== 'payment successful') {
            req.flash('error', 'Payment is not confirmed yet.');
            return res.redirect(`/orders/${order.id}`);
        }
        res.render('orderSuccess', { orderId: id || '' });
    });
});
app.get('/orders/fail', checkAuthenticated, (req, res) => {
    const id = req.query.id || (req.session.lastOrder && req.session.lastOrder.id);
    res.render('orderFail', { orderId: id || '' });
});
app.get('/orders/:id', checkAuthenticated, orderController.detail);
app.get('/orders/:id/invoice', checkAuthenticated, orderController.invoice);
app.post('/orders/:orderId/cancel', checkAuthenticated, orderController.cancelOrder);

app.post('/dev/stripe/webhook/simulate', checkAuthenticated, checkAdmin, stripeController.devSimulateWebhook);

app.get('/subscriptions/plans', checkAuthenticated, subscriptionController.plans);
app.post('/subscriptions/stripe/checkout-session', checkAuthenticated, subscriptionController.createCheckoutSession);
app.get('/subscriptions/success', checkAuthenticated, subscriptionController.success);
app.get('/subscriptions/manage', checkAuthenticated, subscriptionController.manage);
app.post('/subscriptions/cancel', checkAuthenticated, subscriptionController.cancel);
app.post('/subscriptions/usage/record', checkAuthenticated, checkAdmin, subscriptionController.recordUsage);

// Refunds (User)
app.get('/refunds', checkAuthenticated, refundController.list);
app.get('/refunds/request/:orderId', checkAuthenticated, refundController.showRequest);
app.post('/refunds/request', checkAuthenticated, (req, res, next) => {
    refundUpload.array('evidenceImages', 3)(req, res, (err) => {
        if (err) {
            const msg = err.message || 'Invalid evidence upload';
            const wantsJson = (req.get('accept') || '').includes('application/json') || req.xhr;
            if (wantsJson) return res.status(400).json({ success: false, message: msg });
            req.flash('error', msg);
            const orderId = req.body.orderId || '';
            return res.redirect(orderId ? `/refunds/request/${orderId}` : '/orders');
        }
        next();
    });
}, refundController.submitRequest);
app.get('/refunds/:refundId', checkAuthenticated, refundController.detail);
app.post('/orders/:orderId/refund', checkAuthenticated, refundController.quickRequest);

// Refunds (User API)
app.get('/api/refunds', checkAuthenticated, refundController.apiList);
app.get('/api/refunds/:refundId', checkAuthenticated, refundController.apiDetail);
app.post('/api/refunds/request', checkAuthenticated, (req, res, next) => {
    refundUpload.array('evidenceImages', 3)(req, res, (err) => {
        if (err) {
            return res.status(400).json({ status: 'error', message: err.message || 'Invalid evidence upload' });
        }
        next();
    });
}, refundController.apiRequest);

// Admin Protected
app.get('/admin/dashboard', checkAuthenticated, checkAdmin, adminController.dashboard);
app.get('/admin/users', checkAuthenticated, checkAdmin, adminController.listUsers);
app.post('/admin/users/:id/update', checkAuthenticated, checkAdmin, adminController.updateUserInfo);
app.post('/admin/users/:id/delete', checkAuthenticated, checkAdmin, adminController.removeUser);
app.get('/admin/orders', checkAuthenticated, checkAdmin, orderController.listAll);
app.post('/admin/orders/:id/status', checkAuthenticated, checkAdmin, orderController.updateStatus);
app.post('/admin/pickup/redeem', checkAuthenticated, checkAdmin, orderController.redeemPickup);
app.get('/admin/orders/:id/invoice', checkAuthenticated, checkAdmin, orderController.invoice);
app.get('/admin/orders/:id', checkAuthenticated, checkAdmin, orderController.detail);
app.get('/admin/reviews', checkAuthenticated, checkAdmin, adminReviewController.list);
app.post('/admin/reviews/:id/update', checkAuthenticated, checkAdmin, adminReviewController.reply);
app.post('/admin/reviews/:id/delete', checkAuthenticated, checkAdmin, adminReviewController.remove);

// Refunds (Admin)
app.get('/admin/refunds', checkAuthenticated, checkAdmin, adminRefundController.list);
app.get('/admin/refunds/:refundId', checkAuthenticated, checkAdmin, adminRefundController.detail);
app.post('/admin/refunds/:refundId/approve', checkAuthenticated, checkAdmin, adminRefundController.approve);
app.post('/admin/refunds/:refundId/reject', checkAuthenticated, checkAdmin, adminRefundController.reject);
app.post('/admin/refunds/:refundId/process', checkAuthenticated, checkAdmin, adminRefundController.process);
app.post('/admin/refunds/:refundId/decision', checkAuthenticated, checkAdmin, adminRefundController.decision);
app.post('/admin/refunds/:refundId/initiate', checkAuthenticated, checkAdmin, adminRefundController.initiate);
app.post('/admin/refunds/:refundId/complete', checkAuthenticated, checkAdmin, adminRefundController.complete);
app.post('/admin/refunds/:refundId/fail', checkAuthenticated, checkAdmin, adminRefundController.fail);

// Refunds (Admin API)
app.get('/api/admin/refunds', checkAuthenticated, checkAdmin, adminRefundController.apiList);
app.get('/api/admin/refunds/:refundId', checkAuthenticated, checkAdmin, adminRefundController.apiDetail);
app.post('/api/admin/refunds/:refundId/approve', checkAuthenticated, checkAdmin, adminRefundController.apiApprove);
app.post('/api/admin/refunds/:refundId/reject', checkAuthenticated, checkAdmin, adminRefundController.apiReject);
app.post('/api/admin/refunds/:refundId/process', checkAuthenticated, checkAdmin, adminRefundController.apiProcess);
app.post('/api/admin/refunds/:refundId/decision', checkAuthenticated, checkAdmin, adminRefundController.apiDecision);
app.post('/api/admin/refunds/:refundId/initiate', checkAuthenticated, checkAdmin, adminRefundController.apiInitiate);
app.post('/api/admin/refunds/:refundId/complete', checkAuthenticated, checkAdmin, adminRefundController.apiComplete);
app.post('/api/admin/refunds/:refundId/fail', checkAuthenticated, checkAdmin, adminRefundController.apiFail);

app.get('/inventory', checkAuthenticated, checkAdmin, productController.showInventory);
app.post('/inventory/:id/stock', checkAuthenticated, checkAdmin, productController.updateStock);
app.get('/addProduct', checkAuthenticated, checkAdmin, productController.showAddProduct);
app.post('/addProduct', checkAuthenticated, checkAdmin, upload.single('image'), productController.addProduct);
app.get('/editProduct/:id', checkAuthenticated, checkAdmin, productController.showEditProduct);
app.post('/editProduct/:id', checkAuthenticated, checkAdmin, upload.single('image'), productController.updateProduct);
app.get('/deleteProduct/:id', checkAuthenticated, checkAdmin, productController.deleteProduct);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
