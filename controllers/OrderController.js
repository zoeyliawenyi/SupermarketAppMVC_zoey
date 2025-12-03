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
      const queries = [];
      if (ids.length) {
        queries.push(new Promise((resolve) => {
          db.query('SELECT id, image FROM products WHERE id IN (?)', [ids], (e, rows) => resolve(rows || []));
        }));
      }
      if (names.length) {
        queries.push(new Promise((resolve) => {
          db.query('SELECT productName, image FROM products WHERE productName IN (?)', [names], (e, rows) => resolve(rows || []));
        }));
      }

      Promise.all(queries).then(results => {
        const imgsById = {};
        const imgsByName = {};
        results.flat().forEach(r => {
          if (r.id) imgsById[r.id] = r.image;
          if (r.productName) imgsByName[r.productName.toLowerCase()] = r.image;
        });
        list.forEach(it => {
          if (!it.productImage) {
            if (it.productId && imgsById[it.productId]) it.productImage = imgsById[it.productId];
            else if (it.productName && imgsByName[it.productName.toLowerCase()]) it.productImage = imgsByName[it.productName.toLowerCase()];
          }
        });
        doRender();
      }).catch(() => doRender());
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
