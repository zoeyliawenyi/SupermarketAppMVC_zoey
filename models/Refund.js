const db = require('../db');

const Refund = {
  getRemainingQty: (orderItemId, cb) => {
    const sql = `
      SELECT
        oi.quantity AS purchasedQty,
        IFNULL(SUM(
          CASE
            WHEN r.status = 'requested' THEN ri.qtyRequested
            WHEN r.status IN ('approved','processing','refunded','initiated','completed','failed','manual_review') THEN ri.qtyApproved
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

  createEvidence: (refundId, filePaths, cb) => {
    if (!filePaths || !filePaths.length) return cb(null);
    const values = filePaths.map((p) => [refundId, p]);
    const sql = 'INSERT INTO refund_evidence (refundId, filePath) VALUES ?';
    db.query(sql, [values], cb);
  },

  getEvidence: (refundId, cb) => {
    const sql = 'SELECT filePath FROM refund_evidence WHERE refundId = ?';
    db.query(sql, [refundId], (err, rows) => {
      if (err) return cb(err);
      const paths = (rows || []).map((r) => r.filePath);
      cb(null, paths);
    });
  },

  getLatestRefundsByOrderIds: (orderIds, cb) => {
    if (!orderIds || !orderIds.length) return cb(null, []);
    const sql = `
      SELECT r.id, r.orderId, r.status, r.refundType, r.createdAt,
        (
          SELECT IFNULL(SUM(ri.qtyRequested * ri.unitPrice), 0)
          FROM refund_items ri
          WHERE ri.refundId = r.id
        ) AS requestedAmount
      FROM refunds r
      INNER JOIN (
        SELECT orderId, MAX(id) AS maxId
        FROM refunds
        WHERE orderId IN (?)
        GROUP BY orderId
      ) latest ON latest.maxId = r.id
    `;
    db.query(sql, [orderIds], cb);
  },

  getLatestRefundForOrder: (orderId, cb) => {
    const sql = `
      SELECT id, orderId, status, createdAt
      FROM refunds
      WHERE orderId = ?
      ORDER BY id DESC
      LIMIT 1
    `;
    db.query(sql, [orderId], (err, rows) => {
      if (err) return cb(err);
      cb(null, rows && rows[0] ? rows[0] : null);
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
          Refund.getEvidence(refundId, (evErr, evidence) => {
            if (evErr) return cb(evErr);
            cb(null, refund, items || [], transaction, evidence || []);
          });
        });
      });
    });
  },

  getRefundsForAdmin: (filters, cb) => {
    let sql = `
      SELECT r.*, u.username, o.total AS orderTotal, o.paymentMethod, o.paymentProvider,
        (
          SELECT IFNULL(SUM(ri.qtyRequested * ri.unitPrice), 0)
          FROM refund_items ri
          WHERE ri.refundId = r.id
        ) AS requestedAmount,
        (
          SELECT IFNULL(SUM(ri.lineRefundAmount), 0)
          FROM refund_items ri
          WHERE ri.refundId = r.id
        ) AS approvedAmount
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
      SELECT r.*, o.paymentMethod, o.paymentProvider, o.total AS orderTotal,
             o.paypalOrderId, o.paypalCaptureId, o.stripePaymentIntentId, o.netsTxnRetrievalRef,
             u.username
      FROM refunds r
      LEFT JOIN orders o ON o.id = r.orderId
      LEFT JOIN users u ON u.id = r.userId
      WHERE r.id = ?
      LIMIT 1
    `;
    const fallbackSql = `
      SELECT r.*, o.paymentMethod, o.paymentProvider, o.total AS orderTotal, u.username
      FROM refunds r
      LEFT JOIN orders o ON o.id = r.orderId
      LEFT JOIN users u ON u.id = r.userId
      WHERE r.id = ?
      LIMIT 1
    `;
    const queryDetail = (detailSql, allowFallback) => {
      db.query(detailSql, [refundId], (err, rows) => {
        if (err) {
          if (allowFallback && err.code === 'ER_BAD_FIELD_ERROR') {
            return queryDetail(fallbackSql, false);
          }
          return cb(err);
        }
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
            Refund.getEvidence(refundId, (evErr, evidence) => {
              if (evErr) return cb(evErr);
              cb(null, refund, items || [], transaction, evidence || []);
            });
          });
        });
      });
    };
    queryDetail(sql, true);
  },

  adminDecision: (refundId, adminId, decision, adminNote, inventoryDisposition, qtyApprovedMap, rejectionReason, cb) => {
    db.beginTransaction((err) => {
      if (err) return cb(err);
      const lockSql = 'SELECT status FROM refunds WHERE id = ? FOR UPDATE';
      db.query(lockSql, [refundId], (lockErr, rows) => {
        if (lockErr) return db.rollback(() => cb(lockErr));
        const refund = rows && rows[0] ? rows[0] : null;
        if (!refund) return db.rollback(() => cb(new Error('Refund not found')));
        const currentStatus = (refund.status || '').toLowerCase().trim();
        if (currentStatus !== 'requested') {
          return db.rollback(() => cb(new Error('Refund is not in requested status')));
        }
        const updateRefundSql = `
          UPDATE refunds
          SET status = ?, adminId = ?, adminNote = ?, inventoryDisposition = ?,
              approvedAt = ?, rejectedAt = ?, rejectionReason = ?
          WHERE id = ?
        `;
        const approvedAt = decision === 'approved' ? new Date() : null;
        const rejectedAt = decision === 'rejected' ? new Date() : null;
        const rejectionText = decision === 'rejected' ? (rejectionReason || adminNote || '') : null;
        const applyUpdate = (updateSql, updateParams, allowFallback) => {
          db.query(updateSql, updateParams, (updateErr) => {
            if (updateErr && allowFallback && updateErr.code === 'ER_BAD_FIELD_ERROR') {
              const fallbackSql = `
                UPDATE refunds
                SET status = ?, adminId = ?, adminNote = ?, inventoryDisposition = ?
                WHERE id = ?
              `;
              return applyUpdate(
                fallbackSql,
                [decision, adminId, adminNote || '', inventoryDisposition || null, refundId],
                false
              );
            }
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
          });
        };
        const params = [decision, adminId, adminNote || '', inventoryDisposition || null, approvedAt, rejectedAt, rejectionText, refundId];
        applyUpdate(updateRefundSql, params, true);
      });
    });
  },

  setProcessing: (refundId, adminId, cb) => {
    db.beginTransaction((err) => {
      if (err) return cb(err);
      const lockSql = 'SELECT status FROM refunds WHERE id = ? FOR UPDATE';
      db.query(lockSql, [refundId], (lockErr, rows) => {
        if (lockErr) return db.rollback(() => cb(lockErr));
        const refund = rows && rows[0] ? rows[0] : null;
        if (!refund) return db.rollback(() => cb(new Error('Refund not found')));
        const currentStatus = (refund.status || '').toLowerCase().trim();
        if (currentStatus !== 'approved' && currentStatus !== 'failed') {
          return db.rollback(() => cb(new Error('Refund must be approved or failed before processing')));
        }
        const updateSql = `
          UPDATE refunds
          SET status = 'processing', adminId = ?, processedAt = NOW(), failedReason = NULL
          WHERE id = ?
        `;
        db.query(updateSql, [adminId, refundId], (uErr) => {
          if (uErr && uErr.code === 'ER_BAD_FIELD_ERROR') {
            const fallbackSql = `UPDATE refunds SET status = 'processing', adminId = ? WHERE id = ?`;
            return db.query(fallbackSql, [adminId, refundId], (fErr) => {
              if (fErr) return db.rollback(() => cb(fErr));
              db.commit((commitErr) => (commitErr ? cb(commitErr) : cb(null)));
            });
          }
          if (uErr) return db.rollback(() => cb(uErr));
          db.commit((commitErr) => (commitErr ? cb(commitErr) : cb(null)));
        });
      });
    });
  },

  markRefunded: (refundId, adminId, provider, providerRef, amount, rawResponse, cb) => {
    db.beginTransaction((err) => {
      if (err) return cb(err);
      const lockSql = `
        SELECT r.status, r.orderId, o.total AS orderTotal
        FROM refunds r
        LEFT JOIN orders o ON o.id = r.orderId
        WHERE r.id = ?
        FOR UPDATE
      `;
      db.query(lockSql, [refundId], (lockErr, rows) => {
        if (lockErr) return db.rollback(() => cb(lockErr));
        const refund = rows && rows[0] ? rows[0] : null;
        if (!refund) return db.rollback(() => cb(new Error('Refund not found')));
        const currentStatus = (refund.status || '').toLowerCase().trim();
        if (currentStatus === 'refunded' || currentStatus === 'completed') {
          return db.rollback(() => cb(new Error('Refund already completed')));
        }
        if (currentStatus !== 'processing') {
          return db.rollback(() => cb(new Error('Refund is not in processing status')));
        }
        const totalSql = 'SELECT IFNULL(SUM(lineRefundAmount), 0) AS approvedTotal FROM refund_items WHERE refundId = ?';
        db.query(totalSql, [refundId], (totErr, totalRows) => {
          if (totErr) return db.rollback(() => cb(totErr));
          const approvedTotal = totalRows && totalRows[0] ? Number(totalRows[0].approvedTotal || 0) : 0;
          const orderTotal = Number(refund.orderTotal || 0);
          const isFull = orderTotal > 0 && approvedTotal >= orderTotal - 0.01;
          const orderStatus = isFull ? 'refunded' : 'partially_refunded';
          const checkTxnSql = 'SELECT id FROM refund_transactions WHERE refundId = ? LIMIT 1';
          db.query(checkTxnSql, [refundId], (checkErr, txnRows) => {
            if (checkErr) return db.rollback(() => cb(checkErr));
            const exists = txnRows && txnRows[0] ? true : false;
            const upsertTxn = (next) => {
              if (exists) {
                const updateTxn = `
                  UPDATE refund_transactions
                  SET provider = ?, providerRef = ?, amount = ?, currency = 'SGD', txnStatus = 'completed', rawResponse = ?
                  WHERE refundId = ?
                `;
                return db.query(updateTxn, [provider, providerRef || null, amount, rawResponse || null, refundId], next);
              }
              const insertTxn = `
                INSERT INTO refund_transactions (refundId, provider, providerRef, amount, currency, txnStatus, rawResponse)
                VALUES (?, ?, ?, ?, 'SGD', 'completed', ?)
              `;
              db.query(insertTxn, [refundId, provider, providerRef || null, amount, rawResponse || null], next);
            };
            upsertTxn((txnErr) => {
              if (txnErr) return db.rollback(() => cb(txnErr));
              const updateRefundSql = `
                UPDATE refunds
                SET status = 'refunded', adminId = ?, refundedAt = NOW(), failedReason = NULL
                WHERE id = ?
              `;
              db.query(updateRefundSql, [adminId, refundId], (uErr) => {
                if (uErr && uErr.code === 'ER_BAD_FIELD_ERROR') {
                  const fallbackRefundSql = `UPDATE refunds SET status = 'refunded', adminId = ? WHERE id = ?`;
                  return db.query(fallbackRefundSql, [adminId, refundId], (fErr) => {
                    if (fErr) return db.rollback(() => cb(fErr));
                    db.query('UPDATE orders SET status = ? WHERE id = ?', [orderStatus, refund.orderId], (oErr) => {
                      if (oErr) return db.rollback(() => cb(oErr));
                      db.commit((commitErr) => (commitErr ? cb(commitErr) : cb(null, { orderStatus })));
                    });
                  });
                }
                if (uErr) return db.rollback(() => cb(uErr));
                db.query('UPDATE orders SET status = ? WHERE id = ?', [orderStatus, refund.orderId], (oErr) => {
                  if (oErr) return db.rollback(() => cb(oErr));
                  db.commit((commitErr) => (commitErr ? cb(commitErr) : cb(null, { orderStatus })));
                });
              });
            });
          });
        });
      });
    });
  },

  markRefundProcessFailed: (refundId, adminId, provider, providerRef, amount, rawResponse, failedReason, cb) => {
    db.beginTransaction((err) => {
      if (err) return cb(err);
      const lockSql = 'SELECT status FROM refunds WHERE id = ? FOR UPDATE';
      db.query(lockSql, [refundId], (lockErr, rows) => {
        if (lockErr) return db.rollback(() => cb(lockErr));
        const refund = rows && rows[0] ? rows[0] : null;
        if (!refund) return db.rollback(() => cb(new Error('Refund not found')));
        const currentStatus = (refund.status || '').toLowerCase().trim();
        if (currentStatus !== 'processing') {
          return db.rollback(() => cb(new Error('Refund is not in processing status')));
        }
        const checkTxnSql = 'SELECT id FROM refund_transactions WHERE refundId = ? LIMIT 1';
        db.query(checkTxnSql, [refundId], (checkErr, txnRows) => {
          if (checkErr) return db.rollback(() => cb(checkErr));
          const exists = txnRows && txnRows[0] ? true : false;
          const upsertTxn = (next) => {
            if (exists) {
              const updateTxn = `
                UPDATE refund_transactions
                SET provider = ?, providerRef = ?, amount = ?, currency = 'SGD', txnStatus = 'failed', rawResponse = ?
                WHERE refundId = ?
              `;
              return db.query(updateTxn, [provider, providerRef || null, amount, rawResponse || null, refundId], next);
            }
            const insertTxn = `
              INSERT INTO refund_transactions (refundId, provider, providerRef, amount, currency, txnStatus, rawResponse)
              VALUES (?, ?, ?, ?, 'SGD', 'failed', ?)
            `;
            db.query(insertTxn, [refundId, provider, providerRef || null, amount, rawResponse || null], next);
          };
          upsertTxn((txnErr) => {
            if (txnErr) return db.rollback(() => cb(txnErr));
            const updateRefundSql = `
              UPDATE refunds
              SET status = 'failed', adminId = ?, failedReason = ?
              WHERE id = ?
            `;
            db.query(updateRefundSql, [adminId, failedReason || 'Refund failed', refundId], (uErr) => {
              if (uErr && uErr.code === 'ER_BAD_FIELD_ERROR') {
                const fallbackSql = `UPDATE refunds SET status = 'failed', adminId = ? WHERE id = ?`;
                return db.query(fallbackSql, [adminId, refundId], (fErr) => {
                  if (fErr) return db.rollback(() => cb(fErr));
                  db.commit((commitErr) => (commitErr ? cb(commitErr) : cb(null)));
                });
              }
              if (uErr) return db.rollback(() => cb(uErr));
              db.commit((commitErr) => (commitErr ? cb(commitErr) : cb(null)));
            });
          });
        });
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
            if (refund.paymentMethod === 'stripe') provider = 'stripe';
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
            } else if (provider === 'stripe') {
              proceed(`stripe_refund_${refundId}`);
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
