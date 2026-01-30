const Order = require("../models/Order");
const OrderItem = require("../models/OrderItem");
const Cart = require("../models/Cart");
const netsService = require("../services/nets");
const db = require("../db");
const { buildCheckoutSnapshot } = require("../services/checkout");
const { finalizePaidOrder, updateOrderStatus } = require("../services/orderFinalize");

const getNetsTxnByRef = (txnRetrievalRef) =>
  new Promise((resolve, reject) => {
    db.query(
      'SELECT * FROM nets_transactions WHERE txnRetrievalRef = ? ORDER BY createdAt DESC LIMIT 1',
      [txnRetrievalRef],
      (err, rows) => (err ? reject(err) : resolve(rows && rows[0] ? rows[0] : null))
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
    const isPickup = (snapshot.shipping.option || '').toLowerCase() === 'pickup';
    const createWithCode = (pickupCode) => {
      db.beginTransaction((txErr) => {
        if (txErr) return reject(txErr);
        const payload = {
          userId,
          total: snapshot.total,
          paymentMethod: 'nets-qr',
          paymentProvider: 'nets',
          deliveryType: snapshot.shipping.option,
          address: snapshot.shipping.address || req.session.user.address,
          pickupCode: pickupCode || null,
          pickupCodeStatus: pickupCode ? 'active' : null,
          pickupCodeRedeemedAt: null,
          status: 'pending_payment',
        };
        Order.create(payload, (orderErr, orderId) => {
          if (orderErr) return db.rollback(() => reject(orderErr));
          OrderItem.createMany(orderId, snapshot.cartForOrder, (itemErr) => {
            if (itemErr) return db.rollback(() => reject(itemErr));
            db.commit((commitErr) => {
              if (commitErr) return db.rollback(() => reject(commitErr));
              resolve(orderId);
            });
          });
        });
      });
    };
    if (isPickup) {
      Order.generatePickupCode((codeErr, code) => {
        if (codeErr) return reject(codeErr);
        createWithCode(code);
      });
    } else {
      createWithCode(null);
    }
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

  const statusLower = (order.status || '').toLowerCase();
  if (statusLower === 'payment successful') {
    return res.redirect(`/orders/success?id=${order.id}`);
  }

  if (status === 'payment successful') {
    await finalizePaidOrder(req, order.id);
    req.session.pendingNetsOrderId = null;
    await new Promise((resolve) => {
      db.query(
        'UPDATE nets_transactions SET status = ? WHERE orderId = ? AND txnRetrievalRef = ?',
        ['completed', order.id, txnRetrievalRef],
        () => resolve()
      );
    });
    return res.redirect(`/orders/success?id=${order.id}`);
  }

  await updateOrderStatus(order.id, 'payment failed');
  req.session.pendingNetsOrderId = null;
  await new Promise((resolve) => {
    db.query(
      'UPDATE nets_transactions SET status = ? WHERE orderId = ? AND txnRetrievalRef = ?',
      ['failed', order.id, txnRetrievalRef],
      () => resolve()
    );
  });
  return res.redirect(`/orders/fail?id=${order.id}`);
};

const NetsController = {
  start: async (req, res) => {
    try {
      const userId = req.session.user.id;
      Cart.getByUserId(userId, async (err, cart) => {
        if (err || !cart || cart.length === 0) {
          req.flash("error", "Your cart is empty");
          return res.redirect("/cart");
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
            const statusLower = (order?.status || '').toLowerCase();
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
              db.query(
                `INSERT INTO nets_transactions (userId, orderId, txnRetrievalRef, courseInitId, amount, currency, status, rawResponse)
                 VALUES (?, ?, ?, ?, ?, 'SGD', 'pending', ?)`,
                [
                  userId,
                  order.id,
                  txnRetrievalRef,
                  courseInitId,
                  order.total,
                  JSON.stringify(qrData || {}),
                ],
                () => resolve()
              );
            });
            console.log('[nets] qr created', { orderId: order.id, txnRetrievalRef, amount: order.total });

            return res.render("netsQr", {
              total: order.total,
              title: "Scan to Pay",
              qrCodeUrl: `data:image/png;base64,${qrCode}`,
              txnRetrievalRef,
              courseInitId,
              timer: 300,
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
      const row = await new Promise((resolve, reject) => {
        db.query(
          'SELECT courseInitId FROM nets_transactions WHERE txnRetrievalRef = ? ORDER BY createdAt DESC LIMIT 1',
          [txnRetrievalRef],
          (err, rows) => (err ? reject(err) : resolve(rows && rows[0] ? rows[0] : null))
        );
      });
      courseInitId = row && row.courseInitId ? row.courseInitId : "";
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

  success: (req, res) => finalizeNetsOrder(req, res, "payment successful"),
  fail: (req, res) => finalizeNetsOrder(req, res, "payment failed"),

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
      if ((order?.status || '').toLowerCase() === 'payment successful') status = 'success';
      if ((order?.status || '').toLowerCase() === 'payment failed') status = 'failed';
      if ((order?.status || '').toLowerCase() === 'cancelled') status = 'cancelled';

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

      const statusLower = (order?.status || '').toLowerCase();
      if (statusLower === 'payment successful') {
        return res.json({ success: true, status: 'success', orderId: order.id, requestId });
      }

      await finalizePaidOrder(req, order.id);
      await new Promise((resolve) => {
        db.query(
          'UPDATE nets_transactions SET status = ? WHERE id = ?',
          ['completed', txn.id],
          () => resolve()
        );
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

      await updateOrderStatus(order.id, 'payment failed');
      await new Promise((resolve) => {
        db.query(
          'UPDATE nets_transactions SET status = ? WHERE id = ?',
          ['failed', txn.id],
          () => resolve()
        );
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

      await updateOrderStatus(order.id, 'cancelled');
      await new Promise((resolve) => {
        db.query(
          'UPDATE nets_transactions SET status = ? WHERE id = ?',
          ['cancelled', txn.id],
          () => resolve()
        );
      });
      res.json({ success: true, status: 'cancelled', orderId: order.id, requestId });
    } catch (error) {
      console.error('NETS cancel error:', error);
      res.status(500).json({ success: false, message: 'Unable to cancel NETS request' });
    }
  },

  devTxn: (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    if (Number.isNaN(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid orderId" });
    }
    const sql = `
      SELECT id, orderId, txnRetrievalRef, courseInitId, amount, currency, status, createdAt, updatedAt
      FROM nets_transactions
      WHERE orderId = ?
      ORDER BY createdAt DESC
      LIMIT 1
    `;
    const db = require("../db");
    db.query(sql, [orderId], (err, rows) => {
      if (err) {
        console.error("NETS devTxn error:", err);
        return res.status(500).json({ success: false, message: "Database error" });
      }
      const row = rows && rows[0] ? rows[0] : null;
      res.json({ success: true, txn: row });
    });
  },
};

module.exports = NetsController;
