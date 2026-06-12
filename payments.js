// payments.js — Stripe Checkout + PayPal REST
const axios = require('axios');

// --- Prezzi (in centesimi) ---
const PRICES = {
  standard: parseInt(process.env.PRICE_STANDARD_CENTS || '1990', 10), // €19,90
  pro: parseInt(process.env.PRICE_PRO_CENTS || '3490', 10),           // €34,90
  studio: parseInt(process.env.PRICE_STUDIO_CENTS || '4990', 10),     // €49,90
};
const LABELS = {
  standard: 'Photodin Standard — 30 foto (risoluzione standard)',
  pro: 'Photodin Pro — 100 foto (alta risoluzione + ritocco)',
  studio: 'Photodin Studio — 120 foto in 4K (stampa)',
};
const priceCents = (pkg) => PRICES[pkg] || PRICES.standard;
const label = (pkg) => LABELS[pkg] || LABELS.standard;

// ===================== STRIPE =====================
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

async function createStripeCheckout(order, baseUrl) {
  if (!stripe) throw new Error('STRIPE_SECRET_KEY non configurata');
  return stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'eur',
        product_data: { name: label(order.package) },
        unit_amount: priceCents(order.package),
      },
      quantity: 1,
    }],
    metadata: { orderId: order.id },
    customer_email: order.email,
    success_url: `${baseUrl}/grazie.html?order=${order.id}`,
    cancel_url: `${baseUrl}/?canceled=1`,
  });
}

function verifyStripeWebhook(rawBody, signature) {
  if (!stripe) throw new Error('STRIPE_SECRET_KEY non configurata');
  return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

// ===================== PAYPAL =====================
const PP_BASE = (process.env.PAYPAL_ENV === 'live')
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

async function paypalToken() {
  if (!process.env.PAYPAL_CLIENT_ID) throw new Error('PAYPAL_CLIENT_ID non configurato');
  const { data } = await axios.post(
    `${PP_BASE}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth: { username: process.env.PAYPAL_CLIENT_ID, password: process.env.PAYPAL_CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );
  return data.access_token;
}

async function createPaypalOrder(order, baseUrl) {
  const token = await paypalToken();
  const value = (priceCents(order.package) / 100).toFixed(2);
  const { data } = await axios.post(
    `${PP_BASE}/v2/checkout/orders`,
    {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: order.id,
        description: label(order.package),
        amount: { currency_code: 'EUR', value },
      }],
      application_context: {
        brand_name: 'photodin',
        user_action: 'PAY_NOW',
        return_url: `${baseUrl}/api/orders/${order.id}/paypal/return`,
        cancel_url: `${baseUrl}/?canceled=1`,
      },
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return data; // { id, links: [...] }
}

async function capturePaypalOrder(paypalOrderId) {
  const token = await paypalToken();
  const { data } = await axios.post(
    `${PP_BASE}/v2/checkout/orders/${paypalOrderId}/capture`,
    {},
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return data; // { status: 'COMPLETED', purchase_units:[{reference_id}], ... }
}

module.exports = {
  PRICES, priceCents, label,
  stripeEnabled: () => !!stripe,
  paypalEnabled: () => !!process.env.PAYPAL_CLIENT_ID,
  createStripeCheckout, verifyStripeWebhook,
  createPaypalOrder, capturePaypalOrder,
};
