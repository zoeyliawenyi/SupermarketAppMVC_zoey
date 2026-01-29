const Refund = require('../models/Refund');

const AdminRefundController = {
  list: (req, res) => {
    const status = req.query.status || '';
    Refund.getRefundsForAdmin({ status }, (err, refunds) => {
      if (err) {
        console.error('Admin refund list error:', err);
        return res.render('adminRefunds', { refunds: [], status, user: req.session.user });
      }
      res.render('adminRefunds', { refunds: refunds || [], status, user: req.session.user });
    });
  },

  apiList: (req, res) => {
    const status = req.query.status || '';
    Refund.getRefundsForAdmin({ status }, (err, refunds) => {
      if (err) {
        console.error('Admin refund api list error:', err);
        return res.status(500).json({ status: 'error', message: 'Unable to load refunds' });
      }
      res.json({ status: 'ok', refunds: refunds || [] });
    });
  },

  detail: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    Refund.getRefundDetailForAdmin(refundId, (err, refund, items, transaction) => {
      if (err || !refund) {
        req.flash('error', 'Refund not found');
        return res.redirect('/admin/refunds');
      }
      res.render('adminRefundDetail', {
        refund,
        items: items || [],
        transaction,
        user: req.session.user
      });
    });
  },

  apiDetail: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    Refund.getRefundDetailForAdmin(refundId, (err, refund, items, transaction) => {
      if (err || !refund) {
        return res.status(404).json({ status: 'error', message: 'Refund not found' });
      }
      res.json({
        status: 'ok',
        refund,
        items: items || [],
        transaction: transaction || null
      });
    });
  },

  decision: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    const decision = req.body.decision === 'rejected' ? 'rejected' : 'approved';
    const adminNote = req.body.adminNote || '';
    const inventoryDisposition = req.body.inventoryDisposition || null;
    Refund.getRefundDetailForAdmin(refundId, (err, refund, items) => {
      if (err || !refund) {
        req.flash('error', 'Refund not found');
        return res.redirect('/admin/refunds');
      }
      const qtyApprovedMap = {};
      (items || []).forEach((item) => {
        const raw = req.body[`qtyApproved_${item.id}`];
        const qty = parseInt(raw, 10);
        if (!isNaN(qty)) qtyApprovedMap[item.id] = qty;
      });
      Refund.adminDecision(
        refundId,
        req.session.user.id,
        decision,
        adminNote,
        inventoryDisposition,
        qtyApprovedMap,
        (updateErr) => {
          if (updateErr) {
            console.error('Refund decision error:', updateErr);
            req.flash('error', updateErr.message || 'Unable to update refund decision');
          } else {
            req.flash('success', 'Refund decision updated');
          }
          res.redirect(`/admin/refunds/${refundId}`);
        }
      );
    });
  },

  apiDecision: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    const decision = req.body.decision === 'rejected' ? 'rejected' : 'approved';
    const adminNote = req.body.adminNote || '';
    const inventoryDisposition = req.body.inventoryDisposition || null;
    Refund.getRefundDetailForAdmin(refundId, (err, refund, items) => {
      if (err || !refund) {
        return res.status(404).json({ status: 'error', message: 'Refund not found' });
      }
      const qtyApprovedMap = {};
      (items || []).forEach((item) => {
        const raw = req.body[`qtyApproved_${item.id}`];
        const qty = parseInt(raw, 10);
        if (!isNaN(qty)) qtyApprovedMap[item.id] = qty;
      });
      Refund.adminDecision(
        refundId,
        req.session.user.id,
        decision,
        adminNote,
        inventoryDisposition,
        qtyApprovedMap,
        (updateErr) => {
          if (updateErr) {
            console.error('Refund decision error:', updateErr);
            return res.status(400).json({ status: 'error', message: updateErr.message || 'Unable to update refund decision' });
          }
          res.json({ status: 'ok', refundId, decision });
        }
      );
    });
  },

  initiate: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    Refund.initiateRefund(refundId, (err, result) => {
      if (err) {
        console.error('Refund initiate error:', err);
        req.flash('error', err.message || 'Unable to initiate refund');
      } else {
        const message = result && result.existed ? 'Refund already initiated' : 'Refund initiated';
        req.flash('success', message);
      }
      res.redirect(`/admin/refunds/${refundId}`);
    });
  },

  apiInitiate: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    Refund.initiateRefund(refundId, (err, result) => {
      if (err) {
        console.error('Refund initiate error:', err);
        return res.status(400).json({ status: 'error', message: err.message || 'Unable to initiate refund' });
      }
      res.json({ status: 'ok', refundId, alreadyInitiated: !!(result && result.existed) });
    });
  },

  complete: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    const rawResponse = JSON.stringify({ source: 'admin', result: 'completed' });
    Refund.markRefundCompleted(refundId, rawResponse, (err) => {
      if (err) {
        console.error('Refund complete error:', err);
        req.flash('error', err.message || 'Unable to mark refund completed');
      } else {
        req.flash('success', 'Refund marked completed');
      }
      res.redirect(`/admin/refunds/${refundId}`);
    });
  },

  apiComplete: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    const rawResponse = JSON.stringify({ source: 'admin', result: 'completed' });
    Refund.markRefundCompleted(refundId, rawResponse, (err) => {
      if (err) {
        console.error('Refund complete error:', err);
        return res.status(400).json({ status: 'error', message: err.message || 'Unable to mark refund completed' });
      }
      res.json({ status: 'ok', refundId });
    });
  },

  fail: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    const rawResponse = JSON.stringify({ source: 'admin', result: 'failed' });
    Refund.markRefundFailed(refundId, rawResponse, (err) => {
      if (err) {
        console.error('Refund fail error:', err);
        req.flash('error', err.message || 'Unable to mark refund failed');
      } else {
        req.flash('error', 'Refund marked manual review');
      }
      res.redirect(`/admin/refunds/${refundId}`);
    });
  }
,
  apiFail: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    const rawResponse = JSON.stringify({ source: 'admin', result: 'failed' });
    Refund.markRefundFailed(refundId, rawResponse, (err) => {
      if (err) {
        console.error('Refund fail error:', err);
        return res.status(400).json({ status: 'error', message: err.message || 'Unable to mark refund failed' });
      }
      res.json({ status: 'ok', refundId, statusAfter: 'manual_review' });
    });
  }
};

module.exports = AdminRefundController;
