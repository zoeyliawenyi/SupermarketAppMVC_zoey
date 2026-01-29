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
const refundController = require('./controllers/RefundController');
const adminRefundController = require('./controllers/AdminRefundController');

// Multer setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/images'),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

// Express setup
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: false }));
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
    req.flash('error', 'Please log in to view this resource');
    res.redirect('/login');
};
const checkAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') return next();
    req.flash('error', 'Access denied');
    res.redirect('/shopping');
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

app.post('/api/paypal/create-order', checkAuthenticated, paypalController.createOrder);
app.post('/api/paypal/capture-order', checkAuthenticated, paypalController.captureOrder);

app.get('/orders', checkAuthenticated, orderController.listUserOrders);
app.get('/orders/success', checkAuthenticated, (req, res) => {
    const id = req.query.id || (req.session.lastOrder && req.session.lastOrder.id);
    res.render('orderSuccess', { orderId: id || '' });
});
app.get('/orders/fail', checkAuthenticated, (req, res) => {
    const id = req.query.id || (req.session.lastOrder && req.session.lastOrder.id);
    res.render('orderFail', { orderId: id || '' });
});
app.get('/orders/:id', checkAuthenticated, orderController.detail);
app.get('/orders/:id/invoice', checkAuthenticated, orderController.invoice);
app.post('/orders/:orderId/cancel', checkAuthenticated, orderController.cancelOrder);

// Refunds (User)
app.get('/refunds', checkAuthenticated, refundController.list);
app.get('/refunds/request/:orderId', checkAuthenticated, refundController.showRequest);
app.post('/refunds/request', checkAuthenticated, refundController.submitRequest);
app.get('/refunds/:refundId', checkAuthenticated, refundController.detail);

// Refunds (User API)
app.get('/api/refunds', checkAuthenticated, refundController.apiList);
app.get('/api/refunds/:refundId', checkAuthenticated, refundController.apiDetail);
app.post('/api/refunds/request', checkAuthenticated, refundController.apiRequest);

// Admin Protected
app.get('/admin/dashboard', checkAuthenticated, checkAdmin, adminController.dashboard);
app.get('/admin/users', checkAuthenticated, checkAdmin, adminController.listUsers);
app.post('/admin/users/:id/update', checkAuthenticated, checkAdmin, adminController.updateUserInfo);
app.post('/admin/users/:id/delete', checkAuthenticated, checkAdmin, adminController.removeUser);
app.get('/admin/orders', checkAuthenticated, checkAdmin, orderController.listAll);
app.post('/admin/orders/:id/status', checkAuthenticated, checkAdmin, orderController.updateStatus);
app.get('/admin/orders/:id/invoice', checkAuthenticated, checkAdmin, orderController.invoice);
app.get('/admin/orders/:id', checkAuthenticated, checkAdmin, orderController.detail);
app.get('/admin/reviews', checkAuthenticated, checkAdmin, adminReviewController.list);
app.post('/admin/reviews/:id/update', checkAuthenticated, checkAdmin, adminReviewController.reply);
app.post('/admin/reviews/:id/delete', checkAuthenticated, checkAdmin, adminReviewController.remove);

// Refunds (Admin)
app.get('/admin/refunds', checkAuthenticated, checkAdmin, adminRefundController.list);
app.get('/admin/refunds/:refundId', checkAuthenticated, checkAdmin, adminRefundController.detail);
app.post('/admin/refunds/:refundId/decision', checkAuthenticated, checkAdmin, adminRefundController.decision);
app.post('/admin/refunds/:refundId/initiate', checkAuthenticated, checkAdmin, adminRefundController.initiate);
app.post('/admin/refunds/:refundId/complete', checkAuthenticated, checkAdmin, adminRefundController.complete);
app.post('/admin/refunds/:refundId/fail', checkAuthenticated, checkAdmin, adminRefundController.fail);

// Refunds (Admin API)
app.get('/api/admin/refunds', checkAuthenticated, checkAdmin, adminRefundController.apiList);
app.get('/api/admin/refunds/:refundId', checkAuthenticated, checkAdmin, adminRefundController.apiDetail);
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
