const db = require('../db');

const Refund = {
  getRemainingQty: (orderItemId, cb) => {
    const sql = `
      SELECT
        oi.quantity AS purchasedQty,
        IFNULL(SUM(
          CASE
            WHEN r.status = 'requested' THEN ri.qtyRequested
            WHEN r.status IN ('approved','initiated','completed','failed','manual_review') THEN ri.qtyApproved
            ELSE 0
          END
        ), 0) AS usedQty
      FROM order_items oi
      LEFT JOIN refund_items ri ON ri.orderItemId = oi.id
      LEFT JOIN refunds r ON r.id = ri.refundId
      WHERE oi.id = ?
      GROUP BY oi.id
    `;
    db.query(sql, [orderItemId], (err, rows) => {
      if (err) return cb(err);
      const row = rows && rows[0] ? rows[0] : null;
      if (!row) return cb(null, 0);
      const remaining = Math.max(Number(row.purchasedQty || 0) - Number(row.usedQty || 0), 0);
      cb(null, remaining);
    });
  },

  getOrderItemsForRefund: (orderId, cb) => {
    const sql = `
      SELECT oi.*, p.productName, p.id AS productId
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.productId
      WHERE oi.orderId = ?
    `;
    db.query(sql, [orderId], cb);
  },

  createRefundRequest: (userId, orderId, refundType, reason, note, evidenceImage, preferredMethod, items, cb) => {
    if (!items || !items.length) return cb(new Error('No refund items selected'));
    db.beginTransaction((err) => {
      if (err) return cb(err);
      const insertRefundSql = `
        INSERT INTO refunds (orderId, userId, refundType, reason, note, evidenceImage, preferredMethod, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'requested')
      `;
      db.query(
        insertRefundSql,
        [orderId, userId, refundType, reason, note || '', evidenceImage || null, preferredMethod],
        (insErr, result) => {
          if (insErr) return db.rollback(() => cb(insErr));
          const refundId = result.insertId;
          const validateItems = (index) => {
            if (index >= items.length) return insertItems();
            const item = items[index];
            Refund.getRemainingQty(item.orderItemId, (remErr, remaining) => {
              if (remErr) return db.rollback(() => cb(remErr));
              if (item.qtyRequested > remaining) {
                return db.rollback(() => cb(new Error('Requested quantity exceeds remaining refundable quantity')));
              }
              validateItems(index + 1);
            });
          };
          const insertItems = () => {
            const values = items.map((it) => [
              refundId,
              it.orderItemId,
              it.productId || null,
              it.productName || 'Item',
              it.qtyRequested,
              0,
              it.unitPrice,
              0
            ]);
            const insertItemsSql = `
              INSERT INTO refund_items
              (refundId, orderItemId, productId, productName, qtyRequested, qtyApproved, unitPrice, lineRefundAmount)
              VALUES ?
            `;
            db.query(insertItemsSql, [values], (itemsErr) => {
              if (itemsErr) return db.rollback(() => cb(itemsErr));
              db.commit((commitErr) => {
                if (commitErr) return db.rollback(() => cb(commitErr));
                cb(null, refundId);
              });
            });
          };
          validateItems(0);
        }
      );
    });
  },

  getRefundsByUser: (userId, cb) => {
    const sql = `
      SELECT r.*, o.total AS orderTotal
      FROM refunds r
      LEFT JOIN orders o ON o.id = r.orderId
      WHERE r.userId = ?
      ORDER BY r.createdAt DESC
    `;
    db.query(sql, [userId], cb);
  },

  getRefundDetailForUser: (userId, refundId, cb) => {
    const sql = `
      SELECT r.*, o.paymentMethod, o.total AS orderTotal
      FROM refunds r
      LEFT JOIN orders o ON o.id = r.orderId
      WHERE r.id = ? AND r.userId = ?
      LIMIT 1
    `;
    db.query(sql, [refundId, userId], (err, rows) => {
      if (err) return cb(err);
      const refund = rows && rows[0] ? rows[0] : null;
      if (!refund) return cb(null, null, []);
      const itemSql = `
        SELECT ri.*, oi.quantity AS purchasedQty
        FROM refund_items ri
        LEFT JOIN order_items oi ON oi.id = ri.orderItemId
        WHERE ri.refundId = ?
      `;
      db.query(itemSql, [refundId], (itemErr, items) => {
        if (itemErr) return cb(itemErr);
        const txnSql = `
          SELECT *
          FROM refund_transactions
          WHERE refundId = ?
          LIMIT 1
        `;
        db.query(txnSql, [refundId], (txnErr, txns) => {
          if (txnErr) return cb(txnErr);
          const transaction = txns && txns[0] ? txns[0] : null;
          cb(null, refund, items || [], transaction);
        });
      });
    });
  },

  getRefundsForAdmin: (filters, cb) => {
    let sql = `
      SELECT r.*, u.username, o.total AS orderTotal
      FROM refunds r
      LEFT JOIN users u ON u.id = r.userId
      LEFT JOIN orders o ON o.id = r.orderId
    `;
    const params = [];
    if (filters && filters.status) {
      sql += ' WHERE r.status = ?';
      params.push(filters.status);
    }
    sql += ' ORDER BY r.createdAt DESC';
    db.query(sql, params, cb);
  },

  getRefundDetailForAdmin: (refundId, cb) => {
    const sql = `
      SELECT r.*, o.paymentMethod, o.total AS orderTotal, u.username
      FROM refunds r
      LEFT JOIN orders o ON o.id = r.orderId
      LEFT JOIN users u ON u.id = r.userId
      WHERE r.id = ?
      LIMIT 1
    `;
    db.query(sql, [refundId], (err, rows) => {
      if (err) return cb(err);
      const refund = rows && rows[0] ? rows[0] : null;
      if (!refund) return cb(null, null, [], null);
      const itemSql = `
        SELECT ri.*, oi.quantity AS purchasedQty
        FROM refund_items ri
        LEFT JOIN order_items oi ON oi.id = ri.orderItemId
        WHERE ri.refundId = ?
      `;
      db.query(itemSql, [refundId], (itemErr, items) => {
        if (itemErr) return cb(itemErr);
        const txnSql = `
          SELECT *
          FROM refund_transactions
          WHERE refundId = ?
          LIMIT 1
        `;
        db.query(txnSql, [refundId], (txnErr, txns) => {
          if (txnErr) return cb(txnErr);
          const transaction = txns && txns[0] ? txns[0] : null;
          cb(null, refund, items || [], transaction);
        });
      });
    });
  },

  adminDecision: (refundId, adminId, decision, adminNote, inventoryDisposition, qtyApprovedMap, cb) => {
    db.beginTransaction((err) => {
      if (err) return cb(err);
      const lockSql = 'SELECT status FROM refunds WHERE id = ? FOR UPDATE';
      db.query(lockSql, [refundId], (lockErr, rows) => {
        if (lockErr) return db.rollback(() => cb(lockErr));
        const refund = rows && rows[0] ? rows[0] : null;
        if (!refund) return db.rollback(() => cb(new Error('Refund not found')));
        if (refund.status !== 'requested') {
          return db.rollback(() => cb(new Error('Refund is not in requested status')));
        }
        const updateRefundSql = `
          UPDATE refunds
          SET status = ?, adminId = ?, adminNote = ?, inventoryDisposition = ?
          WHERE id = ?
        `;
        db.query(
          updateRefundSql,
          [decision, adminId, adminNote || '', inventoryDisposition || null, refundId],
          (updateErr) => {
            if (updateErr) return db.rollback(() => cb(updateErr));
            const itemsSql = 'SELECT id, qtyRequested, unitPrice FROM refund_items WHERE refundId = ?';
            db.query(itemsSql, [refundId], (itemErr, items) => {
              if (itemErr) return db.rollback(() => cb(itemErr));
              const updates = items || [];
              const updateNext = (index) => {
                if (index >= updates.length) {
                  return db.commit((commitErr) => (commitErr ? cb(commitErr) : cb(null)));
                }
                const item = updates[index];
                const rawApproved = qtyApprovedMap && qtyApprovedMap[item.id] !== undefined ? qtyApprovedMap[item.id] : 0;
                const qtyApproved = decision === 'rejected' ? 0 : Math.min(Number(rawApproved || 0), Number(item.qtyRequested || 0));
                const lineRefundAmount = Number(item.unitPrice || 0) * qtyApproved;
                const updateItemSql = 'UPDATE refund_items SET qtyApproved = ?, lineRefundAmount = ? WHERE id = ?';
                db.query(updateItemSql, [qtyApproved, lineRefundAmount, item.id], (uErr) => {
                  if (uErr) return db.rollback(() => cb(uErr));
                  updateNext(index + 1);
                });
              };
              updateNext(0);
            });
          }
        );
      });
    });
  },

  initiateRefund: (refundId, cb) => {
    db.beginTransaction((err) => {
      if (err) return cb(err);
      const lockSql = `
        SELECT r.*, o.paymentMethod
        FROM refunds r
        LEFT JOIN orders o ON o.id = r.orderId
        WHERE r.id = ?
        FOR UPDATE
      `;
      db.query(lockSql, [refundId], (lockErr, rows) => {
        if (lockErr) return db.rollback(() => cb(lockErr));
        const refund = rows && rows[0] ? rows[0] : null;
        if (!refund) return db.rollback(() => cb(new Error('Refund not found')));
        if (refund.status !== 'approved' && refund.status !== 'initiated') {
          return db.rollback(() => cb(new Error('Refund must be approved before initiating')));
        }
        const totalSql = 'SELECT IFNULL(SUM(lineRefundAmount), 0) AS total FROM refund_items WHERE refundId = ?';
        db.query(totalSql, [refundId], (totErr, totalRows) => {
          if (totErr) return db.rollback(() => cb(totErr));
          const total = totalRows && totalRows[0] ? Number(totalRows[0].total || 0) : 0;
          if (total <= 0) return db.rollback(() => cb(new Error('Refund amount must be greater than 0')));
          let provider = 'manual';
          if (refund.preferredMethod === 'original') {
            if (refund.paymentMethod === 'nets-qr') provider = 'nets';
            if (refund.paymentMethod === 'paypal') provider = 'paypal';
          }
          // Provider is a stub for now. Integrate NETS/PayPal refund APIs here later.
          const checkTxnSql = 'SELECT id FROM refund_transactions WHERE refundId = ? LIMIT 1';
          db.query(checkTxnSql, [refundId], (checkErr, txnRows) => {
            if (checkErr) return db.rollback(() => cb(checkErr));
            const exists = txnRows && txnRows[0] ? true : false;
            const proceed = (providerRef) => {
              const insertTxn = () => {
                const insertSql = `
                  INSERT INTO refund_transactions (refundId, provider, providerRef, amount, currency, txnStatus)
                  VALUES (?, ?, ?, ?, ?, 'pending')
                `;
                db.query(insertSql, [refundId, provider, providerRef || null, total, 'SGD'], (insErr) => {
                  if (insErr) return db.rollback(() => cb(insErr));
                  updateStatus(false);
                });
              };
              const updateStatus = (alreadyInitiated) => {
                if (refund.status === 'initiated') {
                  return db.commit((commitErr) => (commitErr ? cb(commitErr) : cb(null, { existed: true, alreadyInitiated: true })));
                }
                const updateRefundSql = 'UPDATE refunds SET status = ? WHERE id = ?';
                db.query(updateRefundSql, ['initiated', refundId], (uErr) => {
                  if (uErr) return db.rollback(() => cb(uErr));
                  db.commit((commitErr) => (commitErr ? cb(commitErr) : cb(null, { existed: alreadyInitiated })));
                });
              };
              if (exists) return updateStatus(true);
              insertTxn();
            };
            if (provider === 'nets') {
              const refSql = `
                SELECT txnRetrievalRef
                FROM nets_transactions
                WHERE orderId = ?
                ORDER BY createdAt DESC
                LIMIT 1
              `;
              db.query(refSql, [refund.orderId], (refErr, refRows) => {
                if (refErr) return db.rollback(() => cb(refErr));
                const providerRef = refRows && refRows[0] ? refRows[0].txnRetrievalRef : `nets_refund_${refundId}`;
                proceed(providerRef);
              });
            } else if (provider === 'paypal') {
              proceed(`paypal_refund_${refundId}`);
            } else {
              proceed(null);
            }
          });
        });
      });
    });
  },

  markRefundCompleted: (refundId, rawResponse, cb) => {
    db.beginTransaction((err) => {
      if (err) return cb(err);
      const lockSql = 'SELECT status FROM refunds WHERE id = ? FOR UPDATE';
      db.query(lockSql, [refundId], (lockErr, rows) => {
        if (lockErr) return db.rollback(() => cb(lockErr));
        const refund = rows && rows[0] ? rows[0] : null;
        if (!refund) return db.rollback(() => cb(new Error('Refund not found')));
        if (refund.status !== 'initiated') {
          return db.rollback(() => cb(new Error('Refund must be initiated before completion')));
        }
        const updateTxnSql = 'UPDATE refund_transactions SET txnStatus = ?, rawResponse = ? WHERE refundId = ?';
        db.query(updateTxnSql, ['completed', rawResponse || null, refundId], (txnErr) => {
          if (txnErr) return db.rollback(() => cb(txnErr));
          const updateRefundSql = 'UPDATE refunds SET status = ? WHERE id = ?';
          db.query(updateRefundSql, ['completed', refundId], (uErr) => {
            if (uErr) return db.rollback(() => cb(uErr));
            db.commit((commitErr) => (commitErr ? cb(commitErr) : cb(null)));
          });
        });
      });
    });
  },

  markRefundFailed: (refundId, rawResponse, cb) => {
    db.beginTransaction((err) => {
      if (err) return cb(err);
      const lockSql = 'SELECT status FROM refunds WHERE id = ? FOR UPDATE';
      db.query(lockSql, [refundId], (lockErr, rows) => {
        if (lockErr) return db.rollback(() => cb(lockErr));
        const refund = rows && rows[0] ? rows[0] : null;
        if (!refund) return db.rollback(() => cb(new Error('Refund not found')));
        if (refund.status !== 'initiated') {
          return db.rollback(() => cb(new Error('Refund must be initiated before failing')));
        }
        const updateTxnSql = 'UPDATE refund_transactions SET txnStatus = ?, rawResponse = ? WHERE refundId = ?';
        db.query(updateTxnSql, ['failed', rawResponse || null, refundId], (txnErr) => {
          if (txnErr) return db.rollback(() => cb(txnErr));
          // Mark manual_review so an admin can decide next steps after a provider failure.
          const updateRefundSql = 'UPDATE refunds SET status = ? WHERE id = ?';
          db.query(updateRefundSql, ['manual_review', refundId], (uErr) => {
            if (uErr) return db.rollback(() => cb(uErr));
            db.commit((commitErr) => (commitErr ? cb(commitErr) : cb(null)));
          });
        });
      });
    });
  }
};

module.exports = Refund;
