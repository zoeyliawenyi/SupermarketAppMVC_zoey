const db = require('../db');

const Subscription = {
  upsertFromStripe: (payload, cb) => {
    const sql = `
      INSERT INTO subscriptions
        (userId, stripeSubscriptionId, stripePriceId, stripeCustomerId, status, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        userId = VALUES(userId),
        stripePriceId = VALUES(stripePriceId),
        stripeCustomerId = VALUES(stripeCustomerId),
        status = VALUES(status),
        currentPeriodStart = VALUES(currentPeriodStart),
        currentPeriodEnd = VALUES(currentPeriodEnd),
        cancelAtPeriodEnd = VALUES(cancelAtPeriodEnd),
        updatedAt = CURRENT_TIMESTAMP
    `;
    db.query(sql, [
      payload.userId,
      payload.stripeSubscriptionId,
      payload.stripePriceId,
      payload.stripeCustomerId,
      payload.status,
      payload.currentPeriodStart,
      payload.currentPeriodEnd,
      payload.cancelAtPeriodEnd ? 1 : 0
    ], cb);
  },

  getByUser: (userId, cb) => {
    const sql = `
      SELECT *
      FROM subscriptions
      WHERE userId = ?
      ORDER BY createdAt DESC
      LIMIT 1
    `;
    db.query(sql, [userId], (err, rows) => {
      if (err) return cb(err);
      cb(null, rows && rows[0] ? rows[0] : null);
    });
  },

  updateStatusByStripeId: (stripeSubscriptionId, status, periodStart, periodEnd, cancelAtPeriodEnd, cb) => {
    const sql = `
      UPDATE subscriptions
      SET status = ?, currentPeriodStart = ?, currentPeriodEnd = ?, cancelAtPeriodEnd = ?, updatedAt = CURRENT_TIMESTAMP
      WHERE stripeSubscriptionId = ?
    `;
    db.query(sql, [status, periodStart, periodEnd, cancelAtPeriodEnd ? 1 : 0, stripeSubscriptionId], cb);
  }
};

module.exports = Subscription;
