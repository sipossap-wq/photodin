// grazie.js — pagina di consegna photodin (polling stato + foto).
// Esterno per rispettare la CSP rigorosa (script-src 'self').
const params = new URLSearchParams(location.search);
const id = params.get('order');
const token = params.get('t');
const status = document.getElementById('status');
const imgs = document.getElementById('imgs');
// Render sicuro: <img> via DOM, solo URL http(s) assolute (anti XSS).
function renderImages(list){
  imgs.textContent='';
  (list||[]).forEach(u=>{
    try{var p=new URL(u);if(p.protocol!=='http:'&&p.protocol!=='https:')return;}catch(e){return;}
    var im=document.createElement('img');im.src=u;imgs.appendChild(im);
  });
}
if (!id) status.textContent = 'Ordine non specificato.';
else setInterval(async () => {
  const r = await fetch('/api/orders/' + id + '?t=' + encodeURIComponent(token || ''));
  const o = await r.json();
  if (o.error) { status.textContent = o.error; return; }
  const labels = { paid:'Pagato, preparazione…', training:'Addestramento del modello…', generating:'Generazione foto…', completed:'Completato!' };
  status.innerHTML = (o.status==='completed'?'✅ ':'<span class="dot"></span>') +
    (labels[o.status] || o.status) + '  ·  foto pronte: ' + o.images.length + ' (' + o.progress + ')';
  renderImages(o.images);
}, 8000);
