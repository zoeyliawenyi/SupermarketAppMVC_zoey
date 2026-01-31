const Order = require("../models/Order");
const Cart = require("../models/Cart");
const netsService = require("../services/nets");
const NetsTransaction = require("../models/NetsTransaction");
const User = require("../models/User");
const { buildCheckoutSnapshot } = require("../services/checkout");
const { finalizePaidOrder, updateOrderStatus } = require("../services/orderFinalize");
const { normalizeStatus } = require('../utils/status');

const getNetsTxnByRef = (txnRetrievalRef) =>
  new Promise((resolve, reject) => {
    NetsTransaction.findLatestByRef(txnRetrievalRef, (err, row) =>
      err ? reject(err) : resolve(row)
    );
  });

const getOrderById = (orderId) =>
  new Promise((resolve, reject) => {
    Order.findByIdWithAgg(orderId, (err, row) => (err ? reject(err) : resolve(row)));
  });

const canAccessOrder = (req, order) => {
  if (!req.session || !req.session.user) return false;
  if (req.session.user.role === 'admin') return true;
  return order && order.userId === req.session.user.id;
};

const createPendingOrder = (req, snapshot) =>
  new Promise((resolve, reject) => {
    const userId = req.session.user.id;
    Order.createPendingNetsOrder(
      userId,
      {
        ...snapshot,
        shipping: {
          ...snapshot.shipping,
          address: snapshot.shipping.address || req.session.user.address,
        },
      },
      (err, orderId) => (err ? reject(err) : resolve(orderId))
    );
  });

const finalizeNetsOrder = async (req, res, status) => {
  const { txn_retrieval_ref: txnRetrievalRef } = req.query || {};
  if (!txnRetrievalRef) {
    req.flash('error', 'Missing NETS transaction reference.');
    return res.redirect('/checkout');
  }

  const order = await new Promise((resolve, reject) => {
    Order.findByNetsTxnRetrievalRef(txnRetrievalRef, (err, row) =>
      err ? reject(err) : resolve(row)
    );
  });
  if (!order) {
    req.flash('error', 'Order not found for this NETS transaction.');
    return res.redirect('/checkout');
  }
  if (order.userId !== req.session.user.id) {
    return res.status(403).send('Forbidden');
  }

  const statusLower = normalizeStatus(order.status || '');
  if (statusLower === 'payment_successful') {
    return res.redirect(`/orders/success?id=${order.id}`);
  }

  if (status === 'payment_successful') {
    await finalizePaidOrder(req, order.id);
    req.session.pendingNetsOrderId = null;
    await new Promise((resolve) => {
      NetsTransaction.updateStatusByRef(txnRetrievalRef, 'completed', () => resolve());
    });
    return res.redirect(`/orders/success?id=${order.id}`);
  }

  await updateOrderStatus(order.id, 'payment_failed');
  req.session.pendingNetsOrderId = null;
  await new Promise((resolve) => {
    NetsTransaction.updateStatusByRef(txnRetrievalRef, 'failed', () => resolve());
  });
  return res.redirect(`/orders/fail?id=${order.id}`);
};

const NetsController = {
  start: async (req, res) => {
    try {
      const userId = req.session.user.id;
      const requestedOrderId = parseInt(req.body?.orderId || req.query?.orderId, 10);
      if (!Number.isNaN(requestedOrderId)) {
        try {
          const order = await getOrderById(requestedOrderId);
          if (!order || !canAccessOrder(req, order)) {
            req.flash('error', 'Access denied for this order.');
            return res.redirect('/orders');
          }
          const statusLower = normalizeStatus(order.status || '');
          const methodLower = (order.paymentMethod || '').toLowerCase();
          if (!['pending_payment', 'payment_failed'].includes(statusLower)) {
            req.flash('error', 'This order is not eligible for NETS retry.');
            return res.redirect(`/orders/${order.id}`);
          }
          if (methodLower !== 'nets-qr') {
            req.flash('error', 'This order was not placed with NETS QR.');
            return res.redirect(`/orders/${order.id}`);
          }

          const { qrData, txnRetrievalRef, courseInitId, qrCode } =
            await netsService.requestQrCode(order.total);

          if (
            qrData.response_code === "00" &&
            qrData.txn_status === 1 &&
            qrCode
          ) {
            await new Promise((resolve, reject) => {
              Order.updateNetsRefs(order.id, txnRetrievalRef, courseInitId, (err) =>
                err ? reject(err) : resolve()
              );
            });
            await new Promise((resolve) => {
              NetsTransaction.insert(
                {
                  userId,
                  orderId: order.id,
                  txnRetrievalRef,
                  courseInitId,
                  amount: order.total,
                  currency: 'SGD',
                  status: 'pending',
                  rawResponse: qrData || {}
                },
                () => resolve()
              );
            });
            req.session.pendingNetsOrderId = order.id;
            console.log('[nets] retry qr created', { orderId: order.id, txnRetrievalRef, amount: order.total });
            return res.render("netsQr", {
              total: Number(order.total),
              title: "Scan to Pay",
              qrCodeUrl: `data:image/png;base64,${qrCode}`,
              txnRetrievalRef,
              courseInitId,
              timer: 300,
              returnUrl: `/orders/${order.id}`,
              cancelUrl: `/nets-qr/cancel?orderId=${order.id}&txn_retrieval_ref=${txnRetrievalRef}&mode=retry&return=${encodeURIComponent(`/orders/${order.id}`)}`,
            });
          }

          return res.render("netsTxnFailStatus", {
            message: qrData.error_message || "Unable to generate NETS QR code.",
          });
        } catch (error) {
          console.error("NETS retry error:", error.message);
          return res.render("netsTxnFailStatus", {
            message: "Unable to generate NETS QR code.",
          });
        }
      }

      Cart.getByUserId(userId, async (err, cart) => {
        if (err || !cart || cart.length === 0) {
          req.flash("error", "Your cart is empty");
          return res.redirect("/cart");
        }

        const freshUser = await new Promise((resolve, reject) => {
          User.findById(userId, (uErr, row) => (uErr ? reject(uErr) : resolve(row)));
        });
        if (freshUser) {
          req.session.user = { ...req.session.user, ...freshUser };
        }

        const snapshot = buildCheckoutSnapshot(req, cart, 'nets-qr');
        if (!snapshot.cartForOrder.length) {
          req.flash("error", "No items selected for checkout");
          return res.redirect("/cart");
        }

        try {
          let orderId = req.session.pendingNetsOrderId || null;
          let order = null;
          if (orderId) {
            order = await new Promise((resolve, reject) => {
              Order.findByIdWithAgg(orderId, (err, row) =>
                err ? reject(err) : resolve(row)
              );
            });
            const statusLower = normalizeStatus(order?.status || '');
            if (statusLower === 'payment_failed') {
              req.session.pendingNetsOrderId = null;
              orderId = null;
              order = null;
            }
            const totalMatch = order && Number(order.total || 0).toFixed(2) === Number(snapshot.total || 0).toFixed(2);
            const methodMatch = order && (order.paymentMethod || '').toLowerCase() === 'nets-qr';
            if (!order || order.userId !== userId || statusLower !== 'pending_payment' || !totalMatch || !methodMatch) {
              order = null;
              orderId = null;
            }
          }

          if (!order) {
            orderId = await createPendingOrder(req, snapshot);
            order = await new Promise((resolve, reject) => {
              Order.findByIdWithAgg(orderId, (err, row) =>
                err ? reject(err) : resolve(row)
              );
            });
            req.session.pendingNetsOrderId = orderId;
          }

          const { qrData, txnRetrievalRef, courseInitId, qrCode } =
            await netsService.requestQrCode(order.total);

          if (
            qrData.response_code === "00" &&
            qrData.txn_status === 1 &&
            qrCode
          ) {
            await new Promise((resolve, reject) => {
              Order.updateNetsRefs(order.id, txnRetrievalRef, courseInitId, (err) =>
                err ? reject(err) : resolve()
              );
            });
            await new Promise((resolve) => {
              NetsTransaction.insert(
                {
                  userId,
                  orderId: order.id,
                  txnRetrievalRef,
                  courseInitId,
                  amount: order.total,
                  currency: 'SGD',
                  status: 'pending',
                  rawResponse: qrData || {}
                },
                () => resolve()
              );
            });
            console.log('[nets] qr created', { orderId: order.id, txnRetrievalRef, amount: order.total });

            return res.render("netsQr", {
              total: Number(order.total),
              title: "Scan to Pay",
              qrCodeUrl: `data:image/png;base64,${qrCode}`,
              txnRetrievalRef,
              courseInitId,
              timer: 300,
              returnUrl: '/checkout',
              cancelUrl: `/nets-qr/cancel?orderId=${order.id}&txn_retrieval_ref=${txnRetrievalRef}&mode=checkout&return=${encodeURIComponent('/checkout')}`,
            });
          }

          return res.render("netsTxnFailStatus", {
            message: qrData.error_message || "Unable to generate NETS QR code.",
          });
        } catch (error) {
          console.error("NETS request error:", error.message);
          return res.render("netsTxnFailStatus", {
            message: "Unable to generate NETS QR code.",
          });
        }
      });
    } catch (error) {
      console.error("NETS start error:", error.message);
      res.render("netsTxnFailStatus", {
        message: "Unable to start NETS QR payment.",
      });
    }
  },

  sseStatus: async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const { txnRetrievalRef } = req.params;
    const owner = await new Promise((resolve, reject) => {
      Order.findByNetsTxnRetrievalRef(txnRetrievalRef, (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!owner || owner.userId !== req.session.user.id) {
      res.write(`data: ${JSON.stringify({ success: false, fail: true, error: true })}\n\n`);
      res.end();
      return;
    }
    let courseInitId = "";
    try {
      const courseId = await new Promise((resolve, reject) => {
        NetsTransaction.findCourseInitIdByRef(txnRetrievalRef, (err, val) =>
          err ? reject(err) : resolve(val)
        );
      });
      courseInitId = courseId || "";
    } catch (e) {
      courseInitId = "";
    }

    let closed = false;
    const send = (payload) => {
      if (closed) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const poll = async () => {
      try {
        const raw = await netsService.queryPaymentStatus({
          txnRetrievalRef,
          courseInitId,
        });
        const normalized = netsService.normalizePaymentStatus(raw);
        send(normalized);

        if (normalized.success || normalized.fail) {
          cleanup();
        }
      } catch (error) {
        send({ success: false, fail: false, error: true });
      }
    };

    const interval = setInterval(poll, 3000);
    poll();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      res.end();
    };

    req.on("close", cleanup);
  },

  success: (req, res) => finalizeNetsOrder(req, res, "payment_successful"),
  fail: (req, res) => finalizeNetsOrder(req, res, "payment_failed"),

  status: async (req, res) => {
    try {
      const requestId = req.params.requestId;
      if (!requestId) return res.status(400).json({ success: false, message: 'Missing requestId' });
      const txn = await getNetsTxnByRef(requestId);
      if (!txn) return res.status(404).json({ success: false, message: 'NETS transaction not found' });
      const order = await getOrderById(txn.orderId);
      if (!canAccessOrder(req, order)) return res.status(403).json({ success: false, message: 'Forbidden' });

      const statusLower = (txn.status || '').toLowerCase();
      let status = 'pending';
      if (statusLower === 'completed') status = 'success';
      if (statusLower === 'failed') status = 'failed';
      if (statusLower === 'expired') status = 'expired';
      if (statusLower === 'cancelled') status = 'cancelled';
      if (normalizeStatus(order?.status || '') === 'payment_successful') status = 'success';
      if (normalizeStatus(order?.status || '') === 'payment_failed') status = 'failed';
      if (normalizeStatus(order?.status || '').startsWith('cancelled')) status = 'cancelled';

      res.json({
        success: true,
        status,
        requestId,
        orderId: txn.orderId,
      });
    } catch (error) {
      console.error('NETS status error:', error);
      res.status(500).json({ success: false, message: 'Unable to fetch NETS status' });
    }
  },

  simulateSuccess: async (req, res) => {
    try {
      const requestId = req.params.requestId;
      if (!requestId) return res.status(400).json({ success: false, message: 'Missing requestId' });
      const txn = await getNetsTxnByRef(requestId);
      if (!txn) return res.status(404).json({ success: false, message: 'NETS transaction not found' });
      const order = await getOrderById(txn.orderId);
      if (!canAccessOrder(req, order)) return res.status(403).json({ success: false, message: 'Forbidden' });

      const statusLower = normalizeStatus(order?.status || '');
      if (statusLower === 'payment_successful') {
        return res.json({ success: true, status: 'success', orderId: order.id, requestId });
      }

      await finalizePaidOrder(req, order.id);
      await new Promise((resolve) => {
        NetsTransaction.updateStatusById(txn.id, 'completed', () => resolve());
      });
      res.json({ success: true, status: 'success', orderId: order.id, requestId });
    } catch (error) {
      console.error('NETS simulate success error:', error);
      res.status(500).json({ success: false, message: 'Unable to simulate NETS success' });
    }
  },

  simulateFailure: async (req, res) => {
    try {
      const requestId = req.params.requestId;
      if (!requestId) return res.status(400).json({ success: false, message: 'Missing requestId' });
      const txn = await getNetsTxnByRef(requestId);
      if (!txn) return res.status(404).json({ success: false, message: 'NETS transaction not found' });
      const order = await getOrderById(txn.orderId);
      if (!canAccessOrder(req, order)) return res.status(403).json({ success: false, message: 'Forbidden' });

      await updateOrderStatus(order.id, 'payment_failed');
      await new Promise((resolve) => {
        NetsTransaction.updateStatusById(txn.id, 'failed', () => resolve());
      });
      res.json({ success: true, status: 'failed', orderId: order.id, requestId });
    } catch (error) {
      console.error('NETS simulate failure error:', error);
      res.status(500).json({ success: false, message: 'Unable to simulate NETS failure' });
    }
  },

  cancel: async (req, res) => {
    try {
      const requestId = req.params.requestId;
      if (!requestId) return res.status(400).json({ success: false, message: 'Missing requestId' });
      const txn = await getNetsTxnByRef(requestId);
      if (!txn) return res.status(404).json({ success: false, message: 'NETS transaction not found' });
      const order = await getOrderById(txn.orderId);
      if (!canAccessOrder(req, order)) return res.status(403).json({ success: false, message: 'Forbidden' });

      await updateOrderStatus(order.id, 'cancelled_pending_payment');
      await new Promise((resolve) => {
        NetsTransaction.updateStatusById(txn.id, 'cancelled', () => resolve());
      });
      res.json({ success: true, status: 'cancelled', orderId: order.id, requestId });
    } catch (error) {
      console.error('NETS cancel error:', error);
      res.status(500).json({ success: false, message: 'Unable to cancel NETS request' });
    }
  },

  cancelFromQr: async (req, res) => {
    try {
      const orderId = parseInt(req.query.orderId, 10) || req.session.pendingNetsOrderId;
      const txnRetrievalRef = req.query.txn_retrieval_ref;
      const mode = (req.query.mode || 'checkout').toLowerCase();
      const returnUrl = req.query.return || (mode === 'retry' && orderId ? `/orders/${orderId}` : '/checkout');

      if (!orderId) {
        req.flash('error', 'No pending NETS order found.');
        return res.redirect(returnUrl);
      }

      const order = await getOrderById(orderId);
      if (!order) return res.redirect(returnUrl);
      if (!canAccessOrder(req, order)) return res.status(403).send('Forbidden');

      const statusLower = normalizeStatus(order.status || '');
      if (statusLower === 'payment_successful' || statusLower === 'completed') {
        return res.redirect(`/orders/${order.id}`);
      }

      await updateOrderStatus(order.id, 'payment_failed');
      await new Promise((resolve) => {
        if (txnRetrievalRef) {
          NetsTransaction.updateStatusByRef(txnRetrievalRef, 'cancelled', () => resolve());
        } else {
          NetsTransaction.updateStatusByOrderId(order.id, 'cancelled', () => resolve());
        }
      });

      req.session.pendingNetsOrderId = null;
      req.flash('error', 'NETS payment was cancelled.');
      return res.redirect(`/orders/fail?id=${order.id}`);
    } catch (error) {
      console.error('NETS cancel from QR error:', error);
      req.flash('error', 'Unable to cancel NETS order.');
      return res.redirect('/checkout');
    }
  },

  devTxn: (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    if (Number.isNaN(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid orderId" });
    }
    NetsTransaction.findLatestByOrderId(orderId, (err, row) => {
      if (err) {
        console.error("NETS devTxn error:", err);
        return res.status(500).json({ success: false, message: "Database error" });
      }
      res.json({ success: true, txn: row });
    });
  },
};

module.exports = NetsController;
