// app.js — home photodin (flusso PAY-FIRST, "clic sull'offerta → Stripe").
// Scegli un pacchetto → si crea l'ordine → si apre subito Stripe col riepilogo.
// Email la chiede Stripe; consenso e foto si raccolgono dopo, su carica.html.
function goHome(){ if(document.referrer){location.href=document.referrer;} else if(history.length>1){history.back();} else {location.href='/';} }
const out=document.getElementById('out');
function show(){out.style.display='block';}
function msg(t){show();out.textContent=t;}

var navBack=document.getElementById('navBack'); if(navBack)navBack.addEventListener('click',goHome);
var navBrand=document.getElementById('navBrand'); if(navBrand)navBrand.addEventListener('click',goHome);

if(new URLSearchParams(location.search).get('canceled'))msg('Pagamento annullato. Puoi riprovare quando vuoi.');

const buttons=document.querySelectorAll('.buy');
buttons.forEach(function(b){ b.addEventListener('click', function(){ buy(b.dataset.pkg, b); }); });

async function buy(pkg, btn){
  buttons.forEach(function(b){ b.disabled=true; });
  msg('Preparazione del pagamento sicuro…');
  try{
    const r=await fetch('/api/orders',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({package:pkg}),
    });
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||String(r.status));
    const token=encodeURIComponent(d.token||'');

    // Caso normale: vai dritto alla pagina di pagamento Stripe (col riepilogo).
    if(d.methods.stripe){
      const checkout=await fetch('/api/orders/'+d.orderId+'/checkout/stripe?t='+token,{method:'POST'});
      const payment=await checkout.json();
      if(!checkout.ok||!payment.url)throw new Error(payment.error||'pagamento non disponibile');
      location.href=payment.url;
      return;
    }

    // Solo in prova (Stripe non configurato): salta il pagamento e vai al caricamento.
    if(d.devPay){
      const dev=await fetch('/api/orders/'+d.orderId+'/dev-pay?t='+token,{method:'POST'});
      const result=await dev.json();
      if(!dev.ok||!result.ok)throw new Error(result.error||'avvio prova non disponibile');
      location.href='/carica.html?order='+d.orderId+'&t='+token;
      return;
    }

    throw new Error('pagamento non disponibile');
  }catch(err){
    msg('Ops: '+err.message+'. Riprova tra un attimo.');
    buttons.forEach(function(b){ b.disabled=false; });
  }
}
