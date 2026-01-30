const Refund = require('../models/Refund');
const { getStripe } = require('../services/stripe');
const paypalService = require('../services/paypal');

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
    Refund.getRefundDetailForAdmin(refundId, (err, refund, items, transaction, evidence) => {
      if (err || !refund) {
        if (err) console.error('Admin refund detail error:', err);
        req.flash('error', 'Refund not found');
        return res.redirect('/admin/refunds');
      }
      res.render('adminRefundDetail', {
        refund,
        items: items || [],
        transaction,
        evidence: evidence || [],
        user: req.session.user
      });
    });
  },

  apiDetail: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    Refund.getRefundDetailForAdmin(refundId, (err, refund, items, transaction, evidence) => {
      if (err || !refund) {
        return res.status(404).json({ status: 'error', message: 'Refund not found' });
      }
      res.json({
        status: 'ok',
        refund,
        items: items || [],
        transaction: transaction || null,
        evidence: evidence || []
      });
    });
  },

  decision: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    const decision = req.body.decision === 'rejected' ? 'rejected' : 'approved';
    const adminNote = req.body.adminNote || '';
    const rejectionReason = req.body.rejectionReason || '';
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
        rejectionReason,
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
    const rejectionReason = req.body.rejectionReason || '';
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
        rejectionReason,
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

  approve: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
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
        'approved',
        adminNote,
        inventoryDisposition,
        qtyApprovedMap,
        '',
        (updateErr) => {
          if (updateErr) {
            console.error('Refund approve error:', updateErr);
            req.flash('error', updateErr.message || 'Unable to approve refund');
          } else {
            console.log('[refund] approved', { refundId, adminId: req.session.user.id });
            req.flash('success', 'Refund approved');
          }
          res.redirect(`/admin/refunds/${refundId}`);
        }
      );
    });
  },

  reject: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    const rejectionReason = (req.body.rejectionReason || '').trim();
    const adminNote = req.body.adminNote || '';
    if (!rejectionReason) {
      req.flash('error', 'Rejection reason is required');
      return res.redirect(`/admin/refunds/${refundId}`);
    }
    Refund.adminDecision(
      refundId,
      req.session.user.id,
      'rejected',
      adminNote,
      null,
      {},
      rejectionReason,
      (updateErr) => {
        if (updateErr) {
          console.error('Refund reject error:', updateErr);
          req.flash('error', updateErr.message || 'Unable to reject refund');
        } else {
          console.log('[refund] rejected', { refundId, adminId: req.session.user.id });
          req.flash('success', 'Refund rejected');
        }
        res.redirect(`/admin/refunds/${refundId}`);
      }
    );
  },

  process: async (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    Refund.getRefundDetailForAdmin(refundId, async (err, refund, items) => {
      if (err || !refund) {
        req.flash('error', 'Refund not found');
        return res.redirect('/admin/refunds');
      }
      const status = (refund.status || '').toLowerCase();
      if (status === 'refunded') {
        req.flash('error', 'Refund already completed');
        return res.redirect(`/admin/refunds/${refundId}`);
      }
      let amount = 0;
      (items || []).forEach((it) => {
        amount += Number(it.lineRefundAmount || 0);
      });
      if (!amount || amount <= 0) {
        req.flash('error', 'Refund amount must be greater than 0');
        return res.redirect(`/admin/refunds/${refundId}`);
      }
      Refund.setProcessing(refundId, req.session.user.id, async (setErr) => {
        if (setErr) {
          console.error('Refund process start error:', setErr);
          req.flash('error', setErr.message || 'Unable to start refund processing');
          return res.redirect(`/admin/refunds/${refundId}`);
        }
        let provider = 'manual';
        const providerHint = (refund.paymentProvider || refund.paymentMethod || '').toLowerCase();
        if (providerHint.includes('nets')) provider = 'nets';
        if (providerHint.includes('paypal')) provider = 'paypal';
        if (providerHint.includes('stripe')) provider = 'stripe';
        let providerRef = null;
        let rawResponse = null;
        try {
          if (provider === 'stripe') {
            if (!refund.stripePaymentIntentId) {
              throw new Error('Missing Stripe payment_intent_id');
            }
            const stripe = getStripe();
            const stripeRefund = await stripe.refunds.create({
              payment_intent: refund.stripePaymentIntentId,
              amount: Math.round(amount * 100),
            });
            providerRef = stripeRefund.id;
            rawResponse = JSON.stringify(stripeRefund);
          } else if (provider === 'paypal') {
            if (!refund.paypalCaptureId) {
              throw new Error('Missing PayPal capture id');
            }
            const paypalRefund = await paypalService.refundCapture(refund.paypalCaptureId, amount);
            providerRef = paypalRefund.id || paypalRefund.refund_id || null;
            rawResponse = JSON.stringify(paypalRefund);
          } else if (provider === 'nets') {
            providerRef = `nets_refund_${refundId}_${Date.now()}`;
            rawResponse = JSON.stringify({ simulated: true, providerRef });
          } else {
            providerRef = `manual_refund_${refundId}_${Date.now()}`;
            rawResponse = JSON.stringify({ manual: true, providerRef });
          }
          Refund.markRefunded(
            refundId,
            req.session.user.id,
            provider,
            providerRef,
            amount,
            rawResponse,
            (doneErr) => {
              if (doneErr) {
                console.error('Refund finalize error:', doneErr);
                req.flash('error', doneErr.message || 'Unable to mark refund completed');
              } else {
                console.log('[refund] processed', { refundId, provider, providerRef, amount });
                req.flash('success', 'Refund processed');
              }
              res.redirect(`/admin/refunds/${refundId}`);
            }
          );
        } catch (providerErr) {
          console.error('Refund provider error:', providerErr);
          Refund.markRefundProcessFailed(
            refundId,
            req.session.user.id,
            provider,
            providerRef,
            amount,
            rawResponse,
            providerErr.message || 'Refund provider error',
            (failErr) => {
              if (failErr) {
                console.error('Refund failed update error:', failErr);
              }
              req.flash('error', providerErr.message || 'Refund processing failed');
              res.redirect(`/admin/refunds/${refundId}`);
            }
          );
        }
      });
    });
  },

  apiApprove: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
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
        'approved',
        adminNote,
        inventoryDisposition,
        qtyApprovedMap,
        '',
        (updateErr) => {
          if (updateErr) {
            console.error('Refund approve error:', updateErr);
            return res.status(400).json({ status: 'error', message: updateErr.message || 'Unable to approve refund' });
          }
          res.json({ status: 'ok', refundId, decision: 'approved' });
        }
      );
    });
  },

  apiReject: (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    const rejectionReason = (req.body.rejectionReason || '').trim();
    const adminNote = req.body.adminNote || '';
    if (!rejectionReason) {
      return res.status(400).json({ status: 'error', message: 'Rejection reason is required' });
    }
    Refund.adminDecision(
      refundId,
      req.session.user.id,
      'rejected',
      adminNote,
      null,
      {},
      rejectionReason,
      (updateErr) => {
        if (updateErr) {
          console.error('Refund reject error:', updateErr);
          return res.status(400).json({ status: 'error', message: updateErr.message || 'Unable to reject refund' });
        }
        res.json({ status: 'ok', refundId, decision: 'rejected' });
      }
    );
  },

  apiProcess: async (req, res) => {
    const refundId = parseInt(req.params.refundId, 10);
    Refund.getRefundDetailForAdmin(refundId, async (err, refund, items) => {
      if (err || !refund) {
        return res.status(404).json({ status: 'error', message: 'Refund not found' });
      }
      let amount = 0;
      (items || []).forEach((it) => {
        amount += Number(it.lineRefundAmount || 0);
      });
      if (!amount || amount <= 0) {
        return res.status(400).json({ status: 'error', message: 'Refund amount must be greater than 0' });
      }
      Refund.setProcessing(refundId, req.session.user.id, async (setErr) => {
        if (setErr) {
          console.error('Refund process start error:', setErr);
          return res.status(400).json({ status: 'error', message: setErr.message || 'Unable to start refund processing' });
        }
        let provider = 'manual';
        const providerHint = (refund.paymentProvider || refund.paymentMethod || '').toLowerCase();
        if (providerHint.includes('nets')) provider = 'nets';
        if (providerHint.includes('paypal')) provider = 'paypal';
        if (providerHint.includes('stripe')) provider = 'stripe';
        let providerRef = null;
        let rawResponse = null;
        try {
          if (provider === 'stripe') {
            if (!refund.stripePaymentIntentId) throw new Error('Missing Stripe payment_intent_id');
            const stripe = getStripe();
            const stripeRefund = await stripe.refunds.create({
              payment_intent: refund.stripePaymentIntentId,
              amount: Math.round(amount * 100),
            });
            providerRef = stripeRefund.id;
            rawResponse = JSON.stringify(stripeRefund);
          } else if (provider === 'paypal') {
            if (!refund.paypalCaptureId) throw new Error('Missing PayPal capture id');
            const paypalRefund = await paypalService.refundCapture(refund.paypalCaptureId, amount);
            providerRef = paypalRefund.id || paypalRefund.refund_id || null;
            rawResponse = JSON.stringify(paypalRefund);
          } else if (provider === 'nets') {
            providerRef = `nets_refund_${refundId}_${Date.now()}`;
            rawResponse = JSON.stringify({ simulated: true, providerRef });
          } else {
            providerRef = `manual_refund_${refundId}_${Date.now()}`;
            rawResponse = JSON.stringify({ manual: true, providerRef });
          }
          Refund.markRefunded(
            refundId,
            req.session.user.id,
            provider,
            providerRef,
            amount,
            rawResponse,
            (doneErr) => {
              if (doneErr) {
                console.error('Refund finalize error:', doneErr);
                return res.status(400).json({ status: 'error', message: doneErr.message || 'Unable to mark refund completed' });
              }
              res.json({ status: 'ok', refundId, provider, providerRef, amount });
            }
          );
        } catch (providerErr) {
          console.error('Refund provider error:', providerErr);
          Refund.markRefundProcessFailed(
            refundId,
            req.session.user.id,
            provider,
            providerRef,
            amount,
            rawResponse,
            providerErr.message || 'Refund provider error',
            (failErr) => {
              if (failErr) console.error('Refund failed update error:', failErr);
              res.status(400).json({ status: 'error', message: providerErr.message || 'Refund processing failed' });
            }
          );
        }
      });
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
