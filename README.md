# photodin — Backend Astria

Backend minimale che genera headshot AI tramite [Astria](https://docs.astria.ai).
Flusso: foto del cliente → addestra un modello del volto (tune) → genera i ritratti → callback → consegna via email.

## Flusso (PAY-FIRST)

1. Il cliente sceglie pacchetto + email + consenso → si crea un ordine `awaiting_payment` (**nessuna foto** salvata). L'ordine riceve un **token segreto**.
2. Il cliente paga con **Stripe** (carta, Apple Pay, Google Pay).
3. A pagamento confermato (webhook Stripe, con verifica di importo/valuta) l'ordine passa a `paid`.
4. Stripe reindirizza alla pagina di **caricamento foto** (`carica.html`). Il cliente carica le foto → vengono validate e normalizzate (sharp) e parte la generazione.
5. A fine generazione il cliente riceve un'**email** (Brevo) con il link alle foto.
6. Dopo `RETENTION_HOURS` foto e modello vengono **cancellati** automaticamente (GDPR). Le foto biometriche esistono **solo per ordini pagati**.

## Pacchetti

Definiti in `styles.js` (`PACKAGE_PHOTOS`) e `payments.js`:

| Pacchetto | Foto | Prezzo |
|-----------|------|--------|
| Standard  | 30   | €19,90 |
| Pro       | 100  | €34,90 |
| Studio    | 120  | €49,90 |

Gli stili (corporate, ufficio, LinkedIn, studio, ecc.) sono in `styles.js`. Se il
cliente non sceglie nulla, viene generato un set vario su tutti gli stili. Il
numero di foto è **esatto** per pacchetto qualunque sia il numero di stili scelti
(`buildPrompts` distribuisce con precisione su tutti i prompt).

## Endpoint

- `POST /api/orders` — crea l'ordine (email + pacchetto + consenso, **senza foto**), stato `awaiting_payment`; risponde con `orderId` e `token`. *(rate-limited)*
- `POST /api/orders/:id/checkout/stripe?t=TOKEN` — avvia il pagamento Stripe → URL. *(richiede token; solo ordini `awaiting_payment`)*
- `POST /api/orders/:id/photos?t=TOKEN` — carica le foto **dopo** il pagamento (solo ordini `paid`), valida/normalizza e avvia la generazione. *(rate-limited)*
- `POST /api/webhooks/stripe` — webhook Stripe (firma + importo/valuta verificati; marca `paid`)
- `POST /api/callbacks/tune` / `…/prompt` — webhook Astria *(richiedono `?secret=CALLBACK_SECRET`)*
- `GET  /api/orders/:id?t=TOKEN` — stato e foto pronte (polling). *(richiede token)*
- `POST /api/orders/:id/regenerate?t=TOKEN` — rigenerazione gratuita, max `REGEN_LIMIT`. *(richiede token; prompt sempre interno)*
- `GET  /api/styles` — catalogo stili
- `GET  /health` — healthcheck
- `POST /api/orders/:id/dev-pay?t=TOKEN` — avvia senza pagamento, **solo** in test mode / `ALLOW_DEV_PAY=1`
- Pagina d'ordine su `http://localhost:3000`

## Sicurezza

- **`CALLBACK_SECRET` obbligatorio**: il server non parte se manca; protegge i callback Astria.
- **Token per-ordine**: lettura stato, checkout e rigenerazione richiedono il token (niente IDOR sui dati biometrici, niente generazioni a carico tuo). Risposte uniformi per non rivelare quali ordini esistono.
- **CSP + helmet**: `script-src 'self'` (gli script delle pagine sono in `public/app.js` e `public/grazie.js`); le immagini sono costruite via DOM con sole URL `http(s)` (anti-XSS).
- **Rate limiting** su `/api/orders` e checkout; **`diskStorage`** (Multer 2.x) per gli upload (niente picco di memoria).
- **Normalizzazione immagini con `sharp`**: ogni foto viene ri-codificata in JPEG, orientata via EXIF, ridimensionata entro `MAX_PHOTO_SIDE` e **ripulita dai metadati (EXIF/GPS)** prima di andare ad Astria — privacy + difesa contro file malevoli.
- **Webhook Stripe**: oltre alla firma, verifica `payment_status`, **importo e valuta esatti** del pacchetto prima di avviare la generazione.
- **Anti doppio addebito**: il checkout **riusa** la sessione Stripe ancora aperta invece di crearne una nuova; ordini già avviati danno `409`.
- **Callback Astria idempotenti**: i prompt completati sono contati per ID univoco, quindi un retry non falsa il conteggio né rimanda l'email.
- **Email di consegna con retry**: `emailSent` viene impostato solo a invio riuscito; il watchdog ritenta gli ordini completati non ancora notificati.
- **Resilienza ordini**: il watchdog recupera anche gli ordini rimasti `training` senza `tuneId` (es. crash a metà avvio).
- **`dev-pay` sempre off in produzione** (`NODE_ENV=production`); ordini non pagati cancellati entro `PENDING_TTL_MINUTES`.
- **Validazione input**: email e `subjectClass`; `trust proxy` configurabile (`TRUST_PROXY`) per un rate limiting non aggirabile.

## Setup

1. Installa le dipendenze:
   ```bash
   npm install
   ```

2. Configura le variabili:
   ```bash
   cp .env.example .env
   ```
   - `CALLBACK_SECRET` → **obbligatorio**, genera con `openssl rand -hex 32`
   - `ASTRIA_API_KEY` → da https://www.astria.ai/users/edit#api
   - `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` → dashboard Stripe (chiavi "test")
   - `BREVO_API_KEY` + `EMAIL_FROM` (verificato su Brevo) → per le email di consegna
   - `PUBLIC_BASE_URL` → vedi punto 4
   - `ASTRIA_TEST_MODE=1` → genera immagini mock **gratis** finché provi l'integrazione

3. **Webhook Stripe.** Nel dashboard Stripe crea un webhook verso
   `<PUBLIC_BASE_URL>/api/webhooks/stripe` con l'evento `checkout.session.completed`,
   poi incolla il segreto in `STRIPE_WEBHOOK_SECRET`. In locale:
   ```bash
   stripe listen --forward-to localhost:3000/api/webhooks/stripe
   ```

4. **Callback pubblici.** Astria/Stripe devono raggiungere il server da internet.
   In locale usa [ngrok](https://ngrok.com):
   ```bash
   ngrok http 3000
   ```
   Copia l'URL `https://....ngrok-free.app` in `PUBLIC_BASE_URL` nel `.env`.

5. Avvia:
   ```bash
   npm start
   ```
   Apri `http://localhost:3000`, carica 6–16 foto e avvia. Le foto compaiono man
   mano che Astria le genera (qualche minuto su Flux).

## Test

```bash
npm test
```

Suite con il runner nativo di Node (nessuna dipendenza extra): unit sul conteggio
esatto delle foto e integration sul server reale (token gate, anti-enumerazione,
idempotenza dei callback, anteprima rimossa, header CSP, `CALLBACK_SECRET` obbligatorio).

## Costi (a tuo carico, lato Astria)

Paghi Astria per ogni tune (training) e per ogni immagine generata. In fase di
validazione tieni d'occhio il costo per ordine: dipende da `num_images` per
pacchetto (vedi `PACKAGE_PHOTOS` in `styles.js`).

## ⚠ GDPR — prima del lancio reale

Astria è un fornitore **extra-UE** e qui tratti **dati biometrici** (volti). Già
implementato nel codice: consenso esplicito obbligatorio, cancellazione
automatica di foto e modello dopo `RETENTION_HOURS` (default 48h, `cleanup()`),
blocco upload screenshot/foto troppo piccole. Resta da fare lato legale:

- Clausole Contrattuali Standard (SCC) con Astria + verifica che non riusino le immagini per training
- **DPIA** (art. 35 GDPR) redatta prima del lancio
- Termini che vietino l'upload di volti di terzi/minori (consenso già richiesto in fase d'ordine)

## Prossimi passi

- Sostituire il file JSON (`data/orders.json`) con un DB se il volume cresce (il rate limiter va su uno store condiviso, es. Redis, se gira su più processi)
- Backup/retention dei log
- Completare gli adempimenti GDPR legali sopra
