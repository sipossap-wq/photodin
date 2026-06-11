// astria.js — wrapper minimale per l'API di Astria (https://docs.astria.ai)
const axios = require('axios');
const FormData = require('form-data');

const API = process.env.ASTRIA_API_URL || 'https://api.astria.ai';
const KEY = process.env.ASTRIA_API_KEY;
// Flux1.dev nella gallery Astria — qualità migliore per gli headshot.
const BASE_TUNE_ID = process.env.ASTRIA_BASE_TUNE_ID || '1504944';

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
async function createTune({ title, name, images, callbackTune, prompts = [], branch }) {
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
    if (branch) form.append('tune[branch]', branch);
  }
  if (callbackTune) form.append('tune[callback]', callbackTune);

  images.forEach((f) => {
    form.append('tune[images][]', f.buffer, f.originalname || 'photo.jpg');
  });

  prompts.forEach((p, i) => {
    form.append(`tune[prompts_attributes][${i}][text]`, p.text);
    form.append(`tune[prompts_attributes][${i}][num_images]`, String(p.num_images || 4));
    form.append(`tune[prompts_attributes][${i}][inpaint_faces]`, 'true');
    form.append(`tune[prompts_attributes][${i}][super_resolution]`, 'true');
    if (p.callback) form.append(`tune[prompts_attributes][${i}][callback]`, p.callback);
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
 */
async function createPrompt(tuneId, { text, num_images = 4, callback }) {
  const form = new FormData();
  form.append('prompt[text]', text);
  form.append('prompt[num_images]', String(num_images));
  form.append('prompt[inpaint_faces]', 'true');
  form.append('prompt[super_resolution]', 'true');
  if (callback) form.append('prompt[callback]', callback);

  const { data } = await axios.post(`${API}/tunes/${tuneId}/prompts`, form, {
    headers: { ...authHeaders(), ...form.getHeaders() },
  });
  return data;
}

/** Recupera lo stato di un tune. */
async function getTune(tuneId) {
  const { data } = await axios.get(`${API}/tunes/${tuneId}`, { headers: authHeaders() });
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
  form.append('prompt[face_correct]', 'true');
  form.append('prompt[num_images]', '1');
  if (callback) form.append('prompt[callback]', callback);
  const { data } = await axios.post(`${API}/tunes/${FACEID_BASE_TUNE_ID}/prompts`, form, {
    headers: { ...authHeaders(), ...form.getHeaders() },
  });
  return data;
}

module.exports = {
  createTune, createPrompt, getTune, deleteTune,
  createFaceIdTune, createFaceIdPrompt,
  BASE_TUNE_ID, FACEID_BASE_TUNE_ID,
};
