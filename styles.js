// styles.js — catalogo stili selezionabili dal cliente.
// 'ohwx' è il token che Astria associa al volto allenato.

// Prompt ingegnerizzati per Flux (struttura: tipo+taglio · abito semplice · sfondo ·
// formula di luce precisa · una sola espressione · corpo macchina+obiettivo+apertura ·
// catchlights+pelle realistica+fuoco occhi · ancora di qualità). Nessuna età/aspetto: ci pensa il modello.
const STYLE_CATALOG = [
  { id: 'corporate',  label: 'Corporate',       desc: 'Abito scuro, fondale grigio, luce da studio',
    text: 'professional corporate headshot, head and shoulders, charcoal suit with a light shirt, clean medium-grey seamless backdrop lit separately, butterfly lighting from a large softbox above with soft fill from below, confident composed expression, catchlights in the eyes, realistic detailed skin texture with natural pores, sharp focus on the eyes, shot on Canon EOS R5, 85mm f/1.8, shallow depth of field, corporate directory quality, photorealistic' },
  { id: 'office',     label: 'Ufficio luminoso', desc: 'Camicia azzurra, ufficio sfocato',
    text: 'professional headshot, head and shoulders, light blue dress shirt, modern bright office blurred to soft bokeh, large window key light from the left with gentle natural falloff, warm approachable smile, catchlights in the eyes, realistic detailed skin texture with natural pores, sharp focus on the eyes, shot on Canon EOS R5, 85mm f/1.8, shallow depth of field, editorial portrait, photorealistic' },
  { id: 'realestate', label: 'Immobiliare',      desc: 'Blazer, interno moderno e luminoso',
    text: 'real estate agent headshot, head and shoulders, navy blazer, bright upscale interior blurred to bokeh, soft warm key light with a subtle rim light on the hair, warm trustworthy smile, catchlights in the eyes, realistic detailed skin texture with natural pores, sharp focus on the eyes, shot on Canon EOS R5, 105mm f/2, shallow depth of field, personable and professional, photorealistic' },
  { id: 'outdoor',    label: 'Esterno',          desc: 'Smart casual, luce naturale',
    text: 'outdoor professional portrait, head and shoulders, smart casual shirt, blurred upscale city street at golden hour, soft natural backlight with a golden rim light on the hair, relaxed confident expression, catchlights in the eyes, realistic detailed skin texture with natural pores, sharp focus on the eyes, shot on Canon EOS R5, 85mm f/1.8, shallow depth of field, photorealistic' },
  { id: 'studio',     label: 'Studio classico',  desc: 'Dolcevita nero, fondo scuro',
    text: 'classic studio headshot, head and shoulders, black turtleneck, dark seamless background, Rembrandt lighting from a beauty dish at 45 degrees with minimal fill, composed serious expression, strong catchlights in the eyes, realistic detailed skin texture with natural pores, sharp focus on the eyes, shot on Hasselblad medium format, 90mm, shallow depth of field, editorial portrait, photorealistic' },
  { id: 'linkedin',   label: 'LinkedIn',         desc: 'Abito blu, fondo bianco, sorriso',
    text: 'LinkedIn profile headshot, head and shoulders, face occupying 60% of the frame, smart navy blazer over a crew neck, clean light-grey background, soft even diffused light from directly in front and slightly above with minimal shadows, genuine warm smile, direct eye contact, catchlights in the eyes, realistic detailed skin texture with natural pores, sharp focus on the eyes, shot on Canon EOS R5, 85mm f/1.8, LinkedIn-ready, photorealistic' },
  { id: 'casual',     label: 'Business casual',  desc: 'Maglione, ambiente caldo',
    text: 'business casual headshot, head and shoulders, fine knit sweater, cozy bright neutral background softly blurred, soft natural window light, relaxed friendly expression, catchlights in the eyes, realistic detailed skin texture with natural pores, sharp focus on the eyes, shot on Canon EOS R5, 85mm f/1.8, shallow depth of field, photorealistic' },
  { id: 'executive',  label: 'Executive',        desc: 'Abito antracite, ufficio elegante',
    text: 'executive headshot, head and shoulders, dark tailored suit, elegant office blurred to bokeh, refined low-key lighting from a softbox at 45 degrees with subtle fill, authoritative composed expression, catchlights in the eyes, realistic detailed skin texture with natural pores, sharp focus on the eyes, shot on Hasselblad medium format, 90mm, shallow depth of field, C-suite presence, photorealistic' },
  { id: 'creative',   label: 'Creative',         desc: 'Camicia di jeans, luce calda',
    text: 'creative professional headshot, head and shoulders, denim shirt, warm minimal studio background, single soft strip light from the side with gentle fill, friendly relaxed expression, catchlights in the eyes, realistic detailed skin texture with natural pores, sharp focus on the eyes, shot on Canon EOS R5, 85mm f/1.8, shallow depth of field, modern editorial, photorealistic' },
  { id: 'minimal',    label: 'Minimal',          desc: 'Camicia bianca, studio chiaro',
    text: 'minimalist studio portrait, head and shoulders, crisp white shirt, clean white seamless background, soft high-key lighting from a large diffused source, calm confident expression, catchlights in the eyes, realistic detailed skin texture with natural pores, sharp focus on the eyes, shot on Canon EOS R5, 85mm f/1.8, shallow depth of field, photorealistic' },
  { id: 'fullbody',   label: 'Figura intera',    desc: 'Posa in piedi, ambiente professionale',
    text: 'full body professional portrait, standing confident relaxed pose, business attire, modern office or studio environment blurred to soft bokeh, soft even professional lighting, natural composed expression, realistic detailed skin texture, sharp focus, shot on Canon EOS R5, 50mm f/2.8, photorealistic' },
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
