const Product = require('../models/Product');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Cart = require('../models/Cart');
const User = require('../models/User');
const UserSubscription = require('../models/UserSubscription');
const { normalizeStatus, isPendingPaymentStatus } = require('../utils/status');

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
                if (isBuy) {
                    req.session.checkoutSelection = [productId];
                }
                res.redirect(isBuy ? '/checkout' : '/shopping');
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
        const pendingOrderId =
            req.session.pendingStripeOrder?.orderId ||
            req.session.pendingPaypalOrderId ||
            req.session.pendingNetsOrderId ||
            null;
        let pendingPaymentOrderId = null;
        let pendingPaymentStatus = null;

        const proceedCheckout = () => {
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
                contact: '',
                address: '',
                option: 'pickup',
                payment: 'nets-qr'
            };
            if (!shipping.contact) shipping.contact = req.session.user.contact || '';
            if (!shipping.address) shipping.address = req.session.user.address || '';
            if (!shipping.option) shipping.option = 'pickup';
            if (!shipping.payment) shipping.payment = 'nets-qr';
            if (shipping.payment === 'paynow') shipping.payment = 'nets-qr';
            const refreshAndRender = (freshUser, subscriptionRow) => {
                if (freshUser) req.session.user = { ...req.session.user, ...freshUser };
                let subActive = false;
                if (subscriptionRow) {
                    const subStatus = (subscriptionRow.status || '').toLowerCase();
                    if (['active', 'trialing'].includes(subStatus)) {
                        req.session.user.zozoPlusStatus = 'active';
                        subActive = true;
                    }
                    if (subscriptionRow.currentPeriodEnd) {
                        req.session.user.zozoPlusCurrentPeriodEnd = subscriptionRow.currentPeriodEnd;
                    }
                }
                const isZozoPlusActive = subActive || (req.session.user?.zozoPlusStatus || '').toLowerCase() === 'active';
                const shippingCost = shipping.option === 'delivery' && !isZozoPlusActive ? 2.0 : 0;
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
                    totalQuantity,
                    freeDeliveryApplied: isZozoPlusActive && shipping.option === 'delivery',
                    pendingPaymentOrderId,
                    pendingPaymentStatus
                });
            };
            User.findById(req.session.user.id, (uErr, freshUser) => {
                if (uErr) {
                    console.error('Checkout user refresh error:', uErr);
                    return refreshAndRender(null, null);
                }
                UserSubscription.findByUserId(req.session.user.id, (sErr, subRow) => {
                    if (sErr) {
                        console.error('Checkout subscription refresh error:', sErr);
                        return refreshAndRender(freshUser, null);
                    }
                    return refreshAndRender(freshUser, subRow);
                });
            });
            });
        };

        if (!pendingOrderId) return proceedCheckout();

        Order.findByIdWithAgg(pendingOrderId, (findErr, pendingOrder) => {
            if (findErr || !pendingOrder) return proceedCheckout();
            const statusKey = normalizeStatus(pendingOrder.status || '');
            if (isPendingPaymentStatus(statusKey)) {
                pendingPaymentOrderId = pendingOrder.id;
                pendingPaymentStatus = statusKey;
            } else if (statusKey === 'payment_failed') {
                req.session.pendingStripeOrder = null;
                req.session.pendingPaypalOrderId = null;
                req.session.pendingPaypalOrder = null;
                req.session.pendingNetsOrderId = null;
            }
            return proceedCheckout();
        });
    },

    updateShipping: (req, res) => {
        const { contact, address } = req.body;
        if (!req.session.checkoutShipping) req.session.checkoutShipping = {};
        if (contact !== undefined) req.session.checkoutShipping.contact = contact || '';
        if (address !== undefined) req.session.checkoutShipping.address = address || '';

        const userId = req.session.user?.id;
        const nextAddress = (address !== undefined ? (address || '') : (req.session.user?.address || ''));
        const nextContact = (contact !== undefined ? (contact || '') : (req.session.user?.contact || ''));
        if (!userId) return res.json({ success: true, contact, address });

        User.updateShipping(userId, { address: nextAddress, contact: nextContact }, (err) => {
            if (err) {
                console.error('Update shipping error:', err);
                return res.status(500).json({ success: false, message: 'Unable to update address' });
            }
            req.session.user.address = nextAddress;
            req.session.user.contact = nextContact;
            res.json({ success: true, contact: nextContact, address: nextAddress });
        });
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
        if (payment === 'card') req.session.checkoutShipping.payment = 'card';
        if (payment === 'paypal') req.session.checkoutShipping.payment = 'paypal';
        if (payment === 'stripe') req.session.checkoutShipping.payment = 'stripe';
        if (payment !== 'card' && payment !== 'paypal' && payment !== 'stripe') req.session.checkoutShipping.payment = 'nets-qr';
        res.json({ success: true, payment: req.session.checkoutShipping.payment });
    },

    placeOrder: (req, res) => {
        const userId = req.session.user.id;
        const wantsJson = (req.get('accept') || '').includes('application/json');
        Cart.getByUserId(userId, (err, cart) => {
            if (err || !cart || cart.length === 0) {
                if (wantsJson) return res.status(400).json({ success: false, message: 'Your cart is empty' });
                req.flash('error', 'Your cart is empty');
                return res.redirect('/cart');
            }

            const sel = req.session.checkoutSelection || [];
            const cartForOrder = sel.length ? cart.filter(item => sel.includes(Number(item.productId))) : cart;
            
            if (!cartForOrder.length) {
                if (wantsJson) return res.status(400).json({ success: false, message: 'No items selected for checkout' });
                req.flash('error', 'No items selected for checkout');
                return res.redirect('/cart');
            }

            const shipping = req.session.checkoutShipping || { option: 'pickup', payment: 'nets-qr', contact: '', address: '' };
            const isZozoPlusActive = (req.session.user?.zozoPlusStatus || '').toLowerCase() === 'active';
            const shippingCost = shipping.option === 'delivery' && !isZozoPlusActive ? 2.0 : 0;
            const subtotal = cartForOrder.reduce((sum, item) => sum + item.price * item.quantity, 0);
            const total = subtotal + shippingCost;
            const paymentMethod = req.body.paymentMethod || shipping.payment || 'nets-qr';

            const msg = 'Please complete payment using the selected method before placing the order.';
            if (wantsJson) return res.status(400).json({ success: false, message: msg });
            req.flash('error', msg);
            return res.redirect('/checkout');
            
            let status = 'payment_successful';
            if (paymentMethod === 'card' && Number(req.body.cardYear) <= 2025) {
                status = 'payment_failed';
            }

            const paymentProvider =
                paymentMethod === 'paypal'
                    ? 'paypal'
                    : (paymentMethod === 'nets-qr' ? 'nets' : (paymentMethod === 'stripe' ? 'stripe' : null));

            const buildOrderPayload = (pickupCode) => ({
                userId: userId,
                total,
                paymentMethod,
                paymentProvider,
                deliveryType: shipping.option,
                address: shipping.address || req.session.user.address,
                pickupCode: pickupCode || null,
                pickupCodeStatus: pickupCode ? 'active' : null,
                pickupCodeRedeemedAt: null,
                status
            });

            const isPickup = (shipping.option || '').toLowerCase() === 'pickup';
            const createOrder = (pickupCode) => {
                const orderPayload = buildOrderPayload(pickupCode);
                Order.create(orderPayload, (orderErr, orderId) => {
                    if (orderErr) {
                        console.error('Place order error:', orderErr);
                        if (wantsJson) return res.status(500).json({ success: false, message: 'Could not place order.' });
                        req.flash('error', 'Could not place order.');
                        return res.redirect('/cart');
                    }

                    OrderItem.createMany(orderId, cartForOrder, (itemErr) => {
                        if (itemErr) console.error('Order items creation error:', itemErr);
                        
                        if (status !== 'payment_failed') {
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
                                const redirectUrl = status !== 'payment_failed' ? `/orders/success?id=${orderId}` : `/orders/fail?id=${orderId}`;
                                const responsePayload = {
                                    success: status !== 'payment_failed',
                                    orderId,
                                    status,
                                    redirect: redirectUrl
                                };
                                if (wantsJson) {
                                    return res.json(responsePayload);
                                }
                                res.redirect(redirectUrl);
                            });
                        }
                    });
                });
            };

            if (isPickup) {
                Order.generatePickupCode((codeErr, code) => {
                    if (codeErr) {
                        console.error('Pickup code error:', codeErr);
                        if (wantsJson) return res.status(500).json({ success: false, message: 'Could not place order.' });
                        req.flash('error', 'Could not place order.');
                        return res.redirect('/cart');
                    }
                    createOrder(code);
                });
            } else {
                createOrder(null);
            }
        });
    }
};

module.exports = CartController;
