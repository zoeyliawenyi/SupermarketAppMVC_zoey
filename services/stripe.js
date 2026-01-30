const Stripe = require('stripe');

let client = null;

const getStripe = () => {
  const secret = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secret) {
    throw new Error('Stripe secret key not configured');
  }
  if (!client) {
    const apiVersion = (process.env.STRIPE_API_VERSION || '').trim();
    client = new Stripe(secret, apiVersion ? { apiVersion } : undefined);
  }
  return client;
};

module.exports = { getStripe };
