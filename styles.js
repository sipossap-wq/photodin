// styles.js — set di prompt per i pacchetti photodin.
// 'ohwx' è il token che Astria associa al volto allenato (vedi docs AI Photoshoot).
// Base = 8 stili x 5 foto = 40 foto. Pro = 12 stili x 5 = 60 foto.

function prompt(text, num_images = 5) {
  return { text, num_images };
}

function getStyles(pkg = 'base', cls = 'person') {
  const s = `ohwx ${cls}`;

  const base = [
    prompt(`${s}, professional corporate headshot, dark business suit, soft studio lighting, neutral grey background, sharp focus, looking at camera`),
    prompt(`${s}, professional headshot, light blue shirt, bright blurred office background, natural window light, friendly confident expression`),
    prompt(`${s}, real estate agent portrait, smart blazer, modern bright interior background, warm welcoming lighting`),
    prompt(`${s}, outdoor professional portrait, smart casual shirt, soft natural daylight, blurred city background`),
    prompt(`${s}, classic studio headshot, black turtleneck, dark seamless background, dramatic Rembrandt lighting`),
    prompt(`${s}, LinkedIn profile photo, navy suit no tie, clean white background, even soft light, approachable smile`),
    prompt(`${s}, professional portrait, grey blazer over white shirt, neutral beige background, studio softbox lighting`),
    prompt(`${s}, business casual headshot, knit sweater, cozy bright background, natural light, relaxed professional look`),
  ];

  const proExtra = [
    prompt(`${s}, executive portrait, tailored charcoal suit, luxury office background, cinematic lighting`),
    prompt(`${s}, creative professional headshot, denim shirt, warm studio background, golden hour light`),
    prompt(`${s}, professional portrait, white shirt with rolled sleeves, minimalist studio, high-key lighting`),
    prompt(`${s}, confident professional, dark blazer, blurred bookshelf background, soft warm light`),
  ];

  return pkg === 'pro' ? [...base, ...proExtra] : base;
}

module.exports = { getStyles };
