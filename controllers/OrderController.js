const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Refund = require('../models/Refund');
const db = require('../db');

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
  Order.findAll((err, results) => {
    if (err) {
      console.error('DB error /admin/orders:', err);
      return res.render('adminOrders', { orders: [] });
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
      res.render('adminOrders', { orders, user: req.session.user });
    });
  });
};

exports.updateStatus = (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body;
  if (!status) return res.status(400).json({ success: false });
  Order.findByIdWithAgg(id, (findErr, order) => {
    if (findErr || !order) return res.status(404).json({ success: false });
    const currentStatus = (order.status || '').trim().toLowerCase();
    if (currentStatus === 'cancelled') {
      return res.status(400).json({ success: false, message: 'Cancelled orders are locked' });
    }
    const shipType = (order.deliveryType || '').toLowerCase();
    const isPickup = shipType.includes('pickup');
    const isDelivery = shipType.includes('delivery');
    const next = (status || '').toLowerCase();
    if (isPickup && next === 'out for delivery') return res.status(400).json({ success: false });
    if (isDelivery && next === 'ready for pickup') return res.status(400).json({ success: false });
    Order.updateStatus(id, status, (err) => {
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
    const status = (order.status || '').trim().toLowerCase();
    const isPending = status === 'pending_payment';
    const isFailed = status === 'payment failed' || status === 'payment_failed';
    const canCancel = isPending || isFailed;
    if (!canCancel) {
      req.flash('error', 'Order cannot be cancelled at this stage');
      return res.redirect(`/orders/${orderId}`);
    }

    if (isPending || isFailed) {
      const cancelSql = `
        UPDATE orders
        SET status = ?, cancelledAt = NOW()
        WHERE id = ? AND userId = ?
      `;
      db.query(cancelSql, ['Cancelled', orderId, req.session.user.id], (cancelErr) => {
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

          const updateSql = `
            UPDATE orders
            SET status = ?, cancelledAt = NOW()
            WHERE id = ? AND userId = ?
          `;
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
                const paymentLower = (order.paymentMethod || '').toLowerCase();
                const provider =
                  paymentLower === 'paypal'
                    ? 'paypal'
                    : (paymentLower === 'nets-qr' ? 'nets' : (paymentLower === 'stripe' ? 'stripe' : 'manual'));
                const providerRefDefault =
                  provider === 'paypal'
                    ? `paypal_refund_${refundId}`
                    : (provider === 'stripe' ? `stripe_refund_${refundId}` : null);
                const txnInsert = (providerRef) => {
                  const txnSql = `
                    INSERT INTO refund_transactions (refundId, provider, providerRef, amount, currency, txnStatus, rawResponse)
                    VALUES (?, ?, ?, ?, ?, 'completed', ?)
                  `;
                  const totalAmt = Number(order.total || 0);
                  const rawResponse = JSON.stringify({ source: 'auto-cancel', result: 'completed' });
                  db.query(txnSql, [refundId, provider, providerRef, totalAmt, 'SGD', rawResponse], (txnErr) => {
                    if (txnErr) {
                      return db.rollback(() => {
                        console.error('Refund txn insert error:', txnErr);
                        req.flash('error', 'Unable to cancel order');
                        res.redirect(`/orders/${orderId}`);
                      });
                    }
                    db.query('UPDATE refunds SET status = ? WHERE id = ?', ['completed', refundId], (stErr) => {
                      if (stErr) {
                        return db.rollback(() => {
                          console.error('Refund status update error:', stErr);
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
                };

                if (provider === 'nets') {
                  db.query('SELECT txnRetrievalRef FROM nets_transactions WHERE orderId = ? ORDER BY createdAt DESC LIMIT 1', [orderId], (refErr, refRows) => {
                    if (refErr) {
                      return db.rollback(() => {
                        console.error('Refund nets ref error:', refErr);
                        req.flash('error', 'Unable to cancel order');
                        res.redirect(`/orders/${orderId}`);
                      });
                    }
                    const ref = refRows && refRows[0] ? refRows[0].txnRetrievalRef : `nets_refund_${refundId}`;
                    txnInsert(ref);
                  });
                } else {
                  txnInsert(providerRefDefault);
                }
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
    const statusLower = (order.status || '').trim().toLowerCase();
    const paidStatuses = ['payment successful', 'payment_successful', 'packing', 'out for delivery', 'ready for pickup', 'completed'];
    const isPaid = paidStatuses.includes(statusLower);
    if (statusLower === 'cancelled') {
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
    const status = (order.status || '').toLowerCase();
    const codeStatus = (order.pickupCodeStatus || '').toLowerCase();
    if (!isPickup) return res.status(400).json({ success: false, message: 'Not a pickup order' });
    if (status !== 'ready for pickup') return res.status(400).json({ success: false, message: 'Order is not ready for pickup' });
    if (codeStatus !== 'active') return res.status(400).json({ success: false, message: 'Pickup code already redeemed' });
    if ((order.pickupCode || '').trim() !== pickupCode) {
      return res.status(400).json({ success: false, message: 'Invalid pickup code' });
    }
    db.beginTransaction((txErr) => {
      if (txErr) return res.status(500).json({ success: false, message: 'Database error' });
      const updateSql = `
        UPDATE orders
        SET pickupCodeStatus = ?, pickupCodeRedeemedAt = NOW(), status = ?
        WHERE id = ?
      `;
      db.query(updateSql, ['redeemed', 'Completed', orderId], (updErr) => {
        if (updErr) {
          return db.rollback(() => res.status(500).json({ success: false, message: 'Database error' }));
        }
        db.commit((commitErr) => {
          if (commitErr) {
            return db.rollback(() => res.status(500).json({ success: false, message: 'Database error' }));
          }
          res.json({ success: true, status: 'Completed' });
        });
      });
    });
  });
};
