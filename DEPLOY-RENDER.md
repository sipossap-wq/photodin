# Deploy su Render

Guida per pubblicare photodin su Render con un dominio pubblico (niente ngrok).

## ⚠ Disco persistente OBBLIGATORIO

L'app salva ordini (`orders.json`) e foto su file. Su Render il filesystem è
**effimero**: senza un **disco persistente** perderesti tutto a ogni deploy/riavvio.
Il disco richiede un piano a pagamento (Starter o superiore), non il free.

Il `render.yaml` nel repo monta un disco da 1 GB su `/var/data` e imposta
`DATA_DIR=/var/data`, così ordini e foto ci finiscono dentro.

## 1. Crea il servizio

**Opzione Blueprint (consigliata):** su Render → *New* → *Blueprint* → collega il
repo GitHub. Render legge `render.yaml` e crea il web service + il disco.

**Opzione manuale:** *New* → *Web Service* → repo → Runtime *Node*, build
`npm install`, start `npm start`, Health Check Path `/health`. Poi aggiungi a mano
un **Disk** (mount path `/var/data`, 1 GB) e le variabili sotto.

## 2. Variabili d'ambiente (dashboard → Environment)

Impostate dal blueprint: `NODE_ENV=production`, `DATA_DIR=/var/data`,
`TRUST_PROXY=1`, `ASTRIA_TEST_MODE=1`, `CALLBACK_SECRET` (generato).

Da impostare a mano (sono `sync:false`):

- `ASTRIA_API_KEY` — chiave Astria (serve anche in test mode)
- `STRIPE_SECRET_KEY` — chiave segreta Stripe (test all'inizio: `sk_test_...`)
- `STRIPE_WEBHOOK_SECRET` — vedi punto 4
- `PUBLIC_BASE_URL` — l'URL del servizio, es. `https://photodin.onrender.com`
  (lo conosci dopo il primo deploy; impostalo e fai *Manual Deploy*)
- *(opzionali)* `BREVO_API_KEY`, `EMAIL_FROM`, `ADMIN_EMAIL`

## 3. Primo deploy

Parte in automatico. Quando è *Live*, copia l'URL pubblico
(`https://<nome>.onrender.com`) → mettilo in `PUBLIC_BASE_URL` → redeploy.
Verifica: apri `https://<nome>.onrender.com/health` → deve rispondere `{"ok":true}`.

## 4. Webhook Stripe (sul dominio Render)

Stripe Dashboard → *Developers → Webhooks → Add endpoint*:

- URL: `https://<nome>.onrender.com/api/webhooks/stripe`
- Evento: `checkout.session.completed`

Copia il *Signing secret* (`whsec_...`) → mettilo in `STRIPE_WEBHOOK_SECRET` su
Render → redeploy.

## 5. Prova il flusso

Apri `https://<nome>.onrender.com`:

1. Pacchetto + email + consenso → paga (carta test Stripe `4242 4242 4242 4242`)
2. Vieni reindirizzato alla pagina di caricamento → carica 8-16 foto
3. La pagina di consegna si aggiorna da sola con le foto

Con `ASTRIA_TEST_MODE=1` le immagini sono **mock (gratis)**: serve a verificare che
pagamento, upload e callback funzionino sul dominio reale.

## 6. Passa alla generazione reale

Quando il giro mock funziona: `ASTRIA_TEST_MODE=0` → redeploy → rifai un ordine.
Ora Astria genera ritratti veri (spende credito). Quando sei pronto al pubblico,
passa anche Stripe alle chiavi **live**.

## Note

- **Una sola istanza.** Lo storage su file non supporta più istanze in parallelo:
  tieni il servizio a 1 istanza (niente autoscaling) finché non passiamo a un DB.
- **`dev-pay`** è disattivo (`NODE_ENV=production`): online si paga sempre davvero.
- **HTTPS** è incluso da Render; `TRUST_PROXY=1` fa sì che il rate limiter veda l'IP reale.
- **Backup:** ogni tanto scarica `orders.json` dal disco (Render → Shell) finché non
  c'è un vero DB.
