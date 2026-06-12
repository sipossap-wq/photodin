# photodin — Backend Astria

Backend minimale che genera headshot AI tramite [Astria](https://docs.astria.ai).
Flusso: foto del cliente → addestra un modello del volto (tune) → genera i ritratti → callback → consegna.

## Flusso

1. Il cliente carica le foto → si crea un ordine `pending_payment` (foto salvate, Astria **non** ancora chiamato)
2. Il cliente paga con **Stripe** (carta, Apple Pay, Google Pay)
3. A pagamento confermato la generazione parte da sola

## Endpoint

- `POST /api/orders` — crea l'ordine (email + foto), stato `pending_payment`
- `POST /api/orders/:id/checkout/stripe` — avvia pagamento Stripe → URL
- `POST /api/webhooks/stripe` — webhook Stripe (avvia la generazione)
- `POST /api/callbacks/tune` / `…/prompt` — webhook Astria
- `GET  /api/orders/:id` — stato e foto pronte (polling)
- `POST /api/orders/:id/regenerate` — rigenerazione gratuita (garanzia)
- pagina di test su `http://localhost:3000`

I pacchetti sono in `styles.js`: **Base** = 40 foto (8 stili × 5), **Pro** = 60 foto (12 × 5).

## Setup

1. Installa le dipendenze:
   ```bash
   cd backend
   npm install
   ```

2. Configura le variabili:
   ```bash
   cp .env.example .env
   ```
   - `ASTRIA_API_KEY` → da https://www.astria.ai/users/edit#api
   - `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` → dashboard Stripe (chiavi "test")
      - `PUBLIC_BASE_URL` → vedi punto 3
   - `ASTRIA_TEST_MODE=1` → genera immagini mock **gratis** finché provi l'integrazione

   ### Webhook Stripe
   Nel dashboard Stripe crea un webhook verso `<PUBLIC_BASE_URL>/api/webhooks/stripe`
   con l'evento `checkout.session.completed`, poi incolla il segreto in `STRIPE_WEBHOOK_SECRET`.
   In locale puoi usare la Stripe CLI: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.

3. **Callback pubblici.** Astria deve poter raggiungere il tuo server da internet.
   In locale usa [ngrok](https://ngrok.com):
   ```bash
   ngrok http 3000
   ```
   Copia l'URL `https://....ngrok-free.app` dentro `PUBLIC_BASE_URL` nel `.env`.

4. Avvia:
   ```bash
   npm start
   ```
   Apri `http://localhost:3000`, carica 6–10 foto e avvia. Le foto compaiono
   man mano che Astria le genera (qualche minuto su Flux).

## Costi (a tuo carico, lato Astria)

Paghi Astria per ogni tune (training) e per ogni immagine generata. In fase di
validazione tieni d'occhio il costo per ordine: rientra nei ~€1/ordine previsto
nel piano solo se controlli `num_images` per pacchetto.

## ⚠ GDPR — da sistemare prima del lancio reale

Astria è un fornitore **extra-UE** e qui tratti **dati biometrici** (volti):

- Clausole Contrattuali Standard (SCC) con Astria + verifica che non riusino le immagini per training
- **DPIA** (art. 35 GDPR) redatta prima del lancio
- Consenso esplicito del cliente e **cancellazione delle immagini entro 24–48h** (da implementare: oggi le URL restano in `data/orders.json`)
- Divieto di upload di volti di terzi/minori nei Termini

## Prossimi passi

- Collegare un pagamento (Stripe) prima di `POST /api/orders`
- Invio email al cliente quando l'ordine è `completed` (vedi TODO in `server.js`)
- Cancellazione automatica delle immagini dopo la consegna
- Sostituire il file JSON con un DB se il volume cresce
