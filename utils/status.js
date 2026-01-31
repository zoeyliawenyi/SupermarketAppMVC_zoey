const normalizeStatus = (status = '') =>
  String(status).trim().toLowerCase().replace(/\s+/g, '_');

const isCancelledStatus = (statusKey = '') => statusKey.startsWith('cancelled');

const isPendingPaymentStatus = (statusKey = '') =>
  statusKey === 'pending_payment' || statusKey === 'awaiting_payment';

const isFailedPaymentStatus = (statusKey = '') => statusKey === 'payment_failed';

const isPaidStatus = (statusKey = '') =>
  [
    'payment_successful',
    'packing',
    'out_for_delivery',
    'ready_for_pickup',
    'pickup_pending',
    'completed',
    'refund_rejected',
    'refunded',
    'partially_refunded'
  ].includes(statusKey);

const canInvoiceForStatus = (statusKey = '') =>
  isPaidStatus(statusKey) && !isCancelledStatus(statusKey) &&
  !['refund_requested', 'refund_completed'].includes(statusKey);

module.exports = {
  normalizeStatus,
  isCancelledStatus,
  isPendingPaymentStatus,
  isFailedPaymentStatus,
  isPaidStatus,
  canInvoiceForStatus
};
