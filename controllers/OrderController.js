const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const db = require('../db');

exports.listUserOrders = (req, res) => {
  const userId = req.session.user.id;
  Order.findByUser(userId, (err, results) => {
    if (err) {
      console.error('DB error /orders:', err);
      req.flash('error', 'Could not load orders.');
      return res.render('orders', { user: req.session.user, orders: [] });
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
      const orders = ordersBase.map(o => {
        const cached = summaries[o.id] || {};
        const fallbackItems = (lastOrder && lastOrder.id == o.id) ? (lastOrder.items || []) : [];
        const fromDB = grouped[o.id] || [];
        const firstImg = (fromDB[0] && fromDB[0].image) || o.firstImage || (fallbackItems[0] && fallbackItems[0].image) || cached.image || null;
        const qtyDB = fromDB.reduce((s,it)=>s + (it.quantity || 0),0);
        const qtyFallback = (fallbackItems || []).reduce((s,i)=>s + (i.quantity || 0),0);
        const qty = qtyDB || cached.qty || qtyFallback || o.totalQty || o.totalQuantity || o.itemsCount || null;
        return {
          ...o,
          items: fromDB,
          cachedImage: firstImg,
          cachedQty: qty
        };
      });
      res.render('orders', { user: req.session.user, orders, order: null });
    });
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
        res.render(viewName, {
          user: req.session.user,
          isAdminView,
          backLink,
          order,
          items: list,
          itemsSubtotal,
          shippingFee,
          total
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
    const status = (order.status || '').trim().toLowerCase();
    if (status !== 'payment successful' && status !== 'packing') {
      req.flash('error', 'Order cannot be cancelled at this stage');
      return res.redirect(`/orders/${orderId}`);
    }

    OrderItem.findByOrderId(orderId, (itemErr, items) => {
      if (itemErr) {
        console.error('Order items error:', itemErr);
        req.flash('error', 'Unable to cancel order');
        return res.redirect(`/orders/${orderId}`);
      }
      const list = items || [];
      db.beginTransaction((txErr) => {
        if (txErr) {
          console.error('Cancel order tx error:', txErr);
          req.flash('error', 'Unable to cancel order');
          return res.redirect(`/orders/${orderId}`);
        }

        const dupSql = 'SELECT id FROM refunds WHERE orderId = ? AND refundType = ? LIMIT 1';
        db.query(dupSql, [orderId, 'cancellation_refund'], (dupErr, dupRows) => {
          if (dupErr) {
            return db.rollback(() => {
              console.error('Cancel order dup check error:', dupErr);
              req.flash('error', 'Unable to cancel order');
              res.redirect(`/orders/${orderId}`);
            });
          }
          if (dupRows && dupRows.length) {
            return db.rollback(() => {
              req.flash('error', 'A cancellation refund already exists for this order');
              res.redirect(`/orders/${orderId}`);
            });
          }

          const updateSql = 'UPDATE orders SET status = ? WHERE id = ? AND userId = ?';
          db.query(updateSql, ['Cancelled', orderId, req.session.user.id], (updErr) => {
            if (updErr) {
              return db.rollback(() => {
                console.error('Order cancel update error:', updErr);
                req.flash('error', 'Unable to cancel order');
                res.redirect(`/orders/${orderId}`);
              });
            }

            const refundSql = `
              INSERT INTO refunds
              (orderId, userId, refundType, reason, note, evidenceImage, preferredMethod, status, adminNote)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            const refundValues = [
              orderId,
              req.session.user.id,
              'cancellation_refund',
              'changed_mind',
              'User cancelled before shipment',
              null,
              'original',
              'approved',
              'Auto-approved cancellation refund'
            ];
            db.query(refundSql, refundValues, (refErr, refResult) => {
              if (refErr) {
                return db.rollback(() => {
                  console.error('Refund insert error:', refErr);
                  req.flash('error', 'Unable to cancel order');
                  res.redirect(`/orders/${orderId}`);
                });
              }
              const refundId = refResult.insertId;
              if (!list.length) {
                return db.commit((commitErr) => {
                  if (commitErr) {
                    console.error('Cancel commit error:', commitErr);
                    req.flash('error', 'Unable to cancel order');
                    return res.redirect(`/orders/${orderId}`);
                  }
                  req.flash('success', 'Order cancelled successfully');
                  res.redirect(`/orders/${orderId}`);
                });
              }

              const itemValues = list.map((it) => {
                const qty = Number(it.quantity || 0);
                const unitPrice = Number(it.price || 0);
                const lineRefundAmount = unitPrice * qty;
                return [
                  refundId,
                  it.id,
                  it.productId || null,
                  it.productName || 'Item',
                  qty,
                  qty,
                  unitPrice,
                  lineRefundAmount
                ];
              });
              const itemsSql = `
                INSERT INTO refund_items
                (refundId, orderItemId, productId, productName, qtyRequested, qtyApproved, unitPrice, lineRefundAmount)
                VALUES ?
              `;
              db.query(itemsSql, [itemValues], (itemInsErr) => {
                if (itemInsErr) {
                  return db.rollback(() => {
                    console.error('Refund items insert error:', itemInsErr);
                    req.flash('error', 'Unable to cancel order');
                    res.redirect(`/orders/${orderId}`);
                  });
                }
                db.commit((commitErr) => {
                  if (commitErr) {
                    console.error('Cancel commit error:', commitErr);
                    req.flash('error', 'Unable to cancel order');
                    return res.redirect(`/orders/${orderId}`);
                  }
                  req.flash('success', 'Order cancelled successfully');
                  res.redirect(`/orders/${orderId}`);
                });
              });
            });
          });
        });
      });
    });
  });
};

exports.invoice = (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  if (Number.isNaN(orderId)) return res.redirect('/orders');
  Order.findByIdWithAgg(orderId, (err, order) => {
    if (err || !order) {
      console.error('DB error /orders/:id/invoice:', err);
      return res.redirect('/orders');
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
