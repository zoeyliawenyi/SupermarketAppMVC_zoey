const fetch = require('node-fetch');
require('dotenv').config();

const PAYPAL_CLIENT = (process.env.PAYPAL_CLIENT_ID || '').trim();
const PAYPAL_SECRET = (process.env.PAYPAL_CLIENT_SECRET || '').trim();
const PAYPAL_API = (process.env.PAYPAL_API || 'https://api.sandbox.paypal.com').replace(/\/+$/, '');

async function getAccessToken() {
  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${PAYPAL_CLIENT}:${PAYPAL_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`PayPal token fetch failed (${response.status}): ${payload}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('PayPal token response missing access_token');
  }
  return data.access_token;
}

async function createOrder(amount) {
  const formattedAmount = Number(amount || 0).toFixed(2);
  const accessToken = await getAccessToken();
  const response = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: 'SGD',
            value: formattedAmount,
          },
        },
      ],
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`PayPal create order failed (${response.status}): ${payload}`);
  }

  return response.json();
}

async function captureOrder(orderId) {
  if (!orderId) throw new Error('Missing orderId for PayPal capture');
  const accessToken = await getAccessToken();
  const response = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`PayPal capture order failed (${response.status}): ${payload}`);
  }

  return response.json();
}

module.exports = {
  createOrder,
  captureOrder,
};
