const db = require('../db');

const UserSubscription = {
  upsertFromStripe: (payload, callback) => {
    const {
      userId,
      stripeCustomerId,
      stripeSubscriptionId,
      status,
      priceId,
      currentPeriodEnd,
    } = payload;
    const sql = `
      INSERT INTO user_subscriptions
        (userId, stripeCustomerId, stripeSubscriptionId, status, priceId, currentPeriodEnd)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        stripeCustomerId = VALUES(stripeCustomerId),
        status = VALUES(status),
        priceId = VALUES(priceId),
        currentPeriodEnd = VALUES(currentPeriodEnd),
        updatedAt = CURRENT_TIMESTAMP
    `;
    db.query(
      sql,
      [
        userId,
        stripeCustomerId || null,
        stripeSubscriptionId || null,
        status || 'inactive',
        priceId || null,
        currentPeriodEnd || null,
      ],
      callback
    );
  },

  findByUserId: (userId, callback) => {
    const sql = `
      SELECT *
      FROM user_subscriptions
      WHERE userId = ?
      ORDER BY updatedAt DESC, createdAt DESC
      LIMIT 1
    `;
    db.query(sql, [userId], (err, results) => {
      if (err) return callback(err);
      callback(null, results && results[0] ? results[0] : null);
    });
  },

  findByStripeSubscriptionId: (stripeSubscriptionId, callback) => {
    const sql = `
      SELECT *
      FROM user_subscriptions
      WHERE stripeSubscriptionId = ?
      LIMIT 1
    `;
    db.query(sql, [stripeSubscriptionId], (err, results) => {
      if (err) return callback(err);
      callback(null, results && results[0] ? results[0] : null);
    });
  },

  updateStatusBySubscriptionId: (stripeSubscriptionId, status, currentPeriodEnd, callback) => {
    const sql = `
      UPDATE user_subscriptions
      SET status = ?, currentPeriodEnd = ?, updatedAt = CURRENT_TIMESTAMP
      WHERE stripeSubscriptionId = ?
    `;
    db.query(sql, [status, currentPeriodEnd || null, stripeSubscriptionId], callback);
  },
};

module.exports = UserSubscription;
