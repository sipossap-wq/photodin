// server.js — backend photodin (Astria + Stripe)
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const sizeOf = require('image-size');
const fs = require('fs');
const path = require('path');
const { createTune, createPrompt, getTune, listPrompts, deleteTune, createFaceIdTune, createFaceIdPrompt } = require('./astria');
const { buildPrompts, STYLE_CATALOG } = require('./styles');
const pay = require('./payments');
const email = require('./email');

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
// completare ordini con immagini false. Imposta CALLBACK_SECRET in .env.
const CB_SECRET = process.env.CALLBACK_SECRET || '';
const cbSuffix = CB_SECRET ? `&secret=${encodeURIComponent(CB_SECRET)}` : '';
const cbOk = (req) => !CB_SECRET || req.query.secret === CB_SECRET;
// Email a cui mandare gli allarmi (ordini pagati con generazione fallita).
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
function alertAdmin(subject, text) {
  if (!ADMIN_EMAIL) return Promise.resolve();
  return email.sendEmail({ to: ADMIN_EMAIL, subject: `[photodin] ${subject}`, html: `<pre>${text}</pre>` })
    .catch((e) => console.error('alertAdmin:', e.message));
}

// Controllo qualità input: foto piccole/sgranate → somiglianza scarsa e
// risultati "AI". Richiediamo almeno 512px sul lato corto (i selfie moderni
// sono ≥1080px, quindi blocca solo screenshot/thumbnail/foto compresse da chat).
const MIN_SIDE = parseInt(process.env.MIN_PHOTO_SIDE || '512', 10);
function checkPhotoQuality(files) {
  const bad = [];
  files.forEach((f, i) => {
    try {
      const d = sizeOf(f.buffer);
      if (Math.min(d.width, d.height) < MIN_SIDE) bad.push(i + 1);
    } catch (e) { bad.push(i + 1); } // formato non riconosciuto
  });
  return bad;
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
    const orderId = event.data.object.metadata?.orderId;
    // Rispondi SUBITO a Stripe (l'upload delle foto ad Astria può superare il
    // timeout del webhook e causare retry); la generazione parte in background.
    markPaidAndStart(orderId, 'stripe')
      .catch((e) => console.error('Avvio generazione fallito:', e.response?.data || e.message));
  }
  res.json({ received: true });
});

app.use(express.json());
app.use('/', express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 30 },
});

// ============================================================
// 1. Crea ordine (stato: pending_payment). Salva le foto, NON
//    chiama ancora Astria: la generazione parte dopo il pagamento.
// ============================================================
app.post('/api/orders', upload.array('photos', 30), (req, res) => {
  try {
    const customerEmail = (req.body.email || '').trim();
    const pkg = (req.body.package || 'standard').toLowerCase();
    const subjectClass = (req.body.subjectClass || 'person').toLowerCase();
    const consent = req.body.consent === 'true' || req.body.consent === 'on' || req.body.consent === true;
    let styles = req.body.styles || [];
    if (typeof styles === 'string') styles = [styles];

    if (!customerEmail) return res.status(400).json({ error: 'Email mancante.' });
    if (!consent) return res.status(400).json({ error: 'Devi accettare il consenso e i termini per continuare.' });
    // Astria raccomanda ~16 immagini varie (sfondi/luci/giorni diversi).
    // Sotto le 6 la somiglianza degrada visibilmente.
    if (!req.files || req.files.length < 6)
      return res.status(400).json({ error: 'Carica almeno 6 foto (consigliate 8-16, varie per sfondo e luce).' });
    if (!TEST_MODE) {
      const bad = checkPhotoQuality(req.files);
      if (bad.length)
        return res.status(400).json({ error: `Le foto n° ${bad.join(', ')} sono troppo piccole o non valide: usa foto originali di almeno ${MIN_SIDE}px (no screenshot o foto compresse da chat).` });
    }

    const id = newId();
    const dir = path.join(UPLOADS, id);
    fs.mkdirSync(dir, { recursive: true });
    // Nome file solo per indice (evita path traversal)
    req.files.forEach((f, i) => fs.writeFileSync(path.join(dir, `${i}.jpg`), f.buffer));
    console.log(`[${id}] foto ricevute dal browser: ${req.files.length}`);

    const db = load();
    db[id] = {
      id, email: customerEmail, package: pkg, subjectClass, styles,
      status: 'pending_payment',
      priceCents: pay.priceCents(pkg),
      createdAt: new Date().toISOString(),
      consent: true, consentAt: new Date().toISOString(),
      photoCount: req.files.length,
      tuneId: null, eta: null,
      images: [], promptsTotal: 0, promptsDone: 0,
    };
    save(db);

    res.json({
      orderId: id,
      status: 'pending_payment',
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
// 1bis. ANTEPRIMA GRATUITA — 1 foto via FaceID (niente addestramento, ~€0,10)
//        Limite: 1 per email.
// ============================================================
app.post('/api/preview', upload.array('photos', 30), async (req, res) => {
  try {
    const customerEmail = (req.body.email || '').trim();
    const subjectClass = (req.body.subjectClass || 'person').toLowerCase();
    if (!customerEmail) return res.status(400).json({ error: 'Email mancante.' });
    if (!req.files || req.files.length < 3) return res.status(400).json({ error: 'Carica almeno 3 foto.' });
    if (!TEST_MODE) {
      const bad = checkPhotoQuality(req.files);
      if (bad.length)
        return res.status(400).json({ error: `Le foto n° ${bad.join(', ')} sono troppo piccole o non valide: usa foto originali di almeno ${MIN_SIDE}px.` });
    }

    const db = load();
    const already = Object.values(db).find((o) => o.kind === 'preview' && o.email === customerEmail);
    if (already) return res.status(429).json({ error: 'Hai già usato l\'anteprima gratuita con questa email.' });

    const id = 'pv_' + newId();
    db[id] = {
      id, kind: 'preview', email: customerEmail, subjectClass,
      status: 'generating', createdAt: new Date().toISOString(),
      image: null, faceTuneId: null,
    };
    save(db);

    if (TEST_MODE) {
      // Modalità test: niente chiamata reale, mostra un'immagine fittizia dopo qualche secondo
      setTimeout(() => {
        const d = load();
        if (d[id]) { d[id].status = 'completed'; d[id].image = 'https://placehold.co/512x640/2f7df6/ffffff/png?text=Anteprima+photodin'; save(d); }
      }, 3000);
      return res.json({ previewId: id, status: 'generating' });
    }

    const tune = await createFaceIdTune({ title: id, name: subjectClass, images: req.files });
    const db2 = load(); db2[id].faceTuneId = tune.id; save(db2);
    // Nota: con FaceID il token 'ohwx' non serve (l'identità arriva da <faceid:id>).
    const text = `${subjectClass}, professional corporate headshot photograph, head and shoulders, neutral grey studio background, soft studio lighting, looking at camera, natural skin texture, sharp focus on the eyes`;
    await createFaceIdPrompt(tune.id, { text, callback: `${PUBLIC_URL}/api/callbacks/preview?id=${id}${cbSuffix}` });
    res.json({ previewId: id, status: 'generating' });
  } catch (e) {
    console.error('preview ERRORE → status:', e.response?.status, '| body:', JSON.stringify(e.response?.data), '| msg:', e.message);
    res.status(500).json({ error: 'Errore nella generazione dell\'anteprima.' });
  }
});

app.post('/api/callbacks/preview', (req, res) => {
  if (!cbOk(req)) return res.sendStatus(403);
  const { id } = req.query;
  const db = load();
  const o = db[id];
  if (o) {
    const imgs = req.body.images || (req.body.prompt && req.body.prompt.images) || [];
    if (imgs.length) { o.image = imgs[0]; o.status = 'completed'; save(db); }
  }
  res.sendStatus(200);
});

app.get('/api/preview/:id', (req, res) => {
  const o = load()[req.params.id];
  if (!o) return res.status(404).json({ error: 'Anteprima non trovata.' });
  res.json({ id: o.id, status: o.status, image: o.image });
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
// 3. Callback Astria
// ============================================================
app.post('/api/callbacks/tune', (req, res) => {
  if (!cbOk(req)) return res.sendStatus(403);
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
  if (!cbOk(req)) return res.sendStatus(403);
  const { order } = req.query;
  const db = load();
  const o = db[order];
  if (o) {
    const imgs = req.body.images || (req.body.prompt && req.body.prompt.images) || [];
    // dedup: il watchdog può aver già recuperato queste immagini via polling
    imgs.forEach((u) => { if (!o.images.includes(u)) o.images.push(u); });
    o.promptsDone += 1;
    if (o.promptsDone >= o.promptsTotal) {
      o.status = 'completed';
      o.completedAt = new Date().toISOString();
      console.log(`[${order}] COMPLETATO — ${o.images.length} foto. Invio email a ${o.email}`);
      const link = `${PUBLIC_URL}/grazie.html?order=${o.id}`;
      email.sendPhotosReadyEmail(o, link).catch((e) =>
        console.error('email errore:', e.response?.data || e.message));
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

// 5. Rigenerazione gratuita (garanzia) — con limiti anti-abuso:
//    max REGEN_LIMIT per ordine e mai dopo il cleanup (il tune non esiste più).
const REGEN_LIMIT = parseInt(process.env.REGEN_LIMIT || '2', 10);
app.post('/api/orders/:id/regenerate', async (req, res) => {
  try {
    const o = load()[req.params.id];
    if (!o || !o.tuneId) return res.status(404).json({ error: 'Ordine non trovato.' });
    if (o.cleaned) return res.status(410).json({ error: 'Ordine scaduto: i dati sono stati cancellati (GDPR).' });
    if ((o.regens || 0) >= REGEN_LIMIT)
      return res.status(429).json({ error: 'Hai già usato tutte le rigenerazioni incluse. Scrivici se c\'è un problema con le foto.' });
    // Stesso prompt "corporate" del catalogo, così la rigenerazione ha la
    // stessa qualità/coerenza delle foto originali.
    const corporate = STYLE_CATALOG.find((s) => s.id === 'corporate');
    const text = req.body.text || `ohwx ${o.subjectClass}, ${corporate.text}`;
    const p = await createPrompt(o.tuneId, {
      text, num_images: 5,
      callback: `${PUBLIC_URL}/api/callbacks/prompt?order=${o.id}${cbSuffix}`,
    });
    const db = load();
    db[o.id].promptsTotal += 1;
    db[o.id].regens = (db[o.id].regens || 0) + 1;
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

// Catalogo stili (per la pagina d'ordine)
app.get('/api/styles', (req, res) => {
  res.json(STYLE_CATALOG.map(({ id, label, desc }) => ({ id, label, desc })));
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
  await tryStartGeneration(orderId);
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

async function cleanup() {
  const db = load();
  let changed = false;
  const now = Date.now();
  for (const id of Object.keys(db)) {
    const o = db[id];
    if (o.cleaned) continue;
    const ref = o.completedAt || o.createdAt;
    const ageH = (now - new Date(ref).getTime()) / 3600000;
    // cancella se: completato da oltre RETENTION_HOURS, oppure ordine fermo da molto tempo
    const expired = (o.completedAt && ageH >= RETENTION_HOURS) || ageH >= RETENTION_HOURS + 96;
    if (!expired) continue;

    try { fs.rmSync(path.join(UPLOADS, id), { recursive: true, force: true }); } catch (e) {}
    const astriaId = o.tuneId || o.faceTuneId;
    if (astriaId) {
      try { await deleteTune(astriaId); }
      catch (e) { console.error(`[${id}] deleteTune:`, e.response?.status || e.message); }
    }
    o.cleaned = true;
    o.cleanedAt = new Date().toISOString();
    o.images = [];
    o.status = 'expired';
    changed = true;
    console.log(`[${id}] dati cancellati (GDPR)`);
  }
  if (changed) save(db);
}
setInterval(() => cleanup().catch((e) => console.error('cleanup:', e.message)), 60 * 60 * 1000);

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
    if (o.cleaned || o.kind === 'preview') continue;

    // 1) pagato ma mai partito (o avvio fallito): riprova
    if (o.status === 'paid' && (o.startAttempts || 0) < MAX_START_ATTEMPTS) {
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
          const imgs = p.images || [];
          if (imgs.length) done += 1;
          allImages.push(...imgs);
        });
        // mutazione sincrona: load → modifica → save, senza await in mezzo
        const db = load();
        const cur = db[id];
        if (!cur || cur.cleaned) continue;
        if (cur.status === 'training' && tune.trained_at) cur.status = 'generating';
        allImages.forEach((u) => { if (!cur.images.includes(u)) cur.images.push(u); });
        if (done > cur.promptsDone) cur.promptsDone = done;
        let justCompleted = false;
        if (cur.promptsDone >= cur.promptsTotal && cur.images.length && cur.status !== 'completed') {
          cur.status = 'completed';
          cur.completedAt = new Date().toISOString();
          justCompleted = true;
        }
        save(db);
        if (justCompleted) {
          console.log(`[${id}] watchdog: ordine recuperato e COMPLETATO (${cur.images.length} foto)`);
          const link = `${PUBLIC_URL}/grazie.html?order=${id}`;
          email.sendPhotosReadyEmail(cur, link).catch((e) =>
            console.error('email errore:', e.response?.data || e.message));
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
  console.log(`  Stripe: ${pay.stripeEnabled() ? 'on' : 'off'} · TestMode: ${TEST_MODE ? 'on (branch=fast)' : 'off'} · Watchdog: ogni ${WATCHDOG_MIN} min`);
  if (!PUBLIC_URL) console.warn('⚠  PUBLIC_BASE_URL non impostato: callback e pagamenti non funzioneranno.');
  if (!CB_SECRET) console.warn('⚠  CALLBACK_SECRET non impostato: i callback Astria non sono protetti.');
  if (!ADMIN_EMAIL) console.warn('⚠  ADMIN_EMAIL non impostato: nessun allarme per ordini bloccati.');
  if (ALLOW_DEV_PAY && !TEST_MODE) console.warn('⚠  ALLOW_DEV_PAY attivo FUORI dal test mode: chiunque può generare gratis!');
});
