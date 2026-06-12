// payments.js — Stripe Checkout
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
    // Nessun payment_method_types esplicito: Stripe mostra automaticamente
    // i metodi attivi nel dashboard (carte, Apple Pay, Google Pay, Klarna...).
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

module.exports = {
  PRICES, priceCents, label,
  stripeEnabled: () => !!stripe,
  createStripeCheckout, verifyStripeWebhook,
};
