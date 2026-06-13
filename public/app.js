// app.js — pagina d'ordine photodin (flusso PAY-FIRST).
// Step 1: pacchetto + email + consenso → crea ordine → paga (Stripe).
// Le foto si caricano DOPO il pagamento, su carica.html.
function goHome(){ if(document.referrer){location.href=document.referrer;} else if(history.length>1){history.back();} else {location.href='/';} }
const f=document.getElementById('f'),out=document.getElementById('out'),payBox=document.getElementById('pay');
let orderId=null,orderToken=null,pkg='standard';

var navBack=document.getElementById('navBack'); if(navBack)navBack.addEventListener('click',goHome);
var navBrand=document.getElementById('navBrand'); if(navBrand)navBrand.addEventListener('click',goHome);

// pacchetto: da URL (?package=standard|pro|studio) o default standard
const qs=new URLSearchParams(location.search);
var qp=qs.get('package'); if(['standard','pro','studio'].indexOf(qp)>=0)pkg=qp;
function paintPlans(){document.querySelectorAll('.plan[data-pkg]').forEach(p=>p.classList.toggle('sel',p.dataset.pkg===pkg));}
document.querySelectorAll('.plan[data-pkg]').forEach(p=>p.onclick=()=>{pkg=p.dataset.pkg;paintPlans();});
paintPlans();

if(qs.get('canceled'))msg('Pagamento annullato. Puoi riprovare quando vuoi.');

f.addEventListener('submit',async e=>{
  e.preventDefault();
  const email=(f.email.value||'').trim();
  const consent=f.consent.checked;
  if(!email){msg('Inserisci la tua email.');return;}
  if(!consent){msg('Devi accettare il consenso e i termini per continuare.');return;}
  msg('Creazione ordine in corso…');
  try{
    const r=await fetch('/api/orders',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email,package:pkg,subjectClass:f.subjectClass.value,consent:true}),
    });
    const d=await r.json();
    if(!r.ok){msg('Ops: '+(d.error||r.status));return;}
    orderId=d.orderId;orderToken=d.token;
    msg('Ordine creato · €'+d.amount+'. Procedi al pagamento qui sotto.');
    payBox.style.display='block';
    document.getElementById('payStripe').style.display=d.methods.stripe?'flex':'none';
    document.getElementById('payDev').style.display=d.devPay?'flex':'none';
    payBox.scrollIntoView({behavior:'smooth'});
  }catch(err){msg('Errore di rete: '+err.message+'. Riprova tra un attimo.');}
});

document.getElementById('payStripe').onclick=()=>goPay('stripe');
document.getElementById('payDev').onclick=async()=>{
  msg('Simulazione pagamento…');
  const r=await fetch('/api/orders/'+orderId+'/dev-pay?t='+encodeURIComponent(orderToken||''),{method:'POST'});
  const d=await r.json();
  if(d.ok){location.href='/carica.html?order='+orderId+'&t='+encodeURIComponent(orderToken||'');}
  else msg('Errore: '+(d.error||'pagamento non riuscito'));
};
async function goPay(m){
  msg('Apertura pagamento…');
  const r=await fetch('/api/orders/'+orderId+'/checkout/'+m+'?t='+encodeURIComponent(orderToken||''),{method:'POST'});
  const d=await r.json();
  if(d.url)location.href=d.url;else msg('Errore: '+(d.error||'pagamento non disponibile'));
}

function show(){out.style.display='block';}
function msg(t){show();out.textContent=t;}
