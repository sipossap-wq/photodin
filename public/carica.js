// carica.js — caricamento foto DOPO il pagamento (flusso pay-first).
const params=new URLSearchParams(location.search);
const orderId=params.get('order');
const token=params.get('t');
const out=document.getElementById('out');
const send=document.getElementById('send');
const input=document.getElementById('photos');
function show(){out.style.display='block';}
function msg(t){show();out.textContent=t;}

if(!orderId||!token){ msg('Link non valido. Apri la pagina dal link ricevuto dopo il pagamento.'); send.disabled=true; }

// Caricamento cumulativo dei selfie + contatore.
var selectedFiles=[];
input.addEventListener('change',function(e){
  for(var i=0;i<e.target.files.length;i++){var file=e.target.files[i];
    if(!selectedFiles.some(function(x){return x.name===file.name&&x.size===file.size;})) selectedFiles.push(file);
  }
  updateCount();
});
function updateCount(){
  var n=selectedFiles.length, el=document.getElementById('photoCount');
  if(!n){el.textContent='';return;}
  el.textContent=(n<6?'⚠ ':'✓ ')+n+' foto selezionate'+(n<6?' — servono almeno 6 (consigliate 8-16)':'');
  el.style.color=n<6?'#c8412c':'#19a07f';
}

// Verifica lo stato all'apertura: se l'ordine è già in lavorazione → vai alla consegna.
(async function check(){
  if(!orderId||!token) return;
  try{
    const r=await fetch('/api/orders/'+orderId+'?t='+encodeURIComponent(token));
    if(r.status===403){msg('Link non valido o scaduto.');send.disabled=true;return;}
    const o=await r.json();
    if(['training','generating','completed'].indexOf(o.status)>=0){
      location.href='/grazie.html?order='+orderId+'&t='+encodeURIComponent(token);
    }
  }catch(e){/* ignora: si può comunque tentare l'upload */}
})();

send.addEventListener('click',async function(){
  if(selectedFiles.length<6){msg('Carica almeno 6 foto (consigliate 8-16, varie per sfondo e luce).');return;}
  send.disabled=true; msg('Caricamento in corso…');
  const fd=new FormData();
  selectedFiles.forEach(function(file){fd.append('photos',file);});
  try{
    const r=await fetch('/api/orders/'+orderId+'/photos?t='+encodeURIComponent(token),{method:'POST',body:fd});
    const d=await r.json();
    if(r.ok&&d.ok){ location.href='/grazie.html?order='+orderId+'&t='+encodeURIComponent(token); return; }
    msg('Ops: '+(d.error||r.status)); send.disabled=false;
  }catch(err){ msg('Errore di rete: '+err.message+'. Riprova.'); send.disabled=false; }
});
