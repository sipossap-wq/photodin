// server.js — backend photodin (Astria + Stripe + PayPal)
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { createTune, createPrompt } = require('./astria');
const { getStyles } = require('./styles');
const pay = require('./payments');

const app = express();
const PUBLIC_URL = process.env.PUBLIC_BASE_URL || '';
const TEST_MODE = process.env.ASTRIA_TEST_MODE === '1'; // branch=fast, generazione gratuita
// Permette di avviare un ordine senza pagamento (per provare la qualità reale).
// Attivo automaticamente in TEST_MODE, oppure forzato con ALLOW_DEV_PAY=1.
const ALLOW_DEV_PAY = TEST_MODE || process.env.ALLOW_DEV_PAY === '1';

// --- Storage su file (niente DB esterno in fase di validazione) ---
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS = path.join(DATA_DIR, 'uploads');
const DB = path.join(DATA_DIR, 'orders.json');
fs.mkdirSync(UPLOADS, { recursive: true });
if (!fs.existsSync(DB)) fs.writeFileSync(DB, '{}');
const load = () => JSON.parse(fs.readFileSync(DB, 'utf8'));
const save = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ============================================================
// IMPORTANTE: il webhook Stripe deve ricevere il body RAW,
// quindi va registrato PRIMA di express.json().
// ============================================================
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = pay.verifyStripeWebhook(req.body, req.headers['stripe-signature']);
  } catch (e) {
    console.error('Webhook Stripe non valido:', e.message);
    return res.status(400).send(`Webhook error: ${e.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const orderId = event.data.object.metadata?.orderId;
    try { await markPaidAndStart(orderId, 'stripe'); }
    catch (e) { console.error('Avvio generazione fallito:', e.response?.data || e.message); }
  }
  res.json({ received: true });
});

app.use(express.json());
app.use('/', express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 15 },
});

// ============================================================
// 1. Crea ordine (stato: pending_payment). Salva le foto, NON
//    chiama ancora Astria: la generazione parte dopo il pagamento.
// ============================================================
app.post('/api/orders', upload.array('photos', 15), (req, res) => {
  try {
    const email = (req.body.email || '').trim();
    const pkg = (req.body.package || 'base').toLowerCase();
    const subjectClass = (req.body.subjectClass || 'person').toLowerCase();

    if (!email) return res.status(400).json({ error: 'Email mancante.' });
    if (!req.files || req.files.length < 4)
      return res.status(400).json({ error: 'Carica almeno 4 foto.' });

    const id = newId();
    const dir = path.join(UPLOADS, id);
    fs.mkdirSync(dir, { recursive: true });
    // Nome file solo per indice (evita path traversal)
    req.files.forEach((f, i) => fs.writeFileSync(path.join(dir, `${i}.jpg`), f.buffer));

    const db = load();
    db[id] = {
      id, email, package: pkg, subjectClass,
      status: 'pending_payment',
      priceCents: pay.priceCents(pkg),
      createdAt: new Date().toISOString(),
      photoCount: req.files.length,
      tuneId: null, eta: null,
      images: [], promptsTotal: 0, promptsDone: 0,
    };
    save(db);

    res.json({
      orderId: id,
      status: 'pending_payment',
      amount: (pay.priceCents(pkg) / 100).toFixed(2),
      methods: { stripe: pay.stripeEnabled(), paypal: pay.paypalEnabled() },
      testMode: TEST_MODE,
      devPay: ALLOW_DEV_PAY,
    });
  } catch (e) {
    console.error('Errore /api/orders:', e.message);
    res.status(500).json({ error: 'Errore nella creazione dell\'ordine.' });
  }
});

// ============================================================
// 2a. Checkout STRIPE → restituisce l'URL a cui reindirizzare
// ============================================================
app.post('/api/orders/:id/checkout/stripe', async (req, res) => {
  try {
    const o = load()[req.params.id];
    if (!o) return res.status(404).json({ error: 'Ordine non trovato.' });
    if (!PUBLIC_URL) return res.status(500).json({ error: 'PUBLIC_BASE_URL non configurato.' });
    const session = await pay.createStripeCheckout(o, PUBLIC_URL);
    res.json({ url: session.url });
  } catch (e) {
    console.error('Errore Stripe checkout:', e.message);
    res.status(500).json({ error: 'Errore nell\'avvio del pagamento Stripe.' });
  }
});

// ============================================================
// 2b. Checkout PAYPAL → crea l'ordine e restituisce l'URL approve
// ============================================================
app.post('/api/orders/:id/checkout/paypal', async (req, res) => {
  try {
    const o = load()[req.params.id];
    if (!o) return res.status(404).json({ error: 'Ordine non trovato.' });
    if (!PUBLIC_URL) return res.status(500).json({ error: 'PUBLIC_BASE_URL non configurato.' });
    const ppo = await pay.createPaypalOrder(o, PUBLIC_URL);
    const approve = (ppo.links || []).find((l) => l.rel === 'approve');
    const db = load(); db[o.id].paypalOrderId = ppo.id; save(db);
    res.json({ url: approve?.href });
  } catch (e) {
    console.error('Errore PayPal create:', e.response?.data || e.message);
    res.status(500).json({ error: 'Errore nell\'avvio del pagamento PayPal.' });
  }
});

// 2c. Ritorno da PayPal → cattura il pagamento e avvia la generazione
app.get('/api/orders/:id/paypal/return', async (req, res) => {
  try {
    const cap = await pay.capturePaypalOrder(req.query.token);
    if (cap.status === 'COMPLETED') {
      await markPaidAndStart(req.params.id, 'paypal');
      return res.redirect(`/grazie.html?order=${req.params.id}`);
    }
    res.redirect('/?error=paypal');
  } catch (e) {
    console.error('Errore PayPal capture:', e.response?.data || e.message);
    res.redirect('/?error=paypal');
  }
});

// ============================================================
// 3. Callback Astria
// ============================================================
app.post('/api/callbacks/tune', (req, res) => {
  const { order } = req.query;
  const db = load();
  if (db[order] && db[order].status === 'training') {
    db[order].status = 'generating';
    save(db);
    console.log(`[${order}] modello pronto, generazione in corso`);
  }
  res.sendStatus(200);
});

app.post('/api/callbacks/prompt', (req, res) => {
  const { order } = req.query;
  const db = load();
  const o = db[order];
  if (o) {
    const imgs = req.body.images || (req.body.prompt && req.body.prompt.images) || [];
    o.images.push(...imgs);
    o.promptsDone += 1;
    if (o.promptsDone >= o.promptsTotal) {
      o.status = 'completed';
      console.log(`[${order}] COMPLETATO — ${o.images.length} foto. TODO: email a ${o.email}`);
      // TODO: invio email + cancellazione foto di training (GDPR, entro 24-48h)
    }
    save(db);
  }
  res.sendStatus(200);
});

// ============================================================
// 4. Stato ordine (polling lato cliente)
// ============================================================
app.get('/api/orders/:id', (req, res) => {
  const o = load()[req.params.id];
  if (!o) return res.status(404).json({ error: 'Ordine non trovato.' });
  res.json({
    id: o.id, status: o.status,
    progress: `${o.promptsDone}/${o.promptsTotal}`,
    eta: o.eta, images: o.images,
  });
});

// 5. Rigenerazione gratuita (garanzia)
app.post('/api/orders/:id/regenerate', async (req, res) => {
  try {
    const o = load()[req.params.id];
    if (!o || !o.tuneId) return res.status(404).json({ error: 'Ordine non trovato.' });
    const text = req.body.text ||
      `ohwx ${o.subjectClass}, professional corporate headshot, soft studio lighting, neutral background`;
    const p = await createPrompt(o.tuneId, {
      text, num_images: 5,
      callback: `${PUBLIC_URL}/api/callbacks/prompt?order=${o.id}`,
    });
    const db = load();
    db[o.id].promptsTotal += 1;
    db[o.id].status = 'generating';
    save(db);
    res.json({ ok: true, promptId: p.id });
  } catch (e) {
    console.error('Errore regenerate:', e.response?.data || e.message);
    res.status(500).json({ error: 'Errore nella rigenerazione.' });
  }
});

// Solo in TEST_MODE: avvia la generazione senza pagamento reale (per provare il flusso)
app.post('/api/orders/:id/dev-pay', async (req, res) => {
  if (!ALLOW_DEV_PAY) return res.status(403).json({ error: 'Avvio senza pagamento non abilitato.' });
  try {
    await markPaidAndStart(req.params.id, 'dev');
    res.json({ ok: true });
  } catch (e) {
    console.error('dev-pay ERRORE → status:', e.response?.status, '| body:', JSON.stringify(e.response?.data), '| msg:', e.message);
    res.status(500).json({ error: 'Errore avvio generazione.' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, testMode: TEST_MODE }));

// ============================================================
// Helpers: pagamento confermato → avvio generazione su Astria
// ============================================================
async function markPaidAndStart(orderId, method) {
  const db = load();
  const o = db[orderId];
  if (!o || o.status !== 'pending_payment') return; // idempotente
  o.status = 'paid';
  o.paymentMethod = method;
  o.paidAt = new Date().toISOString();
  save(db);
  console.log(`[${orderId}] pagato con ${method} — avvio generazione`);
  await startGeneration(orderId);
}

async function startGeneration(orderId) {
  const db = load();
  const o = db[orderId];
  const dir = path.join(UPLOADS, orderId);
  const files = fs.readdirSync(dir).map((fn) => ({
    buffer: fs.readFileSync(path.join(dir, fn)),
    originalname: fn,
  }));
  const styles = getStyles(o.package, o.subjectClass);

  o.status = 'training';
  o.promptsTotal = styles.length;
  o.promptsDone = 0;
  o.images = [];
  save(db);

  const tune = await createTune({
    title: orderId,
    name: o.subjectClass,
    images: files,
    branch: TEST_MODE ? 'fast' : undefined,
    callbackTune: `${PUBLIC_URL}/api/callbacks/tune?order=${orderId}`,
    prompts: styles.map((s) => ({
      text: s.text,
      num_images: s.num_images,
      callback: `${PUBLIC_URL}/api/callbacks/prompt?order=${orderId}`,
    })),
  });

  const db2 = load();
  db2[orderId].tuneId = tune.id;
  db2[orderId].eta = tune.eta;
  save(db2);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`photodin backend su http://localhost:${PORT}`);
  console.log(`  Stripe: ${pay.stripeEnabled() ? 'on' : 'off'} · PayPal: ${pay.paypalEnabled() ? 'on' : 'off'} · TestMode: ${TEST_MODE ? 'on (branch=fast)' : 'off'}`);
  if (!PUBLIC_URL) console.warn('⚠  PUBLIC_BASE_URL non impostato: callback e pagamenti non funzioneranno.');
});
