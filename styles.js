// styles.js — catalogo stili selezionabili dal cliente.
// 'ohwx' è il token che Astria associa al volto allenato.

const STYLE_CATALOG = [
  { id: 'corporate',  label: 'Corporate',       desc: 'Abito scuro, fondale grigio, luce da studio',
    text: 'professional corporate headshot, dark business suit, soft studio lighting, neutral grey background, sharp focus, looking at camera' },
  { id: 'office',     label: 'Ufficio luminoso', desc: 'Camicia azzurra, ufficio sfocato',
    text: 'professional headshot, light blue shirt, bright blurred office background, natural window light, friendly confident expression' },
  { id: 'realestate', label: 'Immobiliare',      desc: 'Blazer, interno moderno e luminoso',
    text: 'real estate agent portrait, smart blazer, modern bright interior background, warm welcoming lighting' },
  { id: 'outdoor',    label: 'Esterno',          desc: 'Smart casual, luce naturale',
    text: 'outdoor professional portrait, smart casual shirt, soft natural daylight, blurred city background' },
  { id: 'studio',     label: 'Studio classico',  desc: 'Dolcevita nero, fondo scuro',
    text: 'classic studio headshot, black turtleneck, dark seamless background, dramatic Rembrandt lighting' },
  { id: 'linkedin',   label: 'LinkedIn',         desc: 'Abito blu, fondo bianco, sorriso',
    text: 'LinkedIn profile photo, navy suit no tie, clean white background, even soft light, approachable smile' },
  { id: 'casual',     label: 'Business casual',  desc: 'Maglione, ambiente caldo',
    text: 'business casual headshot, knit sweater, cozy bright background, natural light, relaxed professional look' },
  { id: 'executive',  label: 'Executive',        desc: 'Abito antracite, ufficio elegante',
    text: 'executive portrait, tailored charcoal suit, luxury office background, cinematic lighting' },
  { id: 'creative',   label: 'Creative',         desc: 'Camicia di jeans, luce calda',
    text: 'creative professional headshot, denim shirt, warm studio background, golden hour light' },
  { id: 'minimal',    label: 'Minimal',          desc: 'Camicia bianca, studio chiaro',
    text: 'professional portrait, white shirt with rolled sleeves, minimalist studio, high-key lighting' },
];

// Quante foto totali genera ogni pacchetto
const PACKAGE_PHOTOS = { standard: 30, pro: 100, studio: 120 };

/**
 * Costruisce i prompt a partire dagli stili scelti dal cliente.
 * Le foto del pacchetto vengono distribuite sugli stili selezionati.
 */
function buildPrompts(selectedIds, pkg = 'standard', cls = 'person') {
  let styles = (selectedIds || [])
    .map((id) => STYLE_CATALOG.find((s) => s.id === id))
    .filter(Boolean);
  // se non sceglie nulla, usa una selezione predefinita
  if (styles.length === 0) styles = STYLE_CATALOG.slice(0, pkg === 'standard' ? 4 : 6);

  const total = PACKAGE_PHOTOS[pkg] || PACKAGE_PHOTOS.standard;
  const per = Math.max(1, Math.round(total / styles.length));

  return styles.map((s) => ({ text: `ohwx ${cls}, ${s.text}`, num_images: per }));
}

module.exports = { STYLE_CATALOG, PACKAGE_PHOTOS, buildPrompts };
