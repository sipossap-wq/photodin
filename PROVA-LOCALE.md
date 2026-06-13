# Prova locale end-to-end (Stripe + Astria + ngrok)

Guida per provare l'intero flusso **pay-first** sul tuo computer. Due fasi:
**A) gratis** (immagini mock) per verificare la pipeline, **B) reale** (spende credito Astria).

## Cosa ti serve

- **Node 18+** (`node -v`)
- **Account ngrok** (gratuito) → https://ngrok.com — serve perché Astria e Stripe
  devono raggiungere il tuo server da internet
- **Chiave API Astria** → https://www.astria.ai/users/edit#api
  (serve **anche** in modalità test: le immagini mock sono gratis ma l'API va chiamata)
- **Chiavi Stripe in modalità test** → https://dashboard.stripe.com/test/apikeys
- **Stripe CLI** (per il webhook in locale) → https://docs.stripe.com/stripe-cli
- *(Opzionale)* chiave **Brevo** per l'email di consegna — senza, l'email viene saltata

## 1. Dipendenze

```bash
cd photodin-github
npm install
```

## 2. Configura `.env`

```bash
cp .env.example .env
```

Compila almeno:

```
CALLBACK_SECRET=<incolla: openssl rand -hex 32>
ASTRIA_API_KEY=<la tua chiave Astria>
ASTRIA_TEST_MODE=1          # FASE A: mock gratis. Metti 0 per la FASE B (reale)
STRIPE_SECRET_KEY=sk_test_...
PUBLIC_BASE_URL=            # lo riempi al punto 3 con l'URL ngrok
NODE_ENV=development        # in 'production' il dev-pay è disattivo
```

Genera il segreto:
```bash
openssl rand -hex 32
```

## 3. Apri il tunnel ngrok

In un terminale dedicato:
```bash
ngrok http 3000
```
Copia l'URL `https://....ngrok-free.app` e mettilo in `PUBLIC_BASE_URL` nel `.env`.
**Importante:** dev'essere l'URL `https` di ngrok, altrimenti i callback di Astria non arrivano.

## 4. Webhook Stripe

In un altro terminale:
```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```
La CLI stampa un segreto `whsec_...`: incollalo in `STRIPE_WEBHOOK_SECRET` nel `.env`.

## 5. Avvia il server

```bash
npm start
```
Dovresti vedere: `photodin backend su http://localhost:3000` con `Stripe: on · TestMode: on`.

## 6. Prova il flusso (dal browser)

Apri **l'URL ngrok** (non localhost, così i redirect e i callback combaciano):

1. Scegli il pacchetto, inserisci email, spunta il consenso → **Continua al pagamento**
2. **Paga con carta** → usa la carta di test Stripe: `4242 4242 4242 4242`,
   data futura qualsiasi, CVC qualsiasi
3. Vieni reindirizzato a **carica.html** → carica **8-16 foto** della stessa persona
4. Parte la generazione → la pagina **grazie** si aggiorna da sola e mostra le foto
   man mano che arrivano (in FASE A sono immagini mock)

## 7. FASE B — generazione reale

Quando la pipeline funziona in mock:
- metti `ASTRIA_TEST_MODE=0` nel `.env`
- riavvia (`npm start`)
- rifai un ordine: ora Astria addestra il modello sul volto e genera ritratti veri
  (richiede qualche minuto e **spende credito Astria**)

## Scorciatoia senza Stripe (solo per provare l'upload/generazione)

Con `NODE_ENV` diverso da `production` e `ASTRIA_TEST_MODE=1`, in pagina compare il
pulsante **▶ Avvia (modalità prova)**: simula il pagamento (`dev-pay`) e ti porta
diritto al caricamento foto, saltando Stripe. Utile per testare solo la parte Astria.

## Problemi frequenti

- **Il server non parte** → manca `CALLBACK_SECRET` (è obbligatorio).
- **Le foto non arrivano sulla pagina grazie** → `PUBLIC_BASE_URL` non è l'URL ngrok
  `https`, oppure Astria non riesce a chiamare i callback.
- **Webhook Stripe ignorato** → `STRIPE_WEBHOOK_SECRET` non corrisponde a quello
  stampato da `stripe listen`.
- **`dev-pay` dà 403** → sei in `NODE_ENV=production` (lì è disattivo apposta).
- **Email non inviata** → manca `BREVO_API_KEY`/`EMAIL_FROM` (opzionali in prova).

## Test automatici (senza servizi esterni)

```bash
npm test
```
