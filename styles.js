// styles.js — catalogo stili selezionabili dal cliente.
// 'ohwx' è il token che Astria associa al volto allenato.

// Prompt ottimizzati per Flux secondo i docs Astria (docs.astria.ai):
// - Flux NON supporta negative prompt né pesi (): tutto in positivo, le parti
//   importanti all'INIZIO del prompt.
// - Densi ma CONCISI: descrizioni eccessive creano conflitti in inference.
// - Niente negazioni ("not airbrushed") né termini contraddittori
//   (es. luce da studio + "candid natural light" + "shot on film" insieme).
// Struttura: tipo+taglio · abito · sfondo · UNA formula di luce coerente ·
// una sola espressione · pelle reale · camera+obiettivo · grana leggera.
const SKIN = 'detailed natural skin texture with visible pores and fine lines, subtle skin imperfections, sharp focus on the eyes, catchlights in the eyes';
const STYLE_CATALOG = [
  { id: 'corporate',  label: 'Corporate',       desc: 'Abito scuro, fondale grigio, luce da studio',
    text: `professional corporate headshot photograph, head and shoulders, charcoal suit with a light shirt, medium-grey seamless studio backdrop, soft butterfly lighting from a large softbox above, confident composed expression, ${SKIN}, shot on a Canon EOS R5 with an 85mm f/1.8 lens, shallow depth of field, subtle film grain` },
  { id: 'office',     label: 'Ufficio luminoso', desc: 'Camicia azzurra, ufficio sfocato',
    text: `professional headshot photograph, head and shoulders, light blue dress shirt, modern bright office blurred to soft bokeh, large window light from the left with gentle falloff, warm approachable smile, ${SKIN}, shot on a Canon EOS R5 with an 85mm f/1.8 lens, shallow depth of field, subtle film grain` },
  { id: 'realestate', label: 'Immobiliare',      desc: 'Blazer, interno moderno e luminoso',
    text: `real estate agent headshot photograph, head and shoulders, navy blazer, bright upscale interior blurred to bokeh, soft warm key light with a subtle rim light on the hair, warm trustworthy smile, ${SKIN}, shot on a Canon EOS R5 with a 105mm f/2 lens, shallow depth of field, subtle film grain` },
  { id: 'outdoor',    label: 'Esterno',          desc: 'Smart casual, luce naturale',
    text: `outdoor portrait photograph, head and shoulders, smart casual shirt, blurred city street at golden hour, soft natural backlight with a golden rim light on the hair, relaxed confident expression, ${SKIN}, shot on a Canon EOS R5 with an 85mm f/1.8 lens, shallow depth of field, subtle film grain` },
  { id: 'studio',     label: 'Studio classico',  desc: 'Dolcevita nero, fondo scuro',
    text: `classic studio headshot photograph, head and shoulders, black turtleneck, dark seamless background, Rembrandt lighting from a beauty dish at 45 degrees with minimal fill, composed serious expression, ${SKIN}, shot on a Hasselblad medium format camera with a 90mm lens, shallow depth of field, subtle film grain` },
  { id: 'linkedin',   label: 'LinkedIn',         desc: 'Abito blu, fondo bianco, sorriso',
    text: `LinkedIn profile headshot photograph, head and shoulders with the face filling most of the frame, navy blazer over a crew neck, clean light-grey background, soft even diffused light from the front with minimal shadows, genuine warm smile with direct eye contact, ${SKIN}, shot on a Canon EOS R5 with an 85mm f/1.8 lens, subtle film grain` },
  { id: 'casual',     label: 'Business casual',  desc: 'Maglione, ambiente caldo',
    text: `business casual headshot photograph, head and shoulders, fine knit sweater, warm neutral background softly blurred, soft window light, relaxed friendly expression, ${SKIN}, shot on a Canon EOS R5 with an 85mm f/1.8 lens, shallow depth of field, subtle film grain` },
  { id: 'executive',  label: 'Executive',        desc: 'Abito antracite, ufficio elegante',
    text: `executive headshot photograph, head and shoulders, dark tailored suit, elegant office blurred to bokeh, refined low-key lighting from a softbox at 45 degrees with subtle fill, authoritative composed expression, ${SKIN}, shot on a Hasselblad medium format camera with a 90mm lens, shallow depth of field, subtle film grain` },
  { id: 'creative',   label: 'Creative',         desc: 'Camicia di jeans, luce calda',
    text: `creative professional headshot photograph, head and shoulders, denim shirt, warm minimal studio background, single soft strip light from the side with gentle fill, friendly relaxed expression, ${SKIN}, shot on a Canon EOS R5 with an 85mm f/1.8 lens, shallow depth of field, subtle film grain` },
  { id: 'minimal',    label: 'Minimal',          desc: 'Camicia bianca, studio chiaro',
    text: `minimalist studio portrait photograph, head and shoulders, crisp white shirt, clean white seamless background, soft high-key lighting from a large diffused source, calm confident expression, ${SKIN}, shot on a Canon EOS R5 with an 85mm f/1.8 lens, shallow depth of field, subtle film grain` },
  { id: 'fullbody',   label: 'Figura intera',    desc: 'Posa in piedi, ambiente professionale',
    text: `full body professional portrait photograph, standing in a confident relaxed pose, business attire, modern office blurred to soft bokeh, soft even lighting, natural composed expression, detailed natural skin texture, sharp focus, shot on a Canon EOS R5 with a 50mm f/2.8 lens, subtle film grain` },
];

// Quante foto totali genera ogni pacchetto
const PACKAGE_PHOTOS = { standard: 30, pro: 100, studio: 120 };

/**
 * Costruisce i prompt a partire dagli stili scelti dal cliente.
 * Le foto del pacchetto vengono distribuite sugli stili selezionati.
 */
// Max immagini per singolo prompt (per stare sotto eventuali limiti di Astria).
const MAX_PER_PROMPT = 8;

// Varianti di posa/inquadratura ruotate tra i batch dello stesso stile:
// senza, 8+ foto escono quasi identiche. Un set vario sembra un vero servizio
// fotografico (come HeadshotPro). Aggiunte in coda: non confliggono con luce
// ed espressione definite nello stile.
const POSE_VARIANTS = [
  'facing the camera directly',
  'body angled slightly to the left with the face toward the camera',
  'body angled slightly to the right with the face toward the camera',
  'three-quarter view with the face toward the camera',
  'head tilted very slightly, looking at the camera',
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
      prompts.push({ text: `ohwx ${cls}, ${s.text}, ${pose}`, num_images: n });
      remaining -= n;
      batch += 1;
    }
  });
  return prompts;
}

module.exports = { STYLE_CATALOG, PACKAGE_PHOTOS, buildPrompts };
