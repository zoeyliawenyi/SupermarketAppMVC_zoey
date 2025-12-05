const express = require('express');
// const mysql = require('mysql2'); // removed: use central db
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const app = express();
const adminController = require('./controllers/AdminController');
const orderController = require('./controllers/OrderController');
const favoriteController = require('./controllers/FavoriteController');
const reviewController = require('./controllers/ReviewController');
const adminReviewController = require('./controllers/AdminReviewController');
const Order = require('./models/Order');
const OrderItem = require('./models/OrderItem');

// Set up multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/images'); // Directory to save uploaded files
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname); 
    }
});

const upload = multer({ storage: storage });

// Use central DB connection from db.js (was a second hard-coded connection)
const connection = require('./db');

// Set up view engine
app.set('view engine', 'ejs');
//  enable static files
app.use(express.static('public'));
// enable form processing
app.use(express.urlencoded({
    extended: false
}));
// enable json body parsing (for AJAX like favorites toggle)
app.use(express.json());
// simple cookie reader (avoids extra dependency)
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

//TO DO: Insert code for Session Middleware below 
app.use(session({
    secret: 'secret',
    resave: false,
    saveUninitialized: true,
    // Session expires after 1 week of inactivity
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } 
}));

app.use(flash());

// expose user and cart count to all views
app.use((req, res, next) => {
    res.locals.user = req.session.user;
    const cart = req.session.cart || [];
    res.locals.cartCount = cart.reduce((sum, item) => sum + (item.quantity || 0), 0);
    next();
});

// Middleware to check if user is logged in
const checkAuthenticated = (req, res, next) => {
    if (req.session.user) {
        return next();
    } else {
        req.flash('error', 'Please log in to view this resource');
        res.redirect('/login');
    }
};

// Middleware to check if user is admin
const checkAdmin = (req, res, next) => {
    // ensure user exists before checking role
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    } else {
        req.flash('error', 'Access denied');
        res.redirect('/shopping');
    }
};

// Middleware for form validation
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

// Define routes
app.get('/',  (req, res) => {
    connection.query('SELECT * FROM products LIMIT 8', (error, results) => {
        if (error) {
            console.error('DB error / home:', error);
            return res.render('index', { user: req.session.user, products: [] });
        }
        res.render('index', {user: req.session.user, products: results || []} );
    });
});

// Admin-only routes
app.get('/admin/dashboard', checkAuthenticated, checkAdmin, adminController.dashboard);
app.get('/admin/users', checkAuthenticated, checkAdmin, adminController.listUsers);
app.post('/admin/users/:id/update', checkAuthenticated, checkAdmin, adminController.updateUserInfo);
app.post('/admin/users/:id/delete', checkAuthenticated, checkAdmin, adminController.removeUser);
app.get('/admin/orders', checkAuthenticated, checkAdmin, orderController.listAll);
app.post('/admin/orders/:id/status', checkAuthenticated, checkAdmin, orderController.updateStatus);
app.get('/admin/orders/:id/invoice', checkAuthenticated, checkAdmin, orderController.invoice);
app.get('/admin/reviews', checkAuthenticated, checkAdmin, adminReviewController.list);
app.post('/admin/reviews/:id/update', checkAuthenticated, checkAdmin, adminReviewController.reply);
app.post('/admin/reviews/:id/delete', checkAuthenticated, checkAdmin, adminReviewController.remove);

// Forgot password
app.get('/forgot-password', (req, res) => {
    res.render('forgotPassword', {
        errors: req.flash('error'),
        messages: req.flash('success'),
        user: req.session.user
    });
});
app.post('/forgot-password', (req, res) => {
    const { email } = req.body;
    if (!email) {
        req.flash('error', 'Email is required');
        return res.redirect('/forgot-password');
    }
    res.render('resetPassword', {
        email,
        errors: [],
        messages: [],
        user: req.session.user
    });
});

app.post('/reset-password', (req, res) => {
    const { email, password, confirmPassword } = req.body;
    if (!email || !password || !confirmPassword) {
        req.flash('error', 'All fields are required');
        return res.redirect('/forgot-password');
    }
    if (password !== confirmPassword) {
        req.flash('error', 'Passwords do not match');
        return res.redirect('/forgot-password');
    }
    if (password.length < 6) {
        req.flash('error', 'Password must be at least 6 characters');
        return res.redirect('/forgot-password');
    }
    connection.query('UPDATE users SET password = SHA1(?) WHERE email = ?', [password, email], (error, result) => {
        if (error) {
            console.error('DB error /reset-password:', error);
            req.flash('error', 'Database error');
            return res.redirect('/forgot-password');
        }
        if (result.affectedRows === 0) {
            req.flash('error', 'Email not found');
            return res.redirect('/forgot-password');
        }
        req.flash('success', 'Password updated. Please log in.');
        res.redirect('/login');
    });
});

app.get('/inventory', checkAuthenticated, checkAdmin, (req, res) => {
    // Fetch data from MySQL
    connection.query('SELECT * FROM products', (error, results) => {
      if (error) {
          console.error('DB error /inventory:', error);
          return res.status(500).send('Database error');
      }
      const lowStock = results.filter(p => Number(p.stock) < 20);
      res.render('inventory', { products: results, user: req.session.user, lowStock });
  });
});

// Quick stock update from inventory table
app.post('/inventory/:id/stock', checkAuthenticated, checkAdmin, (req, res) => {
    const productId = req.params.id;
    const newStock = parseInt(req.body.stock, 10);
    if (Number.isNaN(newStock) || newStock < 0) {
        return res.status(400).send('Invalid stock value');
    }
    connection.query('UPDATE products SET stock = ? WHERE id = ?', [newStock, productId], (error) => {
        if (error) {
            console.error('DB error /inventory stock update:', error);
            return res.status(500).send('Database error');
        }
        res.redirect('/inventory');
    });
});

app.get('/register', (req, res) => {
    res.render('register', { messages: req.flash('error'), formData: req.flash('formData')[0] });
});

app.post('/register', validateRegistration, (req, res) => {

    const { username, email, password, address, countryCode, contactNumber } = req.body;
    const role = 'user';
    const contact = (contactNumber || '').replace(/\D/g, '');

    // Check for duplicate username or email
    connection.query('SELECT username, email FROM users WHERE username = ? OR email = ? LIMIT 1', [username, email], (checkErr, rows) => {
        if (checkErr) {
            console.error('DB error /register check:', checkErr);
            req.flash('error', 'Registration failed. Try again.');
            return res.redirect('/register');
        }
        if (rows && rows.length > 0) {
            const conflict = rows[0];
            if (conflict.username === username) {
                req.flash('error', 'Username exists');
            } else if (conflict.email === email) {
                req.flash('error', 'Email has been registered');
            } else {
                req.flash('error', 'Account already exists.');
            }
            req.flash('formData', req.body);
            return res.redirect('/register');
        }

        const sql = 'INSERT INTO users (username, email, password, address, contact, role) VALUES (?, ?, SHA1(?), ?, ?, ?)';
        connection.query(sql, [username, email, password, address, contact, role], (err, result) => {
            if (err) {
                console.error('DB error /register:', err);
                req.flash('error', 'Registration failed. Try again.');
                return res.redirect('/register');
            }
            console.log(result);
            req.flash('success', 'Registration successful! Please log in.');
            res.redirect('/login');
        });
    });
});

app.get('/login', (req, res) => {
    res.render('login', { messages: req.flash('success'), errors: req.flash('error') });
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        req.flash('error', 'All fields are required.');
        return res.redirect('/login');
    }

    const sql = 'SELECT * FROM users WHERE email = ? AND password = SHA1(?)';
    connection.query(sql, [email, password], (err, results) => {
        if (err) {
            console.error('DB error /login:', err);
            req.flash('error', 'Login failed. Try again later.');
            return res.redirect('/login');
        }

        if (results.length > 0) {
            if ((results[0].role || '').toLowerCase() === 'deleted') {
                req.flash('error', 'This account has been deleted.');
                return res.redirect('/login');
            }
            req.session.user = results[0]; 
            // restore cart from cookie if exists
            const savedCart = req.cookies && req.cookies.savedCart;
            if (savedCart) {
                try {
                    const parsed = JSON.parse(savedCart);
                    if (Array.isArray(parsed)) req.session.cart = parsed;
                } catch (e) {}
                res.setClientCookie('savedCart', '', { maxAge: 1 }); // clear
            }
            req.flash('success', 'Login successful!');
            if(req.session.user.role == 'user')
                return res.redirect('/shopping');
            else
                return res.redirect('/inventory');
        } else {
            req.flash('error', 'Invalid email or password.');
            return res.redirect('/login');
        }
    });
});

app.get('/shopping', checkAuthenticated, favoriteController.getIds, (req, res) => {
    const sql = `
      SELECT p.*,
             COALESCE(AVG(r.rating),0) AS avgRating,
             COUNT(r.id) AS reviewCount
      FROM products p
      LEFT JOIN reviews r ON r.productId = p.id
      GROUP BY p.id
      ORDER BY p.id DESC
    `;
    connection.query(sql, (error, results) => {
        if (error) {
            console.error('DB error /shopping:', error);
            return res.status(500).send('Database error');
        }
        res.render('shopping', { user: req.session.user, products: results, favoriteIds: res.locals.favoriteIds || [] });
    });
});

app.get('/favorites', checkAuthenticated, favoriteController.list);
app.post('/favorites/:productId/toggle', checkAuthenticated, favoriteController.toggle);
app.get('/reviews', checkAuthenticated, reviewController.list);
app.post('/reviews', checkAuthenticated, reviewController.create);

app.get('/account', checkAuthenticated, (req, res) => {
    res.render('account', { user: req.session.user, messages: req.flash('success'), errors: req.flash('error') });
});

app.post('/account', checkAuthenticated, (req, res) => {
    const { username, address, contact } = req.body;
    if (!username || !address || !contact) {
        req.flash('error', 'All fields are required.');
        return res.redirect('/account');
    }
    const digits = (contact || '').replace(/\D/g, '');
    if (digits.length !== 8) {
        req.flash('error', 'Contact number must be 8 digits.');
        return res.redirect('/account');
    }
    const userId = req.session.user.id;
    const sql = 'UPDATE users SET username = ?, address = ?, contact = ? WHERE id = ?';
    connection.query(sql, [username, address, digits, userId], (err) => {
        if (err) {
            console.error('DB error /account update:', err);
            req.flash('error', 'Could not update account.');
            return res.redirect('/account');
        }
        // update session user
        req.session.user.username = username;
        req.session.user.address = address;
        req.session.user.contact = digits;
        req.flash('success', 'Account updated.');
        res.redirect('/account');
    });
});

app.post('/add-to-cart/:id', checkAuthenticated, (req, res) => {
    const productId = parseInt(req.params.id, 10);
    const quantity = parseInt(req.body.quantity, 10) || 1;
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.xhr;
    const isBuy = (req.query.buy === '1') || (req.body.buy === '1');

    const calculateCartTotal = (cartArr) => cartArr.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    connection.query('SELECT * FROM products WHERE id = ?', [productId], (error, results) => {
        if (error) {
            console.error('DB error /add-to-cart:', error);
            return wantsJson ? res.status(500).json({ success: false, message: 'Database error' }) : res.status(500).send('Database error');
        }

        if (results.length > 0) {
            const product = results[0];

            // Initialize cart in session if not exists
            if (!req.session.cart) {
                req.session.cart = [];
            }

            // Check if product already in cart
            const existingItem = req.session.cart.find(item => item.productId === productId);
            if (existingItem) {
                existingItem.quantity += quantity;
            } else {
                req.session.cart.push({
                    // use DB id column
                    productId: product.id,
                    productName: product.productName,
                    price: product.price,
                    quantity: quantity,
                    image: product.image
                });
            }

            // update cartCount local
            res.locals.cartCount = req.session.cart.reduce((sum, item) => sum + (item.quantity || 0), 0);

            if (wantsJson) {
                return res.json({ success: true, cartTotal: calculateCartTotal(req.session.cart) });
            }
            if (isBuy) {
                return res.redirect('/cart');
            }
            return res.redirect('/shopping');
        } else {
            return wantsJson ? res.status(404).json({ success: false, message: 'Product not found' }) : res.status(404).send("Product not found");
        }
    });
});

// Update quantity in cart
app.post('/cart/update/:id', checkAuthenticated, (req, res) => {
    const productId = parseInt(req.params.id, 10);
    const quantity = Math.max(1, parseInt(req.body.quantity, 10) || 1);
    const cart = req.session.cart || [];
    const item = cart.find(i => i.productId === productId);
    if (!item) return res.status(404).json({ success: false, message: 'Item not found' });
    item.quantity = quantity;
    const cartTotal = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const cartCount = cart.reduce((sum, i) => sum + (i.quantity || 0), 0);
    req.session.cart = cart;
    res.json({ success: true, quantity, lineTotal: (item.price * item.quantity).toFixed(2), cartTotal: cartTotal.toFixed(2), cartCount });
});

// Delete item from cart
app.post('/cart/delete/:id', checkAuthenticated, (req, res) => {
    const productId = parseInt(req.params.id, 10);
    let cart = req.session.cart || [];
    cart = cart.filter(i => i.productId !== productId);
    req.session.cart = cart;
    const cartTotal = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const cartCount = cart.reduce((sum, i) => sum + (i.quantity || 0), 0);
    res.json({ success: true, cartTotal: cartTotal.toFixed(2), cartCount });
});

app.get('/cart', checkAuthenticated, (req, res) => {
    const cart = req.session.cart || [];
    res.render('cart', { cart, user: req.session.user });
});

// store selected cart items for checkout
app.post('/cart/select', checkAuthenticated, (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const parsed = ids.map(x => parseInt(x, 10)).filter(n => !Number.isNaN(n));
    req.session.checkoutSelection = parsed;
    res.json({ success: true });
});

app.get('/checkout', checkAuthenticated, (req, res) => {
    const cart = req.session.cart || [];
    if (!cart.length) {
        req.flash('error', 'Your cart is empty');
        return res.redirect('/cart');
    }
    const sel = Array.isArray(req.session.checkoutSelection) ? req.session.checkoutSelection : [];
    const cartForCheckout = sel.length ? cart.filter(item => sel.includes(Number(item.productId))) : cart;
    if (!cartForCheckout.length) {
        req.flash('error', 'No items selected for checkout.');
        return res.redirect('/cart');
    }
    const shipping = req.session.checkoutShipping || {
        contact: req.session.user ? req.session.user.contact : '',
        address: req.session.user ? req.session.user.address : '',
        option: 'pickup',
        payment: 'paynow'
    };
    // apply user defaults if missing
    if (!shipping.contact && req.session.user && req.session.user.contact) {
        shipping.contact = req.session.user.contact;
    }
    if (!shipping.address && req.session.user && req.session.user.address) {
        shipping.address = req.session.user.address;
    }
    const cardDraft = req.session.cardDraft || {};
    const shippingCost = shipping.option === 'delivery' ? 2.0 : 0;
    const subtotal = cartForCheckout.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const totalQuantity = cartForCheckout.reduce((sum, item) => sum + item.quantity, 0);
    const total = subtotal + shippingCost;
    res.render('checkout', {
        cart: cartForCheckout,
        user: req.session.user,
        shipping,
        cardDraft,
        shippingCost,
        subtotal,
        total,
        totalQuantity
    });
});

app.post('/checkout/shipping', checkAuthenticated, (req, res) => {
    const { contact, address } = req.body;
    if (!req.session.checkoutShipping) req.session.checkoutShipping = {};
    req.session.checkoutShipping.contact = contact || '';
    req.session.checkoutShipping.address = address || '';
    res.json({ success: true, contact, address });
});

app.post('/checkout/option', checkAuthenticated, (req, res) => {
    const { option } = req.body;
    if (!req.session.checkoutShipping) req.session.checkoutShipping = {};
    req.session.checkoutShipping.option = option === 'delivery' ? 'delivery' : 'pickup';
    res.json({ success: true, option: req.session.checkoutShipping.option });
});

app.post('/checkout/payment', checkAuthenticated, (req, res) => {
    const { payment } = req.body;
    if (!req.session.checkoutShipping) req.session.checkoutShipping = {};
    req.session.checkoutShipping.payment = payment === 'card' ? 'card' : 'paynow';
    res.json({ success: true, payment: req.session.checkoutShipping.payment });
});

app.post('/place-order', checkAuthenticated, (req, res) => {
    const cart = req.session.cart || [];
    const sel = Array.isArray(req.session.checkoutSelection) ? req.session.checkoutSelection.map(n=>Number(n)) : [];
    const cartForOrder = sel.length ? cart.filter(item => sel.includes(Number(item.productId))) : cart;
    if (!cartForOrder.length) {
        req.flash('error', 'No items selected for checkout');
        return res.redirect('/cart');
    }
    if (!cart.length) {
        req.flash('error', 'Your cart is empty');
        return res.redirect('/cart');
    }
    const shipping = req.session.checkoutShipping || { option: 'pickup', payment: 'paynow', contact: '', address: '' };
    // fill defaults if absent
    if (!shipping.contact && req.session.user && req.session.user.contact) {
        shipping.contact = req.session.user.contact;
    }
    if (!shipping.address && req.session.user && req.session.user.address) {
        shipping.address = req.session.user.address;
    }
    // persist latest shipping snapshot so it is available if user returns after a failure
    req.session.checkoutShipping = shipping;
    const shippingCost = shipping.option === 'delivery' ? 2.0 : 0;
    const subtotal = cartForOrder.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const totalQuantity = cartForOrder.reduce((sum, item) => sum + (item.quantity || 0), 0);
    const total = subtotal + shippingCost;

    const paymentMethod = req.body.paymentMethod || shipping.payment || 'paynow';
    const cardYear = req.body.cardYear;
    if (paymentMethod === 'card') {
        req.session.cardDraft = {
            cardNumber: req.body.cardNumber || '',
            cardCvv: req.body.cardCvv || '',
            cardName: req.body.cardName || '',
            cardBilling: req.body.cardBilling || '',
            cardYear: req.body.cardYear || '',
            cardMonth: req.body.cardMonth || ''
        };
    } else {
        req.session.cardDraft = null;
    }
    let status = 'payment successful';
    const yearNum = Number(cardYear);
    if (paymentMethod === 'card' && yearNum && yearNum <= 2025) {
        status = 'payment failed';
    }

    const orderPayload = {
        userId: req.session.user.id,
        total,
        paymentMethod,
        deliveryType: shipping.option,
        address: shipping.address,
        status
    };

    Order.create(orderPayload, (err, orderId) => {
        if (err) {
            console.error('DB error /place-order:', err);
            req.flash('error', 'Could not place order.');
            return res.redirect('/cart');
        }
        // persist items to order_items if table exists
        OrderItem.createMany(orderId, cartForOrder, (itemErr) => {
            if (itemErr) {
                console.error('DB error inserting order_items:', itemErr);
            }
        });
        const adjustStock = (done) => {
            if (status === 'payment failed') return done();
            let pending = cartForOrder.length;
            if (!pending) return done();
            cartForOrder.forEach(it => {
                const qty = Number(it.quantity) || 0;
                if (!qty) {
                    if (--pending === 0) done();
                    return;
                }
                connection.query('UPDATE products SET stock = GREATEST(stock - ?, 0) WHERE id = ?', [qty, it.productId], (updErr) => {
                    if (updErr) console.error('DB error decrementing stock:', updErr);
                    if (--pending === 0) done();
                });
            });
        };
        req.session.lastOrder = {
            id: orderId,
            items: cartForOrder,
            shipping,
            subtotal,
            shippingCost,
            total,
            totalQuantity,
            date: new Date().toISOString()
        };
        if (!req.session.orderSummary) req.session.orderSummary = {};
        req.session.orderSummary[orderId] = {
            image: cartForOrder[0] ? cartForOrder[0].image : null,
            qty: totalQuantity
        };
        // keep lastOrder populated so immediate redirect pages can show items
        req.session.lastOrder = req.session.lastOrder || {};
        req.session.lastOrder.items = cartForOrder;
        req.session.checkoutSelection = [];
        req.session.lastOrder.totalQuantity = totalQuantity;
        const goSuccess = () => {
            req.session.cardDraft = null;
            req.session.cart = [];
            res.locals.cartCount = 0;
            res.redirect(`/orders/success?id=${orderId}`);
        };

        if (status === 'payment failed') {
            // keep cart so user can retry from checkout
            res.locals.cartCount = req.session.cart.reduce((sum, i) => sum + (i.quantity || 0), 0);
            res.redirect(`/orders/fail?id=${orderId}`);
        } else {
            adjustStock(goSuccess);
        }
    });
});

app.get('/orders', checkAuthenticated, (req, res) => {
    orderController.listUserOrders(req, res);
});

app.get('/orders/success', checkAuthenticated, (req, res) => {
    const id = req.query.id || (req.session.lastOrder && req.session.lastOrder.id);
    res.render('orderSuccess', { orderId: id || '' });
});

app.get('/orders/fail', checkAuthenticated, (req, res) => {
    const id = req.query.id || (req.session.lastOrder && req.session.lastOrder.id);
    res.render('orderFail', { orderId: id || '' });
});

app.get('/admin/orders/:id', checkAuthenticated, checkAdmin, orderController.detail);
app.get('/orders/:id', checkAuthenticated, orderController.detail);
app.get('/orders/:id/invoice', checkAuthenticated, orderController.invoice);

app.get('/logout', (req, res) => {
    const cartSnapshot = req.session.cart || [];
    req.session.destroy(() => {
        // store in cookie for later restoration
        res.setClientCookie('savedCart', JSON.stringify(cartSnapshot), { maxAge: 7*24*60*60*1000 });
        res.redirect('/');
    });
});

app.get('/product/:id', checkAuthenticated, (req, res) => {
  const productId = req.params.id;
  const productSql = `
    SELECT p.*,
           COALESCE(AVG(r.rating),0) AS avgRating,
           COUNT(r.id) AS reviewCount
    FROM products p
    LEFT JOIN reviews r ON r.productId = p.id
    WHERE p.id = ?
  `;
  connection.query(productSql, [productId], (error, results) => {
      if (error) {
          console.error('DB error /product/:id:', error);
          return res.status(500).send('Database error');
      }
      if (!results.length) return res.status(404).send('Product not found');
      const product = results[0];
      connection.query(
        'SELECT r.*, IFNULL(r.reply, \"\") AS reply, u.username FROM reviews r LEFT JOIN users u ON u.id = r.userId WHERE r.productId = ? ORDER BY r.created_at DESC, r.id DESC',
        [productId],
        (revErr, reviewRows) => {
          if (revErr) {
            console.error('DB error /product/:id reviews:', revErr);
            return res.render('product', { product, user: req.session.user, reviews: [] });
          }
          res.render('product', { product, user: req.session.user, reviews: reviewRows || [] });
        }
      );
  });
});

app.get('/addProduct', checkAuthenticated, checkAdmin, (req, res) => {
    res.render('addProduct', {user: req.session.user } ); 
});

app.post('/addProduct', checkAuthenticated, checkAdmin, upload.single('image'),  (req, res) => {
    // Extract product data from the request body
    const { name, stock, price, category, description, dietary } = req.body;
    if (!name || !stock || !price || !category || !description || !dietary) {
        req.flash('error', 'All fields are required');
        return res.redirect('/addProduct');
    }
    let image = req.file ? req.file.filename : null;

    const sql = 'INSERT INTO products (productName, stock, price, image, category, description, dietary) VALUES (?, ?, ?, ?, ?, ?, ?)';
    // Insert the new product into the database
    connection.query(sql , [name, stock, price, image, category, description, dietary], (error, results) => {
        if (error) {
            // Handle any error that occurs during the database operation
            console.error("Error adding product:", error);
            res.status(500).send('Error adding product');
        } else {
            // Send a success response
            res.redirect('/inventory');
        }
    });
});

// Legacy update route kept for backward compatibility
app.get('/updateProduct/:id', checkAuthenticated, checkAdmin, (req, res) => {
    const productId = req.params.id;
    const sql = 'SELECT * FROM products WHERE id = ?';

    connection.query(sql , [productId], (error, results) => {
        if (error) {
            console.error('DB error /updateProduct GET:', error);
            return res.status(500).send('Database error');
        }

        if (results.length > 0) {
            // Render HTML page with the product data
            return res.render('updateProduct', { product: results[0] });
        }

        return res.status(404).send('Product not found');
    });
});

app.post('/updateProduct/:id', checkAuthenticated, checkAdmin, upload.single('image'), (req, res) => {
    const productId = req.params.id;
    // Extract product data from the request body
    const { name, stock, price, category, description, dietary } = req.body;
    if (!name || !stock || !price || !category || !description || !dietary) {
        req.flash('error', 'All fields are required');
        return res.redirect(`/updateProduct/${productId}`);
    }
    let image  = req.body.currentImage; //retrieve current image filename
    if (req.file) { //if new image is uploaded
        image = req.file.filename; // set image to be new image filename
    } 

    const sql = 'UPDATE products SET productName = ? , stock = ?, price = ?, image = ?, category = ?, description = ?, dietary = ? WHERE id = ?';
    // Insert the new product into the database
    connection.query(sql, [name, stock, price, image, category, description, dietary, productId], (error, results) => {
        if (error) {
            // Handle any error that occurs during the database operation
            console.error("Error updating product:", error);
            res.status(500).send('Error updating product');
        } else {
            // Send a success response
            res.redirect('/inventory');
        }
    });
});

// Preferred edit routes (mirror updateProduct)
app.get('/editProduct/:id', checkAuthenticated, checkAdmin, (req, res) => {
    const productId = req.params.id;
    connection.query('SELECT * FROM products WHERE id = ?', [productId], (error, results) => {
        if (error) {
            console.error('DB error /editProduct GET:', error);
            return res.status(500).send('Database error');
        }
        if (results.length > 0) {
            return res.render('editProduct', { product: results[0], user: req.session.user });
        }
        return res.status(404).send('Product not found');
    });
});

app.post('/editProduct/:id', checkAuthenticated, checkAdmin, upload.single('image'), (req, res) => {
    const productId = req.params.id;
    const { name, stock, price, category, description, dietary } = req.body;
    if (!name || !stock || !price || !category || !description || !dietary) {
        req.flash('error', 'All fields are required');
        return res.redirect(`/editProduct/${productId}`);
    }
    let image = req.body.currentImage;
    if (req.file) {
        image = req.file.filename;
    }
    const sql = 'UPDATE products SET productName = ? , stock = ?, price = ?, image = ?, category = ?, description = ?, dietary = ? WHERE id = ?';
    connection.query(sql, [name, stock, price, image, category, description, dietary, productId], (error) => {
        if (error) {
            console.error('DB error /editProduct POST:', error);
            return res.status(500).send('Error updating product');
        }
        res.redirect('/inventory');
    });
});

app.get('/deleteProduct/:id', checkAuthenticated, checkAdmin, (req, res) => {
    const productId = req.params.id;
    // remove dependent rows first to satisfy FK constraints (reviews, favorites, order_items if present)
    const steps = [
      ['DELETE FROM reviews WHERE productId = ?', [productId]],
      ['DELETE FROM favorites WHERE productId = ?', [productId]],
      ['DELETE FROM order_items WHERE productId = ?', [productId]],
      ['DELETE FROM products WHERE id = ?', [productId]]
    ];

    const runStep = (idx) => {
      if (idx >= steps.length) return res.redirect('/inventory');
      const [sql, params] = steps[idx];
      connection.query(sql, params, (error) => {
        if (error) {
          console.error("Error deleting product dependency:", error);
          return res.status(500).send("Error deleting product");
        }
        runStep(idx + 1);
      });
    };
    runStep(0);
});

// User self delete (mark as deleted)
app.post('/account/delete', checkAuthenticated, (req, res) => {
    const userId = req.session.user.id;
    connection.query('UPDATE users SET role = "deleted" WHERE id = ?', [userId], (error) => {
        if (error) {
            console.error('DB error /account/delete:', error);
            req.flash('error', 'Could not delete account.');
            return res.redirect('/account');
        }
        req.session.destroy(() => {
            res.redirect('/login');
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
