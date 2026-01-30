const db = require('../db');

const UsageRecord = {
  create: (userId, stripeSubscriptionItemId, quantity, eventType, cb) => {
    const sql = `
      INSERT INTO usage_records (userId, stripeSubscriptionItemId, quantity, eventType)
      VALUES (?, ?, ?, ?)
    `;
    db.query(sql, [userId, stripeSubscriptionItemId || null, quantity, eventType], cb);
  }
};

module.exports = UsageRecord;
