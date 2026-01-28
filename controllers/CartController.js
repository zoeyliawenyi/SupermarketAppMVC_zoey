const Product = require('../models/Product');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Cart = require('../models/Cart');

const CartController = {
    showCart: (req, res) => {
        Cart.getByUserId(req.session.user.id, (err, cart) => {
            if (err) {
                console.error('Show cart error:', err);
                return res.render('cart', { cart: [], user: req.session.user });
            }
            res.render('cart', { cart: cart || [], user: req.session.user });
        });
    },

    addToCart: (req, res) => {
        const userId = req.session.user.id;
        const productId = parseInt(req.params.id, 10);
        const quantity = parseInt(req.body.quantity, 10) || 1;
        const wantsJson = (req.get('accept') || '').includes('application/json') || req.xhr;
        const isBuy = (req.query.buy === '1') || (req.body.buy === '1');

        Cart.addItem(userId, productId, quantity, (err) => {
            if (err) {
                console.error('Add to cart error:', err);
                return wantsJson ? res.status(500).json({ success: false, message: 'Database error' }) : res.status(500).send("Database error");
            }

            if (wantsJson) {
                Cart.getByUserId(userId, (getErr, cart) => {
                    const total = (cart || []).reduce((sum, item) => sum + (item.price * item.quantity), 0);
                    const count = (cart || []).reduce((sum, item) => sum + item.quantity, 0);
                    return res.json({ success: true, cartTotal: total, cartCount: count });
                });
            } else {
                res.redirect(isBuy ? '/cart' : '/shopping');
            }
        });
    },

    updateCart: (req, res) => {
        const userId = req.session.user.id;
        const productId = parseInt(req.params.id, 10);
        const quantity = Math.max(1, parseInt(req.body.quantity, 10) || 1);

        Cart.updateQuantity(userId, productId, quantity, (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Database error' });
            
            Cart.getByUserId(userId, (getErr, cart) => {
                const item = (cart || []).find(i => i.productId === productId);
                const cartTotal = (cart || []).reduce((sum, i) => sum + i.price * i.quantity, 0);
                const cartCount = (cart || []).reduce((sum, i) => sum + i.quantity, 0);
                res.json({ 
                    success: true, 
                    quantity, 
                    lineTotal: item ? (item.price * item.quantity).toFixed(2) : '0.00', 
                    cartTotal: cartTotal.toFixed(2), 
                    cartCount 
                });
            });
        });
    },

    deleteFromCart: (req, res) => {
        const userId = req.session.user.id;
        const productId = parseInt(req.params.id, 10);

        Cart.removeItem(userId, productId, (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Database error' });
            
            Cart.getByUserId(userId, (getErr, cart) => {
                const cartTotal = (cart || []).reduce((sum, i) => sum + i.price * i.quantity, 0);
                const cartCount = (cart || []).reduce((sum, i) => sum + i.quantity, 0);
                res.json({ success: true, cartTotal: cartTotal.toFixed(2), cartCount });
            });
        });
    },

    selectItems: (req, res) => {
        const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
        req.session.checkoutSelection = ids.map(x => parseInt(x, 10)).filter(n => !Number.isNaN(n));
        res.json({ success: true });
    },

    showCheckout: (req, res) => {
        Cart.getByUserId(req.session.user.id, (err, cart) => {
            if (err || !cart || cart.length === 0) {
                req.flash('error', 'Your cart is empty');
                return res.redirect('/cart');
            }

            const sel = req.session.checkoutSelection || [];
            const cartForCheckout = sel.length ? cart.filter(item => sel.includes(Number(item.productId))) : cart;
            
            if (!cartForCheckout.length) {
                req.flash('error', 'No items selected for checkout.');
                return res.redirect('/cart');
            }

            const shipping = req.session.checkoutShipping || {
                contact: req.session.user.contact || '',
                address: req.session.user.address || '',
                option: 'pickup',
                payment: 'nets-qr'
            };
            if (shipping.payment === 'paynow') shipping.payment = 'nets-qr';
            const shippingCost = shipping.option === 'delivery' ? 2.0 : 0;
            const subtotal = cartForCheckout.reduce((sum, item) => sum + item.price * item.quantity, 0);
            const totalQuantity = cartForCheckout.reduce((sum, item) => sum + item.quantity, 0);
            
            res.render('checkout', {
                cart: cartForCheckout,
                user: req.session.user,
                shipping,
                cardDraft: req.session.cardDraft || {},
                shippingCost,
                subtotal,
                total: subtotal + shippingCost,
                totalQuantity
            });
        });
    },

    updateShipping: (req, res) => {
        const { contact, address } = req.body;
        if (!req.session.checkoutShipping) req.session.checkoutShipping = {};
        req.session.checkoutShipping.contact = contact || '';
        req.session.checkoutShipping.address = address || '';
        res.json({ success: true, contact, address });
    },

    updateOption: (req, res) => {
        const { option } = req.body;
        if (!req.session.checkoutShipping) req.session.checkoutShipping = {};
        req.session.checkoutShipping.option = option === 'delivery' ? 'delivery' : 'pickup';
        res.json({ success: true, option: req.session.checkoutShipping.option });
    },

    updatePayment: (req, res) => {
        const { payment } = req.body;
        if (!req.session.checkoutShipping) req.session.checkoutShipping = {};
        req.session.checkoutShipping.payment = payment === 'card' ? 'card' : 'nets-qr';
        res.json({ success: true, payment: req.session.checkoutShipping.payment });
    },

    placeOrder: (req, res) => {
        const userId = req.session.user.id;
        Cart.getByUserId(userId, (err, cart) => {
            if (err || !cart || cart.length === 0) {
                req.flash('error', 'Your cart is empty');
                return res.redirect('/cart');
            }

            const sel = req.session.checkoutSelection || [];
            const cartForOrder = sel.length ? cart.filter(item => sel.includes(Number(item.productId))) : cart;
            
            if (!cartForOrder.length) {
                req.flash('error', 'No items selected for checkout');
                return res.redirect('/cart');
            }

            const shipping = req.session.checkoutShipping || { option: 'pickup', payment: 'nets-qr', contact: '', address: '' };
            const shippingCost = shipping.option === 'delivery' ? 2.0 : 0;
            const subtotal = cartForOrder.reduce((sum, item) => sum + item.price * item.quantity, 0);
            const total = subtotal + shippingCost;
            const paymentMethod = req.body.paymentMethod || shipping.payment || 'nets-qr';
            
            let status = 'payment successful';
            if (paymentMethod === 'card' && Number(req.body.cardYear) <= 2025) {
                status = 'payment failed';
            }

            const orderPayload = {
                userId: userId,
                total,
                paymentMethod,
                deliveryType: shipping.option,
                address: shipping.address || req.session.user.address,
                status
            };

            Order.create(orderPayload, (orderErr, orderId) => {
                if (orderErr) {
                    console.error('Place order error:', orderErr);
                    req.flash('error', 'Could not place order.');
                    return res.redirect('/cart');
                }

                OrderItem.createMany(orderId, cartForOrder, (itemErr) => {
                    if (itemErr) console.error('Order items creation error:', itemErr);
                    
                    if (status !== 'payment failed') {
                        // Decrement stock
                        let pending = cartForOrder.length;
                        cartForOrder.forEach(it => {
                            Product.decrementStock(it.productId, it.quantity, () => {
                                if (--pending === 0) finalize();
                            });
                        });
                    } else {
                        finalize();
                    }

                    function finalize() {
                        // Clear ordered items from DB cart
                        const orderedProductIds = cartForOrder.map(i => i.productId);
                        Cart.clearItems(userId, orderedProductIds, (clearErr) => {
                            if (clearErr) console.error('Clear cart error:', clearErr);
                            
                            req.session.lastOrder = { id: orderId, items: cartForOrder };
                            req.session.checkoutSelection = [];
                            res.redirect(status !== 'payment failed' ? `/orders/success?id=${orderId}` : `/orders/fail?id=${orderId}`);
                        });
                    }
                });
            });
        });
    }
};

module.exports = CartController;
