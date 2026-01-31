const db = require('../db');

const NetsTransaction = {
  findLatestByRef: (txnRetrievalRef, cb) => {
    const sql = `
      SELECT *
      FROM nets_transactions
      WHERE txnRetrievalRef = ?
      ORDER BY createdAt DESC
      LIMIT 1
    `;
    db.query(sql, [txnRetrievalRef], (err, rows) => {
      if (err) return cb(err);
      cb(null, rows && rows[0] ? rows[0] : null);
    });
  },

  findLatestByOrderId: (orderId, cb) => {
    const sql = `
      SELECT *
      FROM nets_transactions
      WHERE orderId = ?
      ORDER BY createdAt DESC
      LIMIT 1
    `;
    db.query(sql, [orderId], (err, rows) => {
      if (err) return cb(err);
      cb(null, rows && rows[0] ? rows[0] : null);
    });
  },

  findCourseInitIdByRef: (txnRetrievalRef, cb) => {
    const sql = `
      SELECT courseInitId
      FROM nets_transactions
      WHERE txnRetrievalRef = ?
      ORDER BY createdAt DESC
      LIMIT 1
    `;
    db.query(sql, [txnRetrievalRef], (err, rows) => {
      if (err) return cb(err);
      cb(null, rows && rows[0] ? rows[0].courseInitId : null);
    });
  },

  insert: (txn, cb) => {
    const sql = `
      INSERT INTO nets_transactions
      (userId, orderId, txnRetrievalRef, courseInitId, amount, currency, status, rawResponse)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const raw = typeof txn.rawResponse === 'string' ? txn.rawResponse : JSON.stringify(txn.rawResponse || {});
    db.query(
      sql,
      [
        txn.userId,
        txn.orderId,
        txn.txnRetrievalRef,
        txn.courseInitId || null,
        txn.amount,
        txn.currency || 'SGD',
        txn.status || 'pending',
        raw
      ],
      cb
    );
  },

  updateStatusByRef: (txnRetrievalRef, status, cb) => {
    const sql = 'UPDATE nets_transactions SET status = ? WHERE txnRetrievalRef = ?';
    db.query(sql, [status, txnRetrievalRef], cb);
  },

  updateStatusByOrderId: (orderId, status, cb) => {
    const sql = 'UPDATE nets_transactions SET status = ? WHERE orderId = ?';
    db.query(sql, [status, orderId], cb);
  },

  updateStatusById: (id, status, cb) => {
    const sql = 'UPDATE nets_transactions SET status = ? WHERE id = ?';
    db.query(sql, [status, id], cb);
  },

  deleteByRef: (txnRetrievalRef, cb) => {
    const sql = 'DELETE FROM nets_transactions WHERE txnRetrievalRef = ?';
    db.query(sql, [txnRetrievalRef], cb);
  },

  deleteByOrderId: (orderId, cb) => {
    const sql = 'DELETE FROM nets_transactions WHERE orderId = ?';
    db.query(sql, [orderId], cb);
  }
};

module.exports = NetsTransaction;
