// styles.js — catalogo stili selezionabili dal cliente.
// 'ohwx' è il token che Astria associa al volto allenato.

// Prompt in STILE NARRATIVO, ricalcato sui prompt reali del team Astria per
// Flux estratti dalla loro gallery (es. il loro prompt LinkedIn: "A young,
// dynamic ohwx man stands tall against a backdrop of a cozy home office...
// He wears a well-fitted navy blue suit... The warm lighting creates a
// welcoming and approachable atmosphere."). Regole applicate:
// - frasi naturali complete (l'encoder T5 di Flux le capisce meglio delle liste)
// - token all'inizio, niente negative, niente pesi, niente "8k/masterpiece"
// - UNA formula di luce coerente per stile + atmosfera
// - niente pronomi (he/she): il testo vale per man/woman/person
// - coda tecnica breve per la pelle (anti effetto plastica)
const SKIN = 'Natural skin texture with a matte finish, visible pores and fine lines, sharp focus on the eyes, shot with an 85mm portrait lens at a wide aperture, shallow depth of field, subtle film grain.';

const STYLE_CATALOG = [
  { id: 'corporate',  label: 'Corporate',       desc: 'Abito scuro, fondale grigio, luce da studio',
    text: `photographed for a professional corporate headshot, framed head and shoulders, wearing a well-tailored charcoal suit with a light shirt against a clean medium-grey seamless studio backdrop. Soft butterfly lighting from a large softbox above creates even, flattering light, the expression confident and composed, with catchlights in the eyes. ${SKIN}` },
  { id: 'office',     label: 'Ufficio luminoso', desc: 'Camicia azzurra, ufficio sfocato',
    text: `photographed for a professional headshot in a modern bright office blurred to soft bokeh, wearing a light blue dress shirt. Large window light from the left falls gently across the face, the smile warm and approachable, with catchlights in the eyes. ${SKIN}` },
  { id: 'realestate', label: 'Immobiliare',      desc: 'Blazer, interno moderno e luminoso',
    text: `photographed for a real estate agent headshot in a bright upscale interior blurred to bokeh, wearing a navy blazer. A soft warm key light and a subtle rim light on the hair give a personable, trustworthy look, with a warm smile and catchlights in the eyes. ${SKIN}` },
  { id: 'outdoor',    label: 'Esterno',          desc: 'Smart casual, luce naturale',
    text: `photographed for an outdoor professional portrait on a blurred upscale city street at golden hour, wearing a smart casual shirt. Soft natural backlight leaves a golden rim light on the hair, the expression relaxed and confident. ${SKIN}` },
  { id: 'studio',     label: 'Studio classico',  desc: 'Dolcevita nero, fondo scuro',
    text: `photographed for a classic studio headshot against a dark seamless background, wearing a black turtleneck. Rembrandt lighting from a beauty dish at 45 degrees with minimal fill sculpts the face, the expression composed and serious, with strong catchlights in the eyes. ${SKIN}` },
  { id: 'linkedin',   label: 'LinkedIn',         desc: 'Abito blu, fondo chiaro, sorriso',
    text: `photographed for a LinkedIn profile headshot, framed head and shoulders with the face filling most of the frame, wearing a navy blazer over a crew neck against a clean light-grey background. Soft, even diffused light from the front leaves minimal shadows, and a genuine warm smile with direct eye contact creates a welcoming, approachable atmosphere. ${SKIN}` },
  { id: 'casual',     label: 'Business casual',  desc: 'Maglione, ambiente caldo',
    text: `photographed for a business casual headshot, wearing a fine knit sweater against a warm neutral background softly blurred. Soft window light and a relaxed, friendly expression create an easygoing professional atmosphere. ${SKIN}` },
  { id: 'executive',  label: 'Executive',        desc: 'Abito antracite, ufficio elegante',
    text: `photographed for an executive headshot in an elegant office blurred to bokeh, wearing a dark tailored suit. Refined low-key lighting from a softbox at 45 degrees with subtle fill conveys authority and composure, with catchlights in the eyes. ${SKIN}` },
  { id: 'creative',   label: 'Creative',         desc: 'Camicia di jeans, luce calda',
    text: `photographed for a creative professional headshot in a warm minimal studio, wearing a denim shirt. A single soft strip light from the side with gentle fill gives a modern editorial feel, the expression friendly and relaxed. ${SKIN}` },
  { id: 'minimal',    label: 'Minimal',          desc: 'Camicia bianca, studio chiaro',
    text: `photographed for a minimalist studio portrait against a clean white seamless background, wearing a crisp white shirt. Soft high-key lighting from a large diffused source, the expression calm and confident. ${SKIN}` },
  { id: 'fullbody',   label: 'Figura intera',    desc: 'Posa in piedi, ambiente professionale',
    text: `photographed for a full body professional portrait, standing in a confident relaxed pose in business attire, in a modern office blurred to soft bokeh. Soft, even lighting and a natural composed expression. Natural skin texture with a matte finish, sharp focus, subtle film grain.` },
];

// Quante foto totali genera ogni pacchetto
const PACKAGE_PHOTOS = { standard: 30, pro: 100, studio: 120 };

/**
 * Costruisce i prompt a partire dagli stili scelti dal cliente.
 * Le foto del pacchetto vengono distribuite sugli stili selezionati.
 */
// Max immagini per singolo prompt (per stare sotto eventuali limiti di Astria).
const MAX_PER_PROMPT = 8;

// Varianti di posa/inquadratura ruotate tra i batch e tra gli stili:
// senza, 8+ foto escono quasi identiche. Un set vario sembra un vero
// servizio fotografico. Frasi complete, coerenti con lo stile narrativo.
const POSE_VARIANTS = [
  'Facing the camera directly.',
  'Body angled slightly to the left, face turned toward the camera.',
  'Body angled slightly to the right, face turned toward the camera.',
  'Seen in a three-quarter view with the face toward the camera.',
  'Head tilted very slightly, eyes on the camera.',
];

function buildPrompts(selectedIds, pkg = 'standard', cls = 'person', totalOverride) {
  let styles = (selectedIds || [])
    .map((id) => STYLE_CATALOG.find((s) => s.id === id))
    .filter(Boolean);
  // Nessuna scelta stili: generiamo un set VARIO su tutti gli stili (figura intera solo Studio)
  if (styles.length === 0) {
    styles = STYLE_CATALOG.filter((s) => s.id !== 'fullbody');
    if (pkg === 'studio') styles = STYLE_CATALOG.slice(); // include figura intera
  }

  const total = totalOverride || PACKAGE_PHOTOS[pkg] || PACKAGE_PHOTOS.standard;
  const perStyle = Math.max(1, Math.round(total / styles.length));

  // Spezza ogni stile in più prompt da max 8 immagini, così anche scegliendo
  // un solo stile si ottiene il numero pieno di foto.
  const prompts = [];
  styles.forEach((s, si) => {
    let remaining = perStyle;
    let batch = 0;
    while (remaining > 0) {
      const n = Math.min(MAX_PER_PROMPT, remaining);
      // offset per stile: anche con un solo batch per stile le pose variano nel set
      const pose = POSE_VARIANTS[(si + batch) % POSE_VARIANTS.length];
      // Il token va all'INIZIO del prompt (raccomandazione Astria per Flux).
      prompts.push({ text: `ohwx ${cls}, ${s.text} ${pose}`, num_images: n });
      remaining -= n;
      batch += 1;
    }
  });
  return prompts;
}

module.exports = { STYLE_CATALOG, PACKAGE_PHOTOS, buildPrompts };
