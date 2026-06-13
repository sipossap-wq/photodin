// server.js — backend photodin (Astria + Stripe)
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createTune, createPrompt, getTune, listPrompts, deleteTune } = require('./astria');
const { buildPrompts, STYLE_CATALOG } = require('./styles');
const pay = require('./payments');
const email = require('./email');

const app = express();
// trust proxy DEVE combaciare col deploy reale: il rate limiter usa req.ip, e
// se ci fidiamo di X-Forwarded-For senza un proxy davanti, un attaccante può
// falsificarlo e aggirare il limite. Default 1 (ngrok = 1 hop). Imposta:
//   TRUST_PROXY=false  → nessun proxy (usa l'IP della connessione)
//   TRUST_PROXY=2      → due hop di proxy fidati
const TP = process.env.TRUST_PROXY ?? '1';
app.set('trust proxy', TP === 'false' ? false : (/^\d+$/.test(TP) ? parseInt(TP, 10) : TP));

// Header di sicurezza + CSP. script-src 'self' (niente inline) è la vera difesa
// anti-XSS: per questo gli script delle pagine sono in /app.js e /grazie.js.
// img-src consente le foto Astria (CDN/S3 con host variabili).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // attributi style statici nelle pagine
      imgSrc: ["'self'", 'https:', 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  },
}));
const PUBLIC_URL = process.env.PUBLIC_BASE_URL || '';
const TEST_MODE = process.env.ASTRIA_TEST_MODE === '1'; // branch=fast, generazione gratuita
const IS_PROD = process.env.NODE_ENV === 'production';
// Avvio senza pagamento: utile in sviluppo. In PRODUZIONE è SEMPRE disabilitato,
// qualunque sia la env (niente generazioni gratuite per chi conosce un orderId).
const ALLOW_DEV_PAY = !IS_PROD && (TEST_MODE || process.env.ALLOW_DEV_PAY === '1');

// --- Storage su file (niente DB esterno in fase di validazione) ---
// DATA_DIR configurabile: su host con filesystem effimero (es. Render) va
// puntato a un DISCO PERSISTENTE montato (es. /var/data), altrimenti ordini e
// foto si perdono a ogni redeploy.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS = path.join(DATA_DIR, 'uploads');
const TMP_UPLOADS = path.join(DATA_DIR, 'tmp'); // staging per i file multipart
const DB = path.join(DATA_DIR, 'orders.json');
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(TMP_UPLOADS, { recursive: true });
// Svuota i temporanei orfani all'avvio (residui di upload interrotti/crash).
try { for (const fn of fs.readdirSync(TMP_UPLOADS)) fs.unlinkSync(path.join(TMP_UPLOADS, fn)); } catch (e) {}
if (!fs.existsSync(DB)) fs.writeFileSync(DB, '{}');
const load = () => JSON.parse(fs.readFileSync(DB, 'utf8'));
// Scrittura ATOMICA (tmp + rename): un crash a metà scrittura non può più
// corrompere orders.json e perdere tutti gli ordini.
const save = (d) => {
  const tmp = DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DB);
};
// REGOLA: tra load() e save() non ci devono MAI essere await, altrimenti due
// richieste concorrenti si sovrascrivono (lost update). Tutte le mutazioni
// sotto seguono questo pattern: load → modifica sincrona → save.
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Segreto nei callback Astria: senza, chiunque conosca un orderId può
// completare ordini con immagini false. OBBLIGATORIO: il server non parte senza.
const CB_SECRET = process.env.CALLBACK_SECRET || '';
if (!CB_SECRET) {
  console.error('FATAL: CALLBACK_SECRET non impostato. Genera una stringa casuale lunga (es. `openssl rand -hex 32`) e mettila in .env. Il server non parte senza, per non lasciare i callback Astria aperti a chiunque.');
  process.exit(1);
}
const cbSuffix = `&secret=${encodeURIComponent(CB_SECRET)}`;
// Confronto a tempo costante per evitare timing attack sul segreto.
const cbOk = (req) => {
  const got = Buffer.from(String(req.query.secret || ''));
  const exp = Buffer.from(CB_SECRET);
  return got.length === exp.length && crypto.timingSafeEqual(got, exp);
};
// Verifica il token segreto dell'ordine (confronto a tempo costante).
function tokenOk(order, supplied) {
  if (!order || !order.token) return false;
  const got = Buffer.from(String(supplied || ''));
  const exp = Buffer.from(order.token);
  return got.length === exp.length && crypto.timingSafeEqual(got, exp);
}

// Accetta solo URL http(s) assolute (anti XSS/SSRF nelle immagini dei callback).
function isHttpUrl(u) {
  try {
    const p = new URL(String(u));
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch { return false; }
}

// Email a cui mandare gli allarmi (ordini pagati con generazione fallita).
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
function alertAdmin(subject, text) {
  if (!ADMIN_EMAIL) return Promise.resolve();
  return email.sendEmail({ to: ADMIN_EMAIL, subject: `[photodin] ${subject}`, html: `<pre>${text}</pre>` })
    .catch((e) => console.error('alertAdmin:', e.message));
}

// Invio dell'email di consegna con RETRY serio: emailSent viene messo a true SOLO
// se l'invio riesce (o se l'email è disabilitata: in quel caso sendEmail risolve
// senza inviare). Se fallisce, emailSent resta false e il watchdog ritenta.
// Idempotente: non reinvia se già inviata.
async function sendCompletionEmail(orderId) {
  const o = load()[orderId];
  if (!o || o.emailSent) return;
  const link = `${PUBLIC_URL}/grazie.html?order=${o.id}&t=${encodeURIComponent(o.token || '')}`;
  try {
    await email.sendPhotosReadyEmail(o, link);
    const db = load();
    if (db[orderId]) { db[orderId].emailSent = true; save(db); }
  } catch (e) {
    const db = load();
    if (db[orderId]) { db[orderId].emailAttempts = (db[orderId].emailAttempts || 0) + 1; save(db); }
    console.error(`[${orderId}] invio email consegna fallito (tentativo ${(o.emailAttempts || 0) + 1}), ritento dal watchdog:`, e.response?.data || e.message);
  }
}

// Controllo qualità input: foto piccole/sgranate → somiglianza scarsa e
// risultati "AI". Richiediamo almeno 512px sul lato corto (i selfie moderni
// sono ≥1080px, quindi blocca solo screenshot/thumbnail/foto compresse da chat).
const MIN_SIDE = parseInt(process.env.MIN_PHOTO_SIDE || '512', 10);
// Lato lungo massimo dell'immagine inviata ad Astria: riduce peso upload/costo
// senza perdere qualità utile per gli headshot.
const MAX_SIDE = parseInt(process.env.MAX_PHOTO_SIDE || '2048', 10);

// Controlla le dimensioni via sharp (supporta anche HEIC/WEBP, non solo JPEG/PNG).
// Tiene conto dell'orientamento EXIF (autoOrient). Una foto alla volta da disco.
async function checkPhotoQuality(files) {
  const bad = [];
  for (let i = 0; i < files.length; i++) {
    try {
      const m = await sharp(files[i].path, { failOn: 'error' }).metadata();
      // dopo l'auto-orient le dimensioni "vere" possono essere scambiate
      const w = m.autoOrient?.width || m.width;
      const h = m.autoOrient?.height || m.height;
      if (!w || !h || Math.min(w, h) < MIN_SIDE) bad.push(i + 1);
    } catch (e) { bad.push(i + 1); } // formato non riconosciuto / file corrotto
  }
  return bad;
}

// Normalizza una foto: corregge l'orientamento EXIF, ridimensiona entro MAX_SIDE,
// re-encoda in JPEG e RIMUOVE i metadati (EXIF/GPS) — un dato in meno verso Astria
// e una difesa contro file "polyglot" (sharp/libvips decodifica e ri-codifica).
async function normalizePhoto(srcPath, destPath) {
  await sharp(srcPath, { failOn: 'error', limitInputPixels: 268402689 }) // ~16k×16k, anti decompression bomb
    .rotate() // applica l'orientamento EXIF
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toFile(destPath); // sharp non copia i metadati salvo .withMetadata()
}

// Rimuove i file temporanei di multer (da chiamare su ogni uscita di /api/orders).
function rmTemp(files) {
  (files || []).forEach((f) => { try { fs.unlinkSync(f.path); } catch (e) {} });
}

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
    const session = event.data.object;
    const orderId = session.metadata?.orderId;
    const o = load()[orderId];
    if (!o) {
      console.error(`[stripe] sessione completata per ordine sconosciuto: ${orderId}`);
    } else {
      // NON fidarsi del solo evento "completed": verifica che sia davvero pagato,
      // con importo e valuta ESATTI del pacchetto. Evita di avviare generazioni
      // costose su sessioni non pagate (metodi async) o manomesse.
      const expected = pay.priceCents(o.package);
      const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
      const amountOk = session.amount_total === expected;
      const currencyOk = (session.currency || '').toLowerCase() === 'eur';
      if (!paid) {
        console.warn(`[${orderId}] webhook: payment_status='${session.payment_status}', non avvio.`);
      } else if (!amountOk || !currencyOk) {
        console.error(`[${orderId}] webhook: importo/valuta non corrispondono (atteso ${expected} eur, ricevuto ${session.amount_total} ${session.currency}).`);
        alertAdmin(`Pagamento sospetto: ${orderId}`,
          `Importo/valuta non corrispondenti.\nAtteso: ${expected} eur (${o.package}).\nRicevuto: ${session.amount_total} ${session.currency}.\nGenerazione NON avviata.`);
      } else {
        // Pagamento valido → marca 'paid'. La generazione partirà quando il
        // cliente carica le foto sulla pagina di caricamento.
        markPaid(orderId, 'stripe');
      }
    }
  }
  res.json({ received: true });
});

app.use(express.json());
app.use('/', express.static(path.join(__dirname, 'public')));

// diskStorage invece di memoryStorage: i file vanno su disco a stream, così una
// richiesta con 30 foto da 12MB non tiene mai ~360MB in RAM (DoS di memoria).
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_UPLOADS),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex')),
  }),
  limits: { fileSize: 12 * 1024 * 1024, files: 30 },
});

// Middleware upload con gestione errori: i limiti superati tornano un JSON 400
// (non un 500 HTML) e i temporanei già scritti vengono ripuliti.
function uploadPhotos(req, res, next) {
  upload.array('photos', 30)(req, res, (err) => {
    if (err) {
      rmTemp(req.files);
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Una foto supera il limite di 12MB.'
        : err.code === 'LIMIT_FILE_COUNT' ? 'Troppe foto (massimo 30).'
        : 'Upload non valido.';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}

// Rate limit in-memory (fixed window), senza dipendenze esterne. Argina l'abuso
// di /api/orders: creazione massiva di ordini non pagati (riempie il disco) e
// upload ripetuti che saturano la memoria. Per più processi serve uno store
// condiviso (es. Redis).
function rateLimiter({ windowMs, max }) {
  let hits = new Map();
  const t = setInterval(() => { hits = new Map(); }, windowMs);
  if (t.unref) t.unref();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (n > max) return res.status(429).json({ error: 'Troppe richieste. Riprova tra qualche minuto.' });
    next();
  };
}
const ordersLimiter = rateLimiter({ windowMs: 10 * 60 * 1000, max: 20 });

// Validazione email "ragionevole" (formato base; la verifica vera è il fatto
// che il cliente riceva la mail di consegna).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBJECT_CLASSES = ['man', 'woman', 'person'];

// ============================================================
// 1. Crea ordine (stato: awaiting_payment). NESSUNA foto qui: il cliente
//    PRIMA paga, POI carica le foto (POST /api/orders/:id/photos). Vantaggio
//    GDPR: nessun dato biometrico salvato per chi non completa il pagamento.
// ============================================================
app.post('/api/orders', ordersLimiter, (req, res) => {
  try {
    const customerEmail = (req.body.email || '').trim();
    const pkg = (req.body.package || 'standard').toLowerCase();
    let subjectClass = (req.body.subjectClass || 'person').toLowerCase();
    if (!SUBJECT_CLASSES.includes(subjectClass)) subjectClass = 'person';
    const consent = req.body.consent === 'true' || req.body.consent === 'on' || req.body.consent === true;
    let styles = req.body.styles || [];
    if (typeof styles === 'string') styles = [styles];

    if (!customerEmail) return res.status(400).json({ error: 'Email mancante.' });
    if (!EMAIL_RE.test(customerEmail) || customerEmail.length > 254)
      return res.status(400).json({ error: 'Email non valida.' });
    if (!consent) return res.status(400).json({ error: 'Devi accettare il consenso e i termini per continuare.' });
    if (!pay.PRICES[pkg]) return res.status(400).json({ error: 'Pacchetto non valido.' });

    const id = newId();
    // Token segreto per-ordine: serve al cliente per pagare, caricare le foto e
    // consultare il PROPRIO ordine. 32 byte base64url.
    const token = crypto.randomBytes(24).toString('base64url');

    const db = load();
    db[id] = {
      id, token, email: customerEmail, package: pkg, subjectClass, styles,
      status: 'awaiting_payment',
      priceCents: pay.priceCents(pkg),
      createdAt: new Date().toISOString(),
      consent: true, consentAt: new Date().toISOString(),
      photoCount: 0,
      tuneId: null, eta: null,
      images: [], promptsTotal: 0, promptsDone: 0,
    };
    save(db);

    res.json({
      orderId: id,
      token,
      status: 'awaiting_payment',
      amount: (pay.priceCents(pkg) / 100).toFixed(2),
      methods: { stripe: pay.stripeEnabled() },
      testMode: TEST_MODE,
      devPay: ALLOW_DEV_PAY,
    });
  } catch (e) {
    console.error('Errore /api/orders:', e.message);
    res.status(500).json({ error: 'Errore nella creazione dell\'ordine.' });
  }
});

// ============================================================
// 1bis. Caricamento foto DOPO il pagamento. Richiede token e ordine 'paid'.
//       Valida, normalizza con sharp, salva e AVVIA la generazione.
//       Ripetibile finché l'ordine è 'paid' (se le foto non passano la
//       validazione il cliente può ricaricare senza ripagare).
// ============================================================
app.post('/api/orders/:id/photos', ordersLimiter, uploadPhotos, async (req, res) => {
  try {
    const o = load()[req.params.id];
    if (!o || !tokenOk(o, req.query.t)) { rmTemp(req.files); return res.status(403).json({ error: 'Accesso non autorizzato.' }); }
    if (o.status === 'awaiting_payment') { rmTemp(req.files); return res.status(402).json({ error: 'Completa prima il pagamento.' }); }
    if (o.status !== 'paid') { rmTemp(req.files); return res.status(409).json({ error: 'Foto già caricate o ordine già avviato.' }); }
    // Foto già caricate (anche se l'avvio è fallito e l'ordine è tornato 'paid'):
    // niente re-upload, ci pensa il watchdog a riprovare la generazione.
    if (o.photoCount > 0) { rmTemp(req.files); return res.status(409).json({ error: 'Foto già caricate, generazione in corso.' }); }

    if (!req.files || req.files.length < 6) {
      rmTemp(req.files); return res.status(400).json({ error: 'Carica almeno 6 foto (consigliate 8-16, varie per sfondo e luce).' });
    }
    if (!TEST_MODE) {
      const bad = await checkPhotoQuality(req.files);
      if (bad.length) {
        rmTemp(req.files);
        return res.status(400).json({ error: `Le foto n° ${bad.join(', ')} sono troppo piccole o non valide: usa foto originali di almeno ${MIN_SIDE}px (no screenshot o foto compresse da chat).` });
      }
    }

    const id = o.id;
    const dir = path.join(UPLOADS, id);
    fs.mkdirSync(dir, { recursive: true });
    // Normalizza con sharp (orientamento, resize, JPEG, niente EXIF) → {indice}.jpg
    try {
      for (let i = 0; i < req.files.length; i++) {
        await normalizePhoto(req.files[i].path, path.join(dir, `${i}.jpg`));
      }
    } catch (imgErr) {
      rmTemp(req.files);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      console.error(`[${id}] foto non leggibile:`, imgErr.message);
      return res.status(400).json({ error: 'Una delle foto non è leggibile. Usa immagini valide (JPEG, PNG o HEIC).' });
    }
    rmTemp(req.files);

    // Claim ATOMICO: solo se ancora 'paid' segniamo le foto e passiamo a 'training'.
    // Blocca avvii doppi da un secondo upload concorrente (che ora vede !== 'paid').
    const db = load();
    if (!db[id] || db[id].status !== 'paid') return res.status(409).json({ error: 'Ordine già avviato.' });
    db[id].photoCount = req.files.length;
    db[id].status = 'training';
    save(db);
    console.log(`[${id}] foto caricate dopo pagamento: ${req.files.length} — avvio generazione`);

    tryStartGeneration(id).catch((e) => console.error('Avvio generazione fallito:', e.response?.data || e.message));
    res.json({ ok: true, orderId: id });
  } catch (e) {
    rmTemp(req.files);
    console.error('Errore /api/orders/:id/photos:', e.message);
    res.status(500).json({ error: 'Errore nel caricamento delle foto.' });
  }
});

// ============================================================
// 2a. Checkout STRIPE → restituisce l'URL a cui reindirizzare
// ============================================================
app.post('/api/orders/:id/checkout/stripe', ordersLimiter, async (req, res) => {
  try {
    const o = load()[req.params.id];
    // Token + risposta uniforme: senza, l'endpoint sarebbe un oracolo di
    // esistenza ordini e un amplificatore di chiamate verso l'API Stripe.
    if (!o || !tokenOk(o, req.query.t)) return res.status(403).json({ error: 'Accesso non autorizzato.' });
    // Solo ordini ancora da pagare: evita un secondo pagamento su ordine già pagato.
    if (o.status !== 'awaiting_payment') return res.status(409).json({ error: 'Ordine già pagato o avviato.' });
    if (!PUBLIC_URL) return res.status(500).json({ error: 'PUBLIC_BASE_URL non configurato.' });
    // RIUSO sessione: se ne esiste una ancora 'open', restituisci quella invece di
    // crearne una nuova → niente doppio addebito da due tab/click.
    if (o.stripeSessionId) {
      try {
        const existing = await pay.getStripeSession(o.stripeSessionId);
        if (existing) {
          // sessione ancora valida → riusa la stessa URL (no doppia sessione)
          if (existing.status === 'open' && existing.url) return res.json({ url: existing.url });
          // già pagata ma webhook non ancora arrivato → NON creare una nuova
          // sessione (eviti il doppio addebito); l'ordine è in elaborazione.
          if (existing.status === 'complete' || existing.payment_status === 'paid') {
            return res.status(409).json({ error: 'Pagamento già ricevuto, in elaborazione.' });
          }
        }
      } catch (e) { /* sessione non recuperabile: ne creo una nuova */ }
    }
    const session = await pay.createStripeCheckout(o, PUBLIC_URL);
    // Salva l'id sessione per il riuso (load→modifica→save sincrono).
    const db = load();
    if (db[o.id]) { db[o.id].stripeSessionId = session.id; save(db); }
    res.json({ url: session.url });
  } catch (e) {
    console.error('Errore Stripe checkout:', e.message);
    res.status(500).json({ error: 'Errore nell\'avvio del pagamento Stripe.' });
  }
});

// ============================================================
// 3. Callback Astria
// ============================================================
app.post('/api/callbacks/tune', (req, res) => {
  if (!cbOk(req)) return res.sendStatus(403);
  const { order } = req.query;
  const db = load();
  const o = db[order];
  if (o && o.status === 'training') {
    o.status = 'generating';
    save(db);
    console.log(`[${order}] modello pronto, generazione in corso`);
  }
  res.sendStatus(200);
});

app.post('/api/callbacks/prompt', (req, res) => {
  if (!cbOk(req)) return res.sendStatus(403);
  const { order } = req.query;
  const db = load();
  const o = db[order];
  if (o) {
    const body = req.body || {};
    const promptId = (body.prompt && body.prompt.id) ?? body.id;
    const imgs = body.images || (body.prompt && body.prompt.images) || [];
    // dedup + valida: accetta solo URL http(s) (anti XSS/SSRF da callback falsi)
    imgs.forEach((u) => { if (isHttpUrl(u) && !o.images.includes(u)) o.images.push(u); });
    // IDEMPOTENZA: Astria può ritentare lo stesso callback. Contiamo i prompt
    // completati per ID univoco invece di incrementare alla cieca, così un
    // retry non gonfia promptsDone (che porterebbe a un completamento errato).
    o.donePromptIds = o.donePromptIds || [];
    if (promptId != null) {
      if (!o.donePromptIds.includes(promptId)) o.donePromptIds.push(promptId);
      o.promptsDone = o.donePromptIds.length;
    } else {
      o.promptsDone = (o.promptsDone || 0) + 1; // fallback senza id
    }
    // Completamento elaborato UNA volta sola (flag notified). L'email ha il suo
    // flag separato (emailSent) col retry: vedi sendCompletionEmail/watchdog.
    let justCompleted = false;
    if (o.promptsTotal > 0 && o.promptsDone >= o.promptsTotal && !o.notified) {
      o.status = 'completed';
      o.completedAt = new Date().toISOString();
      o.notified = true;
      justCompleted = true;
      console.log(`[${order}] COMPLETATO — ${o.images.length} foto. Invio email al cliente.`);
    }
    save(db);
    if (justCompleted) sendCompletionEmail(order); // async, con retry dal watchdog
  }
  res.sendStatus(200);
});

// ============================================================
// 4. Stato ordine (polling lato cliente)
// ============================================================
app.get('/api/orders/:id', (req, res) => {
  const o = load()[req.params.id];
  // Risposta UNIFORME per "non esiste" e "token errato": altrimenti la
  // differenza 404/403 rivelerebbe quali orderId esistono (enumerazione).
  if (!o || !tokenOk(o, req.query.t)) return res.status(403).json({ error: 'Accesso non autorizzato.' });
  res.json({
    id: o.id, status: o.status,
    progress: `${o.promptsDone}/${o.promptsTotal}`,
    eta: o.eta, images: o.images,
  });
});

// 5. Rigenerazione gratuita (garanzia) — con limiti anti-abuso:
//    max REGEN_LIMIT per ordine e mai dopo il cleanup (il tune non esiste più).
const REGEN_LIMIT = parseInt(process.env.REGEN_LIMIT || '2', 10);
app.post('/api/orders/:id/regenerate', async (req, res) => {
  try {
    const o = load()[req.params.id];
    // Token PRIMA di tutto e risposta uniforme: nessun oracolo di esistenza,
    // e nessuna generazione a TUO carico su Astria da parte di estranei.
    if (!o || !tokenOk(o, req.query.t)) return res.status(403).json({ error: 'Accesso non autorizzato.' });
    if (!o.tuneId) return res.status(409).json({ error: 'Generazione non ancora avviata.' });
    if (o.cleaned) return res.status(410).json({ error: 'Ordine scaduto: i dati sono stati cancellati (GDPR).' });
    if ((o.regens || 0) >= REGEN_LIMIT)
      return res.status(429).json({ error: 'Hai già usato tutte le rigenerazioni incluse. Scrivici se c\'è un problema con le foto.' });
    // Prompt SEMPRE dal catalogo interno: il testo non è mai controllato dal
    // client (altrimenti sarebbe iniezione arbitraria di prompt sul tuo account).
    const corporate = STYLE_CATALOG.find((s) => s.id === 'corporate');
    const text = `ohwx ${o.subjectClass}, ${corporate.text}`;
    const p = await createPrompt(o.tuneId, {
      text, num_images: 5,
      callback: `${PUBLIC_URL}/api/callbacks/prompt?order=${o.id}${cbSuffix}`,
    });
    const db = load();
    db[o.id].promptsTotal += 1;
    db[o.id].regens = (db[o.id].regens || 0) + 1;
    db[o.id].status = 'generating';
    db[o.id].notified = false;  // la nuova generazione potrà ri-completare…
    db[o.id].emailSent = false; // …e ri-notificare il cliente a fine re-roll
    save(db);
    res.json({ ok: true, promptId: p.id });
  } catch (e) {
    console.error('Errore regenerate:', e.response?.data || e.message);
    res.status(500).json({ error: 'Errore nella rigenerazione.' });
  }
});

// Solo fuori produzione: simula il pagamento (marca 'paid'); poi il cliente
// carica le foto come nel flusso reale.
app.post('/api/orders/:id/dev-pay', (req, res) => {
  if (!ALLOW_DEV_PAY) return res.status(403).json({ error: 'Avvio senza pagamento non abilitato.' });
  try {
    const o = load()[req.params.id];
    if (!o || !tokenOk(o, req.query.t)) return res.status(403).json({ error: 'Accesso non autorizzato.' });
    markPaid(req.params.id, 'dev');
    res.json({ ok: true });
  } catch (e) {
    console.error('dev-pay ERRORE:', e.message);
    res.status(500).json({ error: 'Errore simulazione pagamento.' });
  }
});

// Catalogo stili (per la pagina d'ordine)
app.get('/api/styles', (req, res) => {
  res.json(STYLE_CATALOG.map(({ id, label, desc }) => ({ id, label, desc })));
});

app.get('/health', (req, res) => res.json({ ok: true, testMode: TEST_MODE }));

// ============================================================
// Helpers: pagamento confermato → ordine 'paid' (in attesa di foto).
// La generazione parte SOLO quando il cliente carica le foto (/photos).
// ============================================================
function markPaid(orderId, method) {
  const db = load();
  const o = db[orderId];
  if (!o || o.status !== 'awaiting_payment') return; // idempotente
  o.status = 'paid';
  o.paymentMethod = method;
  o.paidAt = new Date().toISOString();
  save(db);
  console.log(`[${orderId}] pagato con ${method} — in attesa del caricamento foto`);
}

// Avvio con recovery: se Astria fallisce, l'ordine torna 'paid' e il watchdog
// riprova (max 3 tentativi). Cliente pagante ≠ buco nero: dopo l'ultimo
// tentativo parte un'email di allarme all'admin.
const MAX_START_ATTEMPTS = 3;
async function tryStartGeneration(orderId) {
  try {
    await startGeneration(orderId);
  } catch (e) {
    const detail = JSON.stringify(e.response?.data) || e.message;
    const db = load();
    const o = db[orderId];
    if (!o) return;
    o.status = 'paid'; // torna in coda per il watchdog
    o.startAttempts = (o.startAttempts || 0) + 1;
    o.lastStartError = detail;
    save(db);
    console.error(`[${orderId}] avvio generazione fallito (tentativo ${o.startAttempts}/${MAX_START_ATTEMPTS}):`, detail);
    if (o.startAttempts >= MAX_START_ATTEMPTS) {
      await alertAdmin(`ORDINE PAGATO BLOCCATO: ${orderId}`,
        `Ordine ${orderId} (${o.email}, ${o.package}) pagato ma generazione fallita ${o.startAttempts} volte.\nUltimo errore: ${detail}\nIntervieni manualmente.`);
    }
  }
}

async function startGeneration(orderId) {
  const db = load();
  const o = db[orderId];
  const dir = path.join(UPLOADS, orderId);
  const files = fs.readdirSync(dir).map((fn) => ({
    buffer: fs.readFileSync(path.join(dir, fn)),
    originalname: fn,
  }));
  console.log(`[${orderId}] foto lette da disco per Astria: ${files.length}`);
  // Tetto foto per i TEST (es. TEST_MAX_PHOTOS=10): genera poche foto per spendere poco.
  // Lascia vuoto / 0 in produzione.
  const cap = parseInt(process.env.TEST_MAX_PHOTOS || '0', 10);
  const styles = buildPrompts(o.styles, o.package, o.subjectClass, cap > 0 ? cap : undefined);

  // Qualità per pacchetto: super_resolution + inpaint_faces SEMPRE attivi.
  // Il face inpainting è la leva n°1 contro l'effetto "viso AI": senza,
  // anche il pacchetto base sembra finto e genera richieste di rimborso.
  const RES = {
    standard: { superRes: true, faceCorrect: true },
    pro:      { superRes: true, faceCorrect: true },
    studio:   { superRes: true, faceCorrect: true },
  };
  const res = RES[o.package] || RES.standard;

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
    superRes: res.superRes,
    faceCorrect: res.faceCorrect,
    callbackTune: `${PUBLIC_URL}/api/callbacks/tune?order=${orderId}${cbSuffix}`,
    prompts: styles.map((s) => ({
      text: s.text,
      num_images: s.num_images,
      callback: `${PUBLIC_URL}/api/callbacks/prompt?order=${orderId}${cbSuffix}`,
    })),
  });

  const db2 = load();
  db2[orderId].tuneId = tune.id;
  db2[orderId].eta = tune.eta;
  save(db2);
}

// ============================================================
// Cancellazione automatica dei dati (GDPR): foto caricate +
// modello e immagini su Astria, dopo la finestra di conservazione.
// ============================================================
const RETENTION_HOURS = parseInt(process.env.RETENTION_HOURS || '48', 10);
// TTL breve per gli ordini MAI pagati: sono dati biometrici di chi non ha
// completato l'acquisto, vanno rimossi in fretta (default 120 min).
const PENDING_TTL_MIN = parseInt(process.env.PENDING_TTL_MINUTES || '120', 10);

async function cleanup() {
  const snapshot = load(); // sola lettura per decidere chi scade
  const now = Date.now();
  for (const id of Object.keys(snapshot)) {
    const o = snapshot[id];
    if (o.cleaned) continue;

    // Ordini mai pagati abbandonati: scadono presto (non hanno foto su disco,
    // ma teniamo pulito il registro). I 'paid' senza foto seguono la retention
    // normale (il cliente ha pagato: non li buttiamo dopo pochi minuti).
    if (o.status === 'awaiting_payment') {
      const ageMin = (now - new Date(o.createdAt).getTime()) / 60000;
      if (ageMin >= PENDING_TTL_MIN) {
        const db = load();
        const cur = db[id];
        if (cur && !cur.cleaned) {
          cur.cleaned = true;
          cur.cleanedAt = new Date().toISOString();
          cur.status = 'expired';
          save(db);
          console.log(`[${id}] ordine non pagato scaduto`);
        }
      }
      continue;
    }

    const ref = o.completedAt || o.createdAt;
    const ageH = (now - new Date(ref).getTime()) / 3600000;
    // cancella se: completato da oltre RETENTION_HOURS, oppure ordine fermo da molto tempo
    const expired = (o.completedAt && ageH >= RETENTION_HOURS) || ageH >= RETENTION_HOURS + 96;
    if (!expired) continue;

    // IO/await PRIMA di toccare il DB, così non teniamo lo stato in mano
    // durante la chiamata di rete (evita il lost-update con altre richieste).
    try { fs.rmSync(path.join(UPLOADS, id), { recursive: true, force: true }); } catch (e) {}
    if (o.tuneId) {
      try { await deleteTune(o.tuneId); }
      catch (e) { console.error(`[${id}] deleteTune:`, e.response?.status || e.message); }
    }

    // Mutazione atomica: load → modifica sincrona → save, senza await in mezzo.
    const db = load();
    const cur = db[id];
    if (!cur || cur.cleaned) continue;
    cur.cleaned = true;
    cur.cleanedAt = new Date().toISOString();
    cur.images = [];
    cur.status = 'expired';
    save(db);
    console.log(`[${id}] dati cancellati (GDPR)`);
  }
}
// Ogni 15 min: abbastanza frequente da onorare il TTL breve degli ordini non pagati.
setInterval(() => cleanup().catch((e) => console.error('cleanup:', e.message)), 15 * 60 * 1000);

// ============================================================
// WATCHDOG: rete di sicurezza contro gli ordini bloccati.
// 1) Ordini 'paid' fermi → riprova l'avvio della generazione.
// 2) Ordini 'training'/'generating' fermi → interroga Astria e riconcilia
//    lo stato (recupera i callback persi per riavvii/deploy/timeout).
// ============================================================
const WATCHDOG_MIN = parseInt(process.env.WATCHDOG_MINUTES || '10', 10);

async function watchdog() {
  if (TEST_MODE) return; // in test i tune sono mock
  const now = Date.now();
  const snapshot = load(); // sola lettura per decidere chi controllare
  for (const id of Object.keys(snapshot)) {
    const o = snapshot[id];
    if (o.cleaned) continue;

    // 0) email di consegna non ancora inviata su ordine completato: ritenta.
    if (o.status === 'completed' && !o.emailSent) {
      await sendCompletionEmail(id);
      continue;
    }

    // 0bis) ordine 'training'/'generating' SENZA tuneId (es. crash tra i due
    //       save in startGeneration): rimettilo in coda così il ramo 'paid' riprova.
    if ((o.status === 'training' || o.status === 'generating') && !o.tuneId) {
      const ageMin = (now - new Date(o.paidAt || o.createdAt).getTime()) / 60000;
      if (ageMin >= 3 && (o.startAttempts || 0) < MAX_START_ATTEMPTS) {
        const db = load();
        if (db[id] && !db[id].tuneId && !db[id].cleaned) { db[id].status = 'paid'; save(db); }
        console.log(`[${id}] watchdog: '${o.status}' senza tuneId → rimesso in coda`);
      }
      continue;
    }

    // 1) pagato CON foto caricate ma avvio fallito: riprova. Gli ordini 'paid'
    //    SENZA foto sono in attesa del caricamento del cliente: non si toccano.
    if (o.status === 'paid' && (o.photoCount || 0) > 0 && (o.startAttempts || 0) < MAX_START_ATTEMPTS) {
      const ageMin = (now - new Date(o.paidAt || o.createdAt).getTime()) / 60000;
      if (ageMin >= 3) {
        console.log(`[${id}] watchdog: riprovo avvio generazione`);
        await tryStartGeneration(id);
      }
      continue;
    }

    // 2) in lavorazione da troppo tempo: riconcilia con Astria
    if ((o.status === 'training' || o.status === 'generating') && o.tuneId) {
      const ageMin = (now - new Date(o.paidAt || o.createdAt).getTime()) / 60000;
      if (ageMin < 20) continue; // tempi normali di Astria, lascia lavorare
      try {
        const [tune, prompts] = [await getTune(o.tuneId), await listPrompts(o.tuneId)];
        const allImages = [];
        let done = 0;
        prompts.forEach((p) => {
          const imgs = (p.images || []).filter(isHttpUrl);
          if (imgs.length) done += 1;
          allImages.push(...imgs);
        });
        // mutazione sincrona: load → modifica → save, senza await in mezzo
        const db = load();
        const cur = db[id];
        if (!cur || cur.cleaned) continue;
        if (cur.status === 'training' && tune.trained_at) cur.status = 'generating';
        // sicurezza: se per qualche motivo il totale è 0, lo deduciamo dai prompt creati
        if (!cur.promptsTotal && prompts.length) cur.promptsTotal = prompts.length;
        allImages.forEach((u) => { if (!cur.images.includes(u)) cur.images.push(u); });
        if (done > cur.promptsDone) cur.promptsDone = done;
        let justCompleted = false;
        if (cur.promptsTotal > 0 && cur.promptsDone >= cur.promptsTotal && cur.images.length && !cur.notified) {
          cur.status = 'completed';
          cur.completedAt = new Date().toISOString();
          cur.notified = true;
          justCompleted = true;
        }
        save(db);
        if (justCompleted) {
          console.log(`[${id}] watchdog: ordine recuperato e COMPLETATO (${cur.images.length} foto)`);
          await sendCompletionEmail(id); // con retry: emailSent solo se riesce
        }
      } catch (e) {
        console.error(`[${id}] watchdog riconciliazione:`, e.response?.status || e.message);
      }
      // 3) fermo da MOLTO troppo (>3h): allarme admin una sola volta
      if (ageMin > 180 && !o.stuckAlerted) {
        const db = load();
        if (db[id]) { db[id].stuckAlerted = true; save(db); }
        await alertAdmin(`Ordine fermo da ${Math.round(ageMin / 60)}h: ${id}`,
          `Ordine ${id} (${o.email}, ${o.package}) in stato '${o.status}' da ${Math.round(ageMin)} minuti.\nTune: ${o.tuneId}. Controlla su astria.ai.`);
      }
    }
  }
}
setInterval(() => watchdog().catch((e) => console.error('watchdog:', e.message)), WATCHDOG_MIN * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`photodin backend su http://localhost:${PORT}`);
  console.log(`  Stripe: ${pay.stripeEnabled() ? 'on' : 'off'} · TestMode: ${TEST_MODE ? 'on (branch=fast)' : 'off'} · Watchdog: ogni ${WATCHDOG_MIN} min · Generazione: stili interni`);
  if (!PUBLIC_URL) console.warn('⚠  PUBLIC_BASE_URL non impostato: callback e pagamenti non funzioneranno.');
  if (!ADMIN_EMAIL) console.warn('⚠  ADMIN_EMAIL non impostato: nessun allarme per ordini bloccati.');
  if (ALLOW_DEV_PAY && !TEST_MODE) console.warn('⚠  ALLOW_DEV_PAY attivo FUORI dal test mode: chiunque può generare gratis!');
  if (IS_PROD && process.env.ALLOW_DEV_PAY === '1') console.warn('ℹ  ALLOW_DEV_PAY ignorato: in produzione l\'avvio senza pagamento è sempre disattivo.');
});
