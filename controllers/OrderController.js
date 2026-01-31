const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Refund = require('../models/Refund');
const Admin = require('../models/Admin');
const { normalizeStatus, isPendingPaymentStatus, isFailedPaymentStatus, isCancelledStatus, isPaidStatus } = require('../utils/status');
const paypalService = require('../services/paypal');
const netsController = require('./NetsController');

exports.listUserOrders = (req, res) => {
  const userId = req.session.user.id;
  Order.findByUser(userId, (err, results) => {
    if (err) {
      console.error('DB error /orders:', err);
      req.flash('error', 'Could not load orders.');
      return res.render('orders', { user: req.session.user, orders: [], filter: req.query.filter || 'all' });
    }
    if (results && results.length) {
      console.log('First order status:', results[0].status);
    }
    const summaries = (req.session.orderSummary) || {};
    const lastOrder = req.session.lastOrder;
    const ordersBase = (results || []).map(o => ({ ...o, id: Number(o.id) }));
    const ids = ordersBase.map(o => o.id);
    OrderItem.findByOrderIds(ids, (itemErr, items) => {
      if (itemErr) {
        console.error('DB error order_items lookup:', itemErr);
      }
      const grouped = {};
      (items || []).forEach(it => {
        const key = Number(it.orderId);
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(it);
      });
      const allItems = Object.values(grouped).flat();
      const needImgs = allItems.filter(it => !it.productImage && (it.productId || it.productName));
      const refundsByOrder = {};
      const attachRefunds = (next) => {
        if (!ids.length) return next();
        Refund.getLatestRefundsByOrderIds(ids, (refErr, refunds) => {
          if (refErr) console.error('DB error refund lookup:', refErr);
          (refunds || []).forEach(r => {
            refundsByOrder[Number(r.orderId)] = r;
          });
          next();
        });
      };

      const enrichAndRender = () => {
        const orders = ordersBase.map(o => {
          const cached = summaries[o.id] || {};
          const fallbackItems = (lastOrder && lastOrder.id == o.id) ? (lastOrder.items || []) : [];
          const fromDB = grouped[o.id] || [];
          const firstImg = (fromDB[0] && (fromDB[0].productImage || fromDB[0].image)) || o.firstImage || (fallbackItems[0] && fallbackItems[0].image) || cached.image || null;
          const qtyDB = fromDB.reduce((s,it)=>s + (it.quantity || 0),0);
          const qtyFallback = (fallbackItems || []).reduce((s,i)=>s + (i.quantity || 0),0);
          const qty = qtyDB || cached.qty || qtyFallback || o.totalQty || o.totalQuantity || o.itemsCount || null;
          const refund = refundsByOrder[o.id];
          return {
            ...o,
            items: fromDB,
            cachedImage: firstImg,
            cachedQty: qty,
            refundId: refund ? refund.id : null,
            refundStatus: refund ? refund.status : null
          };
        });
        res.render('orders', { user: req.session.user, orders, order: null, filter: req.query.filter || 'all' });
      };

      attachRefunds(() => {
        if (!needImgs.length) return enrichAndRender();

        const ids = needImgs.filter(i => i.productId).map(i => i.productId);
        const names = needImgs.filter(i => !i.productId && i.productName).map(i => i.productName);
        Order.getProductImages({ ids, names }, (imgErr, maps) => {
          if (!imgErr && maps) {
            allItems.forEach(it => {
              if (!it.productImage) {
                if (it.productId && maps.imgsById[it.productId]) it.productImage = maps.imgsById[it.productId];
                else if (it.productName && maps.imgsByName[it.productName.toLowerCase()]) it.productImage = maps.imgsByName[it.productName.toLowerCase()];
              }
            });
          }
          enrichAndRender();
        });
      });
    });
  });
};

exports.listAll = (req, res) => {
  Admin.getOrderSummary((summaryErr, summary) => {
    if (summaryErr) console.warn('Admin order summary error:', summaryErr);
    Order.findAll((err, results) => {
      if (err) {
        console.error('DB error /admin/orders:', err);
        return res.render('adminOrders', { orders: [], user: req.session.user, summary: summary || { netSales: 0, netLoss: 0 } });
      }
      const ordersBase = results || [];
      const ids = ordersBase.map(o => o.id);
      Refund.getLatestRefundsByOrderIds(ids, (refErr, refunds) => {
        if (refErr) console.error('DB error admin refund lookup:', refErr);
        const map = {};
        (refunds || []).forEach(r => {
          map[Number(r.orderId)] = r;
        });
        const orders = ordersBase.map(o => {
          const r = map[o.id];
          return {
            ...o,
            latestRefundId: r ? r.id : null,
            latestRefundStatus: r ? r.status : null,
            latestRefundType: r ? r.refundType : null,
            requestedRefundAmount: r ? r.requestedAmount : null
          };
        });
        res.render('adminOrders', { orders, user: req.session.user, summary: summary || { netSales: 0, netLoss: 0 } });
      });
    });
  });
};

exports.updateStatus = (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body;
  if (!status) return res.status(400).json({ success: false });
  Order.findByIdWithAgg(id, (findErr, order) => {
    if (findErr || !order) return res.status(404).json({ success: false });
    const currentStatus = normalizeStatus(order.status || '');
    if (currentStatus.startsWith('cancelled')) {
      return res.status(400).json({ success: false, message: 'Cancelled orders are locked' });
    }
    if (currentStatus === 'payment_failed') {
      return res.status(400).json({ success: false, message: 'Payment failed orders are locked' });
    }
    if (currentStatus === 'pending_payment' || currentStatus === 'awaiting_payment') {
      return res.status(400).json({ success: false, message: 'Awaiting payment orders are locked' });
    }
    if (['refund_requested', 'refund_completed', 'refunded', 'partially_refunded'].includes(currentStatus)) {
      return res.status(400).json({ success: false, message: 'Refunded orders are locked' });
    }
    const shipType = (order.deliveryType || '').toLowerCase();
    const isPickup = shipType.includes('pickup');
    const isDelivery = shipType.includes('delivery');
    const next = normalizeStatus(status || '');
    if (isPickup && next === 'out_for_delivery') return res.status(400).json({ success: false });
    if (isDelivery && next === 'ready_for_pickup') return res.status(400).json({ success: false });
    Order.updateStatus(id, next, (err) => {
      if (err) {
        console.error('DB error /admin/orders status:', err);
        return res.status(500).json({ success: false });
      }
      res.json({ success: true });
    });
  });
};

exports.detail = (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  if (Number.isNaN(orderId)) return res.redirect('/orders');
  const isAdminView = req.originalUrl && req.originalUrl.startsWith('/admin/');
  const backLink = isAdminView ? '/admin/orders' : '/orders';
  Order.findByIdWithAgg(orderId, (err, order) => {
    if (err || !order) {
      console.error('DB error /orders/:id:', err);
      return res.redirect(backLink);
    }
    console.log('Order detail status:', order.status);
    OrderItem.findByOrderId(orderId, (itemErr, items) => {
      if (itemErr) console.error('DB error order_items detail:', itemErr);
      const list = items || [];

      // If any items are missing productImage, try to pull from products table
      const needImgs = list.filter(it => !it.productImage && (it.productId || it.productName));
      const doRender = () => {
        const itemsSubtotal = list.reduce((s,it)=> s + (Number(it.price||0) * Number(it.quantity||0)), 0);
        const shippingFee = (order.deliveryType || '').toLowerCase().includes('delivery') ? 2.0 : 0;
        const total = itemsSubtotal + shippingFee;
        const viewName = isAdminView ? 'adminOrderDetail' : 'orderDetail';
        Refund.getLatestRefundForOrder(orderId, (refErr, refund) => {
          if (refErr) console.error('DB error refund detail lookup:', refErr);
          res.render(viewName, {
          user: req.session.user,
          isAdminView,
          backLink,
          order,
          items: list,
          itemsSubtotal,
          shippingFee,
          total,
          refund: refund || null
          });
        });
      };

      if (!needImgs.length) {
        return doRender();
      }

      const ids = needImgs.filter(i => i.productId).map(i => i.productId);
      const names = needImgs.filter(i => !i.productId && i.productName).map(i => i.productName);
      Order.getProductImages({ ids, names }, (errImgs, maps) => {
        if (!errImgs && maps) {
          list.forEach(it => {
            if (!it.productImage) {
              if (it.productId && maps.imgsById[it.productId]) it.productImage = maps.imgsById[it.productId];
              else if (it.productName && maps.imgsByName[it.productName.toLowerCase()]) it.productImage = maps.imgsByName[it.productName.toLowerCase()];
            }
          });
        }
        doRender();
      });
    });
  });
};

exports.cancelOrder = (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  if (Number.isNaN(orderId)) {
    req.flash('error', 'Invalid order');
    return res.redirect('/orders');
  }
  Order.findByIdWithAgg(orderId, (err, order) => {
    if (err || !order) {
      req.flash('error', 'Order not found');
      return res.redirect('/orders');
    }
    if (order.userId !== req.session.user.id) {
      req.flash('error', 'Access denied');
      return res.redirect('/orders');
    }
    const status = normalizeStatus(order.status || '');
    const isPending = isPendingPaymentStatus(status);
    const isFailed = isFailedPaymentStatus(status);
    const canCancel = isPending || isFailed;
    if (!canCancel) {
      req.flash('error', 'Order cannot be cancelled at this stage');
      return res.redirect(`/orders/${orderId}`);
    }

    if (isPending || isFailed) {
      const cancelledStatus = isFailed ? 'cancelled_payment_failed' : 'cancelled_pending_payment';
      Order.cancelPendingOrder(orderId, req.session.user.id, cancelledStatus, (cancelErr) => {
        if (cancelErr) {
          console.error('Order cancel update error:', cancelErr);
          req.flash('error', 'Unable to cancel order');
          return res.redirect(`/orders/${orderId}`);
        }
        req.flash('success', 'Order cancelled successfully');
        return res.redirect(`/orders/${orderId}`);
      });
      return;
    }

    OrderItem.findByOrderId(orderId, (itemErr, items) => {
      if (itemErr) {
        console.error('Order items error:', itemErr);
        req.flash('error', 'Unable to cancel order');
        return res.redirect(`/orders/${orderId}`);
      }
      const list = items || [];
      Refund.createCancellationRefundForOrder(order, list, req.session.user.id, (cancelErr) => {
        if (cancelErr) {
          console.error('Cancel order error:', cancelErr);
          req.flash('error', cancelErr.message || 'Unable to cancel order');
          return res.redirect(`/orders/${orderId}`);
        }
        req.flash('success', 'Order cancelled successfully');
        return res.redirect(`/orders/${orderId}`);
      });
    });
  });
};

exports.retryPayment = async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  if (Number.isNaN(orderId)) {
    req.flash('error', 'Invalid order');
    return res.redirect('/orders');
  }

  try {
    const order = await new Promise((resolve, reject) => {
      Order.findByIdWithAgg(orderId, (err, row) => (err ? reject(err) : resolve(row)));
    });

    if (!order) {
      req.flash('error', 'Order not found');
      return res.redirect('/orders');
    }

    if (order.userId !== req.session.user.id) {
      req.flash('error', 'Access denied');
      return res.redirect('/orders');
    }

    const statusLower = normalizeStatus(order.status || '');
    const isPending = isPendingPaymentStatus(statusLower);
    const isFailed = isFailedPaymentStatus(statusLower);
    if (!isPending && !isFailed) {
      req.flash('error', 'This order is not eligible for payment retry.');
      return res.redirect(`/orders/${orderId}`);
    }

    const methodLower = (order.paymentMethod || '').toLowerCase();
    if (methodLower === 'paypal') {
      const returnUrl = `${req.protocol}://${req.get('host')}/paypal/return`;
      const cancelUrl = `${req.protocol}://${req.get('host')}/paypal/cancel`;
      const paypalOrder = await paypalService.createOrder(order.total, {
        idempotencyKey: `paypal-retry-${order.id}-${Date.now()}`,
        returnUrl,
        cancelUrl,
      });
      await new Promise((resolve, reject) => {
        Order.updatePayPalRefs(order.id, paypalOrder.id, null, (err) =>
          err ? reject(err) : resolve()
        );
      });
      req.session.pendingPaypalOrderId = order.id;
      req.session.pendingPaypalOrder = { orderId: order.id, paypalOrderId: paypalOrder.id };
      const approveLink = (paypalOrder.links || []).find((l) => l.rel === 'approve');
      if (!approveLink?.href) {
        req.flash('error', 'Unable to start PayPal retry. Please try again.');
        return res.redirect(`/orders/${orderId}`);
      }
      return res.redirect(approveLink.href);
    }

    if (methodLower === 'nets-qr' || methodLower === 'nets') {
      req.body.orderId = order.id;
      return netsController.start(req, res);
    }

    if (methodLower === 'stripe') {
      return res.render('retryPayment', { user: req.session.user, order });
    }

    req.flash('error', 'Unsupported payment method for retry.');
    return res.redirect(`/orders/${orderId}`);
  } catch (err) {
    console.error('Retry payment error:', err);
    req.flash('error', 'Unable to retry payment.');
    return res.redirect(`/orders/${orderId}`);
  }
};

exports.invoice = (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  if (Number.isNaN(orderId)) return res.redirect('/orders');
  Order.findByIdWithAgg(orderId, (err, order) => {
    if (err || !order) {
      console.error('DB error /orders/:id/invoice:', err);
      return res.redirect('/orders');
    }
    const statusLower = normalizeStatus(order.status || '');
    const isPaid = isPaidStatus(statusLower);
    const isCancelled = statusLower.startsWith('cancelled');
    const blockedStatuses = ['refund_requested', 'refund_completed', 'refunded', 'partially_refunded'];
    if (isCancelled || blockedStatuses.includes(statusLower)) {
      req.flash('error', 'Invoice is not available for cancelled orders.');
      return res.redirect(`/orders/${orderId}`);
    }
    if (!isPaid) {
      req.flash('error', 'Invoice is only available after payment is successful.');
      return res.redirect(`/orders/${orderId}`);
    }
    OrderItem.findByOrderId(orderId, (itemErr, items) => {
      if (itemErr) console.error('DB error order_items invoice:', itemErr);
      const list = items || [];
      const itemsSubtotal = list.reduce((s,it)=> s + (Number(it.price||0) * Number(it.quantity||0)), 0);
      const shippingFee = (order.deliveryType || '').toLowerCase().includes('delivery') ? 2.0 : 0;
      const total = itemsSubtotal + shippingFee;
      res.render('invoice', {
        user: req.session.user,
        order,
        items: list,
        itemsSubtotal,
        shippingFee,
        total
      });
    });
  });
};

exports.redeemPickup = (req, res) => {
  const orderId = parseInt(req.body.orderId, 10);
  const pickupCode = (req.body.pickupCode || '').trim();
  if (Number.isNaN(orderId) || !pickupCode) {
    return res.status(400).json({ success: false, message: 'Missing orderId or pickupCode' });
  }
  Order.findByIdWithAgg(orderId, (err, order) => {
    if (err || !order) return res.status(404).json({ success: false, message: 'Order not found' });
    const shipType = (order.deliveryType || '').toLowerCase();
    const isPickup = shipType.includes('pickup');
    const status = normalizeStatus(order.status || '');
    const codeStatus = (order.pickupCodeStatus || '').toLowerCase();
    if (!isPickup) return res.status(400).json({ success: false, message: 'Not a pickup order' });
    if (status !== 'ready_for_pickup') return res.status(400).json({ success: false, message: 'Order is not ready for pickup' });
    if (codeStatus !== 'active') return res.status(400).json({ success: false, message: 'Pickup code already redeemed' });
    if ((order.pickupCode || '').trim() !== pickupCode) {
      return res.status(400).json({ success: false, message: 'Invalid pickup code' });
    }
    Order.redeemPickup(orderId, (updErr) => {
      if (updErr) {
        return res.status(500).json({ success: false, message: 'Database error' });
      }
      res.json({ success: true, status: 'completed' });
    });
  });
};
