const Product = require("../models/Product");
const Order = require("../models/Order");
const OrderItem = require("../models/OrderItem");
const Cart = require("../models/Cart");
const netsService = require("../services/nets");

const buildCheckoutSnapshot = (req, cart) => {
  const sel = req.session.checkoutSelection || [];
  const cartForOrder = sel.length
    ? cart.filter((item) => sel.includes(Number(item.productId)))
    : cart;

  const shipping = req.session.checkoutShipping || {
    contact: req.session.user.contact || "",
    address: req.session.user.address || "",
    option: "pickup",
    payment: "nets-qr",
  };

  const shippingCost = shipping.option === "delivery" ? 2.0 : 0;
  const subtotal = cartForOrder.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );
  const total = subtotal + shippingCost;

  return { cartForOrder, shipping, shippingCost, subtotal, total, selection: sel };
};

const finalizeOrder = (req, res, status) => {
  const userId = req.session.user.id;
  Cart.getByUserId(userId, (err, cart) => {
    if (err || !cart || cart.length === 0) {
      req.flash("error", "Your cart is empty");
      return res.redirect("/cart");
    }

    const pending = req.session.pendingNetsOrder || {};
    const selection = pending.selection || req.session.checkoutSelection || [];
    const cartForOrder = selection.length
      ? cart.filter((item) => selection.includes(Number(item.productId)))
      : cart;

    if (!cartForOrder.length) {
      req.flash("error", "No items selected for checkout");
      return res.redirect("/cart");
    }

    const shipping = pending.shipping ||
      req.session.checkoutShipping || {
        option: "pickup",
        payment: "nets-qr",
        contact: "",
        address: "",
      };

    const shippingCost = shipping.option === "delivery" ? 2.0 : 0;
    const subtotal = cartForOrder.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );
    const total = subtotal + shippingCost;

    const orderPayload = {
      userId: userId,
      total,
      paymentMethod: "nets-qr",
      deliveryType: shipping.option,
      address: shipping.address || req.session.user.address,
      status,
    };

    Order.create(orderPayload, (orderErr, orderId) => {
      if (orderErr) {
        console.error("NETS order error:", orderErr);
        req.flash("error", "Could not place order.");
        return res.redirect("/cart");
      }

      OrderItem.createMany(orderId, cartForOrder, (itemErr) => {
        if (itemErr) console.error("NETS order items error:", itemErr);

        if (status !== "payment failed") {
          let pendingStock = cartForOrder.length;
          cartForOrder.forEach((it) => {
            Product.decrementStock(it.productId, it.quantity, () => {
              if (--pendingStock === 0) finish();
            });
          });
        } else {
          finish();
        }

        function finish() {
          const orderedProductIds = cartForOrder.map((i) => i.productId);
          Cart.clearItems(userId, orderedProductIds, (clearErr) => {
            if (clearErr) console.error("Clear cart error:", clearErr);

            req.session.lastOrder = { id: orderId, items: cartForOrder };
            req.session.checkoutSelection = [];
            req.session.pendingNetsOrder = null;
            res.redirect(
              status !== "payment failed"
                ? `/orders/success?id=${orderId}`
                : `/orders/fail?id=${orderId}`
            );
          });
        }
      });
    });
  });
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

        const snapshot = buildCheckoutSnapshot(req, cart);
        if (!snapshot.cartForOrder.length) {
          req.flash("error", "No items selected for checkout");
          return res.redirect("/cart");
        }

        try {
          const { qrData, txnRetrievalRef, courseInitId, qrCode } =
            await netsService.requestQrCode(snapshot.total);

          if (
            qrData.response_code === "00" &&
            qrData.txn_status === 1 &&
            qrCode
          ) {
            req.session.pendingNetsOrder = {
              selection: snapshot.selection,
              shipping: snapshot.shipping,
              total: snapshot.total,
              txnRetrievalRef,
              courseInitId,
            };

            return res.render("netsQr", {
              total: snapshot.total,
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
    const pending = req.session.pendingNetsOrder || {};
    const courseInitId = pending.courseInitId || "";

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

  success: (req, res) => finalizeOrder(req, res, "payment successful"),
  fail: (req, res) => finalizeOrder(req, res, "payment failed"),
};

module.exports = NetsController;
