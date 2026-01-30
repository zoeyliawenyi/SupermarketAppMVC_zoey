const Refund = require('../models/Refund');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const db = require('../db');
const fs = require('fs');
const path = require('path');

const allowedRefundTypes = [
  'full_refund',
  'partial_refund',
  'price_adjustment',
  'cancellation_refund',
  'delivery_fee_refund',
  'substitution_difference'
];

const allowedReasons = [
  'missing_item',
  'wrong_item',
  'damaged',
  'spoiled',
  'expired',
  'late_delivery',
  'pricing_promo_issue',
  'changed_mind'
];

const saveEvidenceFiles = (refundId, files = []) => {
  if (!files || !files.length) return [];
  const baseDir = path.join(__dirname, '..', 'public', 'uploads', 'refunds', String(refundId));
  fs.mkdirSync(baseDir, { recursive: true });
  const mimeToExt = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  };
  const saved = [];
  files.forEach((file) => {
    const ext = mimeToExt[file.mimetype] || path.extname(file.originalname).toLowerCase() || '.jpg';
    const safeName = `evidence_${Date.now()}_${Math.floor(Math.random() * 100000)}${ext}`;
    const fullPath = path.join(baseDir, safeName);
    fs.writeFileSync(fullPath, file.buffer);
    saved.push(`uploads/refunds/${refundId}/${safeName}`);
  });
  return saved;
};

const RefundController = {
  list: (req, res) => {
    Refund.getRefundsByUser(req.session.user.id, (err, refunds) => {
      if (err) {
        console.error('Refund list error:', err);
        return res.render('refunds', { refunds: [], user: req.session.user });
      }
      res.render('refunds', { refunds: refunds || [], user: req.session.user });
    });
  },

  apiList: (req, res) => {
    Refund.getRefundsByUser(req.session.user.id, (err, refunds) => {
      if (err) {
        console.error('Refund api list error:', err);
        return res.status(500).json({ status: 'error', message: 'Unable to load refunds' });
      }
      res.json({ status: 'ok', refunds: refunds || [] });
    });
  },

  showRequest: (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    Order.findByIdWithAgg(orderId, (err, order) => {
      if (err || !order) {
        req.flash('error', 'Order not found');
        return res.redirect('/orders');
      }
      if (order.userId !== req.session.user.id) {
        req.flash('error', 'Access denied');
        return res.redirect('/orders');
      }
      Refund.getOrderItemsForRefund(orderId, (itemErr, items) => {
        if (itemErr) {
          console.error('Refund items error:', itemErr);
          req.flash('error', 'Unable to load order items');
          return res.redirect('/orders');
        }
        const results = [];
        const computeRemaining = (index) => {
          if (index >= items.length) {
            return res.render('refundRequest', { order, items: results, user: req.session.user });
          }
          const item = items[index];
          Refund.getRemainingQty(item.id, (remErr, remaining) => {
            if (remErr) {
              console.error('Remaining qty error:', remErr);
              req.flash('error', 'Unable to load refundable quantity');
              return res.redirect('/orders');
            }
            results.push({ ...item, remainingQty: remaining });
            computeRemaining(index + 1);
          });
        };
        computeRemaining(0);
      });
    });
  },

  submitRequest: (req, res) => {
    const orderId = parseInt(req.body.orderId, 10);
    const refundType = allowedRefundTypes.includes(req.body.refundType) ? req.body.refundType : 'partial_refund';
    const reason = allowedReasons.includes(req.body.reason) ? req.body.reason : 'changed_mind';
    const note = req.body.note || '';
    const preferredMethod = 'original';

    Order.findByIdWithAgg(orderId, (err, order) => {
      if (err || !order) {
        req.flash('error', 'Order not found');
        return res.redirect('/orders');
      }
      if (order.userId !== req.session.user.id) {
        req.flash('error', 'Access denied');
        return res.redirect('/orders');
      }

      Refund.getOrderItemsForRefund(orderId, (itemErr, items) => {
        if (itemErr || !items || !items.length) {
          req.flash('error', 'No items found for this order');
          return res.redirect('/orders');
        }

        const requestedItems = [];
        const processItems = (index) => {
          if (index >= items.length) {
            if (!requestedItems.length) {
              req.flash('error', 'Select at least one item for refund');
              return res.redirect(`/refunds/request/${orderId}`);
            }
            return Refund.createRefundRequest(
              req.session.user.id,
              orderId,
              refundType,
              reason,
              note,
              '',
              preferredMethod,
              requestedItems,
              (createErr, refundId) => {
                if (createErr) {
                  console.error('Create refund error:', createErr);
                  req.flash('error', createErr.message || 'Unable to submit refund request');
                  return res.redirect(`/refunds/request/${orderId}`);
                }
                const evidenceFiles = req.files || [];
                try {
                  const saved = saveEvidenceFiles(refundId, evidenceFiles);
                  Refund.createEvidence(refundId, saved, (evErr) => {
                    if (evErr) console.error('Refund evidence insert error:', evErr);
                    res.redirect(`/refunds/${refundId}`);
                  });
                } catch (e) {
                  console.error('Refund evidence save error:', e);
                  res.redirect(`/refunds/${refundId}`);
                }
              }
            );
          }
          const item = items[index];
          Refund.getRemainingQty(item.id, (remErr, remaining) => {
            if (remErr) {
              req.flash('error', 'Unable to validate refund quantity');
              return res.redirect(`/refunds/request/${orderId}`);
            }
            let qtyRequested = 0;
            if (refundType === 'full_refund') {
              qtyRequested = remaining;
            } else {
              const rawQty = req.body[`qty_${item.id}`];
              qtyRequested = parseInt(rawQty, 10) || 0;
            }
            if (qtyRequested > 0) {
              if (qtyRequested > remaining) {
                req.flash('error', 'Requested quantity exceeds refundable quantity');
                return res.redirect(`/refunds/request/${orderId}`);
              }
              // Assumes order_items.price is the unit price. If it is a line total, divide by quantity before storing.
              requestedItems.push({
                orderItemId: item.id,
                productId: item.productId || null,
                productName: item.productName || 'Item',
                qtyRequested,
                unitPrice: Number(item.price || 0)
              });
            }
            processItems(index + 1);
          });
        };

        processItems(0);
      });
    });
  },

  apiRequest: (req, res) => {
    const orderId = parseInt(req.body.orderId, 10);
    const refundType = allowedRefundTypes.includes(req.body.refundType) ? req.body.refundType : 'partial_refund';
    const reason = allowedReasons.includes(req.body.reason) ? req.body.reason : 'changed_mind';
    const note = req.body.note || '';
    const preferredMethod = 'original';

    if (!orderId) {
      return res.status(400).json({ status: 'error', message: 'orderId is required' });
    }

    Order.findByIdWithAgg(orderId, (err, order) => {
      if (err || !order) {
        return res.status(404).json({ status: 'error', message: 'Order not found' });
      }
      if (order.userId !== req.session.user.id) {
        return res.status(403).json({ status: 'error', message: 'Access denied' });
      }

      Refund.getOrderItemsForRefund(orderId, (itemErr, items) => {
        if (itemErr || !items || !items.length) {
          return res.status(400).json({ status: 'error', message: 'No items found for this order' });
        }

        const requestedItems = [];
        const processItems = (index) => {
          if (index >= items.length) {
            if (!requestedItems.length) {
              return res.status(400).json({ status: 'error', message: 'Select at least one item for refund' });
            }
            return Refund.createRefundRequest(
              req.session.user.id,
              orderId,
              refundType,
              reason,
              note,
              '',
              preferredMethod,
              requestedItems,
              (createErr, refundId) => {
                if (createErr) {
                  console.error('Create refund error:', createErr);
                  return res.status(400).json({ status: 'error', message: createErr.message || 'Unable to submit refund request' });
                }
                const evidenceFiles = req.files || [];
                try {
                  const saved = saveEvidenceFiles(refundId, evidenceFiles);
                  Refund.createEvidence(refundId, saved, (evErr) => {
                    if (evErr) console.error('Refund evidence insert error:', evErr);
                    res.json({ status: 'ok', refundId, evidenceCount: saved.length });
                  });
                } catch (e) {
                  console.error('Refund evidence save error:', e);
                  res.json({ status: 'ok', refundId, evidenceCount: 0 });
                }
              }
            );
          }
          const item = items[index];
          Refund.getRemainingQty(item.id, (remErr, remaining) => {
            if (remErr) {
              return res.status(500).json({ status: 'error', message: 'Unable to validate refund quantity' });
            }
            let qtyRequested = 0;
            if (refundType === 'full_refund') {
              qtyRequested = remaining;
            } else {
              const rawQty = req.body[`qty_${item.id}`];
              qtyRequested = parseInt(rawQty, 10) || 0;
            }
            if (qtyRequested > 0) {
              if (qtyRequested > remaining) {
                return res.status(400).json({ status: 'error', message: 'Requested quantity exceeds refundable quantity' });
              }
              requestedItems.push({
                orderItemId: item.id,
                productId: item.productId || null,
                productName: item.productName || 'Item',
                qtyRequested,
                unitPrice: Number(item.price || 0)
              });
            }
            processItems(index + 1);
          });
        };

        processItems(0);
      });
    });
  },

  detail: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    Refund.getRefundDetailForUser(req.session.user.id, refundId, (err, refund, items, transaction, evidence) => {
      if (err || !refund) {
        req.flash('error', 'Refund not found');
        return res.redirect('/refunds');
      }
      res.render('refundDetail', {
        refund,
        items: items || [],
        transaction,
        evidence: evidence || [],
        user: req.session.user
      });
    });
  }
,
  apiDetail: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    Refund.getRefundDetailForUser(req.session.user.id, refundId, (err, refund, items, transaction, evidence) => {
      if (err || !refund) {
        return res.status(404).json({ status: 'error', message: 'Refund not found' });
      }
      res.json({
        status: 'ok',
        refund,
        items: items || [],
        transaction: transaction || null,
        evidence: evidence || []
      });
    });
  }
,
  quickRequest: (req, res) => {
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
      const statusKey = (order.status || '').trim().toLowerCase().replace(/\s+/g, '_');
      const allowed = ['payment_successful', 'packing', 'out_for_delivery', 'ready_for_pickup', 'pickup_pending'];
      if (!allowed.includes(statusKey)) {
        req.flash('error', 'Refund not available for this order status.');
        return res.redirect(`/orders/${orderId}`);
      }

      console.log('[refund] quick request', { orderId, userId: req.session.user.id });

      const dupSql = 'SELECT id FROM refunds WHERE orderId = ? AND status != ? LIMIT 1';
      db.query(dupSql, [orderId, 'rejected'], (dupErr, dupRows) => {
        if (dupErr) {
          console.error('Refund duplicate check error:', dupErr);
          req.flash('error', 'Unable to create refund right now.');
          return res.redirect(`/orders/${orderId}`);
        }
        if (dupRows && dupRows[0]) {
          return res.redirect(`/refunds/${dupRows[0].id}`);
        }

        OrderItem.findByOrderId(orderId, (itemErr, items) => {
          if (itemErr || !items || !items.length) {
            req.flash('error', 'No items found for this order');
            return res.redirect(`/orders/${orderId}`);
          }

          const requestedItems = items.map((it) => ({
            orderItemId: it.id,
            productId: it.productId || null,
            productName: it.productName || 'Item',
            qtyRequested: Number(it.quantity || 0),
            unitPrice: Number(it.price || 0),
          }));

          Refund.createRefundRequest(
            req.session.user.id,
            orderId,
            'full_refund',
            'changed_mind',
            'User requested refund from order page',
            '',
            'original',
            requestedItems,
            (createErr, refundId) => {
              if (createErr) {
                console.error('Create refund error:', createErr);
                req.flash('error', createErr.message || 'Unable to submit refund request');
                return res.redirect(`/orders/${orderId}`);
              }
              req.flash('success', 'Refund request submitted');
              return res.redirect(`/refunds/${refundId}`);
            }
          );
        });
      });
    });
  }
};

module.exports = RefundController;
