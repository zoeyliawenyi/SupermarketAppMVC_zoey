const buildCheckoutSnapshot = (req, cart, defaultPayment) => {
  const selection = Array.isArray(req.session.checkoutSelection)
    ? req.session.checkoutSelection.map((v) => Number(v))
    : [];

  const cartForOrder = selection.length
    ? (cart || []).filter((item) => selection.includes(Number(item.productId)))
    : (cart || []);

  const shipping = req.session.checkoutShipping || {
    contact: req.session.user?.contact || '',
    address: req.session.user?.address || '',
    option: 'pickup',
    payment: defaultPayment || 'nets-qr',
  };

  if (!shipping.contact) shipping.contact = req.session.user?.contact || '';
  if (!shipping.address) shipping.address = req.session.user?.address || '';
  if (!shipping.option) shipping.option = 'pickup';
  if (!shipping.payment) shipping.payment = defaultPayment || 'nets-qr';
  if (shipping.payment === 'paynow') shipping.payment = 'nets-qr';

  const shippingCost = shipping.option === 'delivery' ? 2.0 : 0;
  const subtotal = (cartForOrder || []).reduce(
    (sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0),
    0
  );
  const total = subtotal + shippingCost;

  return {
    cartForOrder,
    selection,
    shipping,
    shippingCost,
    subtotal,
    total,
  };
};

const computeTotalsFromItems = (items, shippingOption) => {
  const subtotal = (items || []).reduce(
    (sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0),
    0
  );
  const shippingCost = shippingOption === 'delivery' ? 2.0 : 0;
  const total = subtotal + shippingCost;
  return { subtotal, shippingCost, total };
};

module.exports = {
  buildCheckoutSnapshot,
  computeTotalsFromItems,
};
