// astria.js — wrapper minimale per l'API di Astria (https://docs.astria.ai)
const axios = require('axios');
const FormData = require('form-data');

const API = process.env.ASTRIA_API_URL || 'https://api.astria.ai';
const KEY = process.env.ASTRIA_API_KEY;
// Flux1.dev nella gallery Astria — qualità migliore per gli headshot.
const BASE_TUNE_ID = process.env.ASTRIA_BASE_TUNE_ID || '1504944';

// === Impostazioni REALISMO (riducono l'effetto "plastica" di Flux) ===
// cfg_scale: più basso = pelle più naturale. Flux di default ~3.5; 3.0 è un buon
// compromesso tra somiglianza e naturalezza. Regolabile da env.
const CFG_SCALE = process.env.ASTRIA_CFG || '3';
// Aggiunge grana fotografica → look meno digitale, più da macchina vera.
const FILM_GRAIN = (process.env.ASTRIA_FILM_GRAIN || '1') === '1';
// Color grading su pellicola Portra (incarnati naturali, ottima per ritratti).
const COLOR_GRADING = process.env.ASTRIA_COLOR_GRADING || 'Film Portra';
// NOTA: Flux NON supporta i negative prompt (docs Astria: "Flux doesn't work
// with negatives"). Il realismo va espresso in POSITIVO nei prompt (styles.js).
// ASTRIA_NEG resta usato solo per l'anteprima FaceID su base SD1.5.
const NEG_PROMPT = process.env.ASTRIA_NEG ||
  'plastic skin, waxy skin, airbrushed, oversmoothed, blurry skin, cgi, 3d render, doll-like, artificial';
// Step di diffusione (opzionale: 28-36 consigliati). Vuoto = default Astria.
const STEPS = process.env.ASTRIA_STEPS || '';
// face_swap: usa le foto di training per aumentare la somiglianza del volto.
// Leva extra di fedeltà (opt-in da env: ASTRIA_FACE_SWAP=1).
const FACE_SWAP = process.env.ASTRIA_FACE_SWAP === '1';

function authHeaders() {
  if (!KEY) throw new Error('ASTRIA_API_KEY mancante nel file .env');
  return { Authorization: `Bearer ${KEY}` };
}

/**
 * Crea un "tune" (modello allenato sul volto) e accoda i prompt.
 * I prompt partono in automatico appena il training finisce.
 * @param {Object} opts
 * @param {string} opts.title       ID ordine (per idempotenza)
 * @param {string} opts.name        classe: 'man' | 'woman' | 'person'
 * @param {Array}  opts.images      file multer ({buffer, originalname})
 * @param {string} [opts.callbackTune]  webhook chiamato a training finito
 * @param {Array}  [opts.prompts]   [{text, num_images, callback}]
 * @param {string} [opts.branch]    'fast' per il mock testing gratuito
 */
async function createTune({ title, name, images, callbackTune, prompts = [], branch, superRes = true, faceCorrect = true }) {
  const form = new FormData();
  form.append('tune[title]', title);
  form.append('tune[name]', name);
  form.append('tune[token]', 'ohwx'); // parola chiave usata nei prompt (coerente con styles.js)
  if (branch === 'fast') {
    // Modalità mock: solo branch=fast, niente base_tune_id/model_type (andrebbero in conflitto)
    form.append('tune[branch]', 'fast');
  } else {
    form.append('tune[base_tune_id]', BASE_TUNE_ID);
    form.append('tune[model_type]', 'lora');
    // Preset di addestramento: 'flux-lora-portrait' (consigliato per headshot,
    // 27 step/foto invece di 100 → costo ~$1,50 invece di ~$5, qualità migliore).
    form.append('tune[preset]', process.env.ASTRIA_PRESET || 'flux-lora-portrait');
    if (branch) form.append('tune[branch]', branch);
  }
  if (callbackTune) form.append('tune[callback]', callbackTune);

  console.log(`[astria] immagini inviate al tune: ${images.length}`);
  images.forEach((f) => {
    form.append('tune[images][]', f.buffer, f.originalname || 'photo.jpg');
  });

  prompts.forEach((p, i) => {
    const k = (field) => `tune[prompts_attributes][${i}][${field}]`;
    form.append(k('text'), p.text);
    form.append(k('num_images'), String(p.num_images || 4));
    form.append(k('super_resolution'), superRes ? 'true' : 'false');
    // inpaint_faces richiede super_resolution attiva: lo mando solo se superRes è on.
    if (superRes && faceCorrect) {
      form.append(k('inpaint_faces'), 'true');
      // hires_fix aggiunge dettaglio di pelle nell'upscale (contrasta l'effetto liscio).
      form.append(k('hires_fix'), 'true');
    }
    // --- Leve di realismo ---
    if (CFG_SCALE) form.append(k('cfg_scale'), CFG_SCALE);
    if (FILM_GRAIN) form.append(k('film_grain'), 'true');
    if (COLOR_GRADING) form.append(k('color_grading'), COLOR_GRADING);
    // niente negative_prompt: ignorato da Flux (vedi nota in alto)
    if (FACE_SWAP) form.append(k('face_swap'), 'true');
    if (STEPS) form.append(k('steps'), STEPS);
    // Ritratto verticale 4:5 (raccomandato da Astria, evita artefatti tipo doppia testa)
    form.append(k('w'), '896');
    form.append(k('h'), '1152');
    if (p.callback) form.append(k('callback'), p.callback);
  });

  const { data } = await axios.post(`${API}/tunes`, form, {
    headers: { ...authHeaders(), ...form.getHeaders() },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return data;
}

/**
 * Genera nuove immagini su un tune esistente (es. rigenerazione gratuita).
 * Flusso documentato per Flux LoRA: il prompt va POSTato sul MODELLO BASE
 * con il LoRA caricato via sintassi <lora:id:1> (docs.astria.ai/docs/api/flux-api).
 * Usa gli stessi parametri di realismo della generazione principale, così le
 * foto rigenerate hanno qualità identica alle originali.
 */
async function createPrompt(tuneId, { text, num_images = 4, callback }) {
  const form = new FormData();
  form.append('prompt[text]', `<lora:${tuneId}:1> ${text}`);
  form.append('prompt[num_images]', String(num_images));
  form.append('prompt[super_resolution]', 'true');
  form.append('prompt[inpaint_faces]', 'true');
  form.append('prompt[hires_fix]', 'true');
  if (CFG_SCALE) form.append('prompt[cfg_scale]', CFG_SCALE);
  if (FILM_GRAIN) form.append('prompt[film_grain]', 'true');
  if (COLOR_GRADING) form.append('prompt[color_grading]', COLOR_GRADING);
  if (FACE_SWAP) form.append('prompt[face_swap]', 'true');
  if (STEPS) form.append('prompt[steps]', STEPS);
  form.append('prompt[w]', '896');
  form.append('prompt[h]', '1152');
  if (callback) form.append('prompt[callback]', callback);

  const { data } = await axios.post(`${API}/tunes/${BASE_TUNE_ID}/prompts`, form, {
    headers: { ...authHeaders(), ...form.getHeaders() },
  });
  return data;
}

/** Recupera lo stato di un tune. */
async function getTune(tuneId) {
  const { data } = await axios.get(`${API}/tunes/${tuneId}`, { headers: authHeaders() });
  return data;
}

/** Lista i prompt di un tune (usato dal watchdog per recuperare ordini
 *  i cui callback sono andati persi: riavvii, deploy, timeout). */
async function listPrompts(tuneId) {
  const { data } = await axios.get(`${API}/tunes/${tuneId}/prompts`, { headers: authHeaders() });
  return data;
}

/** Cancella un tune su Astria (modello + immagini di training + immagini generate). */
async function deleteTune(tuneId) {
  await axios.delete(`${API}/tunes/${tuneId}`, { headers: authHeaders() });
}

// === FaceID: genera una foto SENZA addestramento (per l'anteprima gratuita) ===
// Modello base SD economico per le anteprime (Realistic Vision v5.1).
const FACEID_BASE_TUNE_ID = process.env.ASTRIA_FACEID_BASE_ID || '690204';

/** Crea un "tune" FaceID: pronto all'istante, nessun addestramento. */
async function createFaceIdTune({ title, name, images }) {
  const form = new FormData();
  form.append('tune[title]', title);
  form.append('tune[name]', name);
  form.append('tune[model_type]', 'faceid');
  form.append('tune[base_tune_id]', FACEID_BASE_TUNE_ID);
  images.forEach((f) => form.append('tune[images][]', f.buffer, f.originalname || 'photo.jpg'));
  const { data } = await axios.post(`${API}/tunes`, form, {
    headers: { ...authHeaders(), ...form.getHeaders() },
    maxBodyLength: Infinity, maxContentLength: Infinity,
  });
  return Array.isArray(data) ? data[0] : data; // la risposta FaceID è un array
}

/** Genera 1 immagine con l'adapter FaceID, sul modello base. */
async function createFaceIdPrompt(faceTuneId, { text, callback }) {
  const form = new FormData();
  form.append('prompt[text]', `<faceid:${faceTuneId}:1> ${text}`);
  // Raccomandati dai docs FaceID per realismo e somiglianza:
  form.append('prompt[face_correct]', 'true');
  form.append('prompt[face_swap]', 'true');
  form.append('prompt[super_resolution]', 'true');
  form.append('prompt[w]', '512');
  form.append('prompt[h]', '640');
  // Sul base SD1.5 il negative prompt FUNZIONA (a differenza di Flux):
  if (NEG_PROMPT) form.append('prompt[negative_prompt]', NEG_PROMPT);
  form.append('prompt[num_images]', '1');
  if (callback) form.append('prompt[callback]', callback);
  const { data } = await axios.post(`${API}/tunes/${FACEID_BASE_TUNE_ID}/prompts`, form, {
    headers: { ...authHeaders(), ...form.getHeaders() },
  });
  return data;
}

module.exports = {
  createTune, createPrompt, getTune, listPrompts, deleteTune,
  createFaceIdTune, createFaceIdPrompt,
  BASE_TUNE_ID, FACEID_BASE_TUNE_ID,
};
