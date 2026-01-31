# SoundReel 🎵🎬

App personale che analizza contenuti social (Instagram Reels, TikTok, post) per estrarre canzoni e film. Le canzoni vengono aggiunte automaticamente a una playlist Spotify. Tutto viene loggato in un journal cronologico.

## Come funziona

1. **Condividi** un link social al bot Telegram o incollalo nel frontend web
2. **SoundReel analizza** il contenuto: audio fingerprinting (AudD) + analisi AI (Gemini) della caption e thumbnail
3. **Canzoni trovate** → cercate su Spotify → aggiunte alla playlist "SoundReel"
4. **Film trovati** → loggati con link IMDb
5. **Tutto registrato** nel journal con log dettagliato della pipeline

## Prerequisiti

### Strumenti da installare

- [Node.js 20+](https://nodejs.org/) — runtime per frontend e Cloud Functions
- [Firebase CLI](https://firebase.google.com/docs/cli) — `npm install -g firebase-tools`
- Un account Google per Firebase/GCP

### Account e API keys da creare

Prima di fare il setup, devi creare questi account e ottenere le chiavi. Segui l'ordine.

#### 1. Firebase Project

1. Vai su [Firebase Console](https://console.firebase.google.com/)
2. Crea un nuovo progetto (es. `soundreel`)
3. Attiva **Firestore Database** (modalità production, region `eur3` o `europe-west1`)
4. Attiva **Firebase Hosting**
5. Vai su Project Settings → General → annota il **Project ID**
6. Vai su Project Settings → General → "Your apps" → aggiungi una **Web app** → annota `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`

#### 2. Gemini API Key (Google AI Studio)

1. Vai su [Google AI Studio](https://aistudio.google.com/apikey)
2. Clicca "Create API Key"
3. Seleziona il progetto Firebase appena creato
4. Copia la **API key**

#### 3. AudD (Music Recognition)

1. Vai su [AudD Dashboard](https://dashboard.audd.io/)
2. Registrati (free)
3. Copia la **API token** dalla dashboard
4. Free tier: 1000 richieste/mese

#### 4. TMDb (Film Database)

1. Vai su [TMDb](https://www.themoviedb.org/signup)
2. Registrati
3. Vai su Settings → API → Request an API key (tipo: Developer)
4. Copia la **API key (v3 auth)**
5. Free tier: illimitato per uso non commerciale

#### 5. Spotify Developer

1. Vai su [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Crea una nuova app:
   - App name: `SoundReel`
   - Redirect URI: `https://{tuo-progetto}.web.app/settings` (lo aggiorni dopo il primo deploy)
   - API/SDKs: seleziona "Web API"
3. Copia **Client ID** e **Client Secret**
4. Nota: la Redirect URI la aggiorni dopo il primo deploy quando conosci l'URL Firebase Hosting

#### 6. Telegram Bot

1. Apri Telegram, cerca [@BotFather](https://t.me/BotFather)
2. Invia `/newbot`
3. Scegli un nome (es. "SoundReel Bot") e un username (es. `soundreel_bot`)
4. Copia il **bot token**
5. Il webhook lo registri dopo il deploy delle Cloud Functions (lo fa lo script)

## Setup

### 1. Clona e configura

```bash
# Clona il progetto
git clone <repo-url> soundreel
cd soundreel

# Copia il file di environment
cp .env.example .env
```

Compila il file `.env` con tutte le chiavi ottenute sopra.

### 2. Esegui lo script di setup

```bash
chmod +x scripts/*.sh
./scripts/setup.sh
```

Lo script:
- Verifica che Firebase CLI sia installato
- Ti fa login su Firebase
- Associa il progetto Firebase
- Installa le dipendenze (frontend + functions)
- Configura i secrets in Firebase

### 3. Primo deploy

```bash
./scripts/deploy.sh
```

### 4. Configura Spotify Redirect URI

Dopo il primo deploy:
1. Prendi l'URL del tuo sito da Firebase Hosting (es. `https://soundreel-abc12.web.app`)
2. Vai su Spotify Developer Dashboard → la tua app → Edit Settings
3. Aggiungi `https://soundreel-abc12.web.app/settings` come Redirect URI
4. Aggiorna `SPOTIFY_REDIRECT_URI` nel tuo `.env` e riesegui `./scripts/set-secrets.sh`

### 5. Registra il webhook Telegram

Lo script di deploy lo fa automaticamente. Se devi farlo manualmente:

```bash
curl -X POST "https://api.telegram.org/bot{BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://europe-west1-{PROJECT_ID}.cloudfunctions.net/telegramWebhook?secret={WEBHOOK_SECRET}"}'
```

### 6. Collega Spotify

1. Apri il sito (`https://{progetto}.web.app`)
2. Vai su Settings
3. Clicca "Collega Spotify"
4. Autorizza l'app
5. La playlist "SoundReel" viene creata automaticamente

## Sviluppo locale

```bash
# Frontend con hot reload
cd frontend
npm run dev
# → http://localhost:5173

# Emulatore Firebase (Firestore + Functions)
firebase emulators:start --only functions,firestore
# → Firestore UI: http://localhost:4000
# → Functions: http://localhost:5001
```

## Deploy

```bash
# Deploy completo (frontend + functions)
./scripts/deploy.sh

# Solo frontend
./scripts/deploy-hosting.sh

# Solo Cloud Functions
./scripts/deploy-functions.sh
```

## Costi

Per uso personale (poche decine di analisi al giorno): **0€/mese**.

| Servizio | Free tier |
|----------|-----------|
| Firebase Hosting | 10 GB storage, 360 MB/giorno transfer |
| Cloud Functions | 125K invocazioni/mese, 40K GB-sec |
| Firestore | 50K letture/giorno, 20K scritture/giorno |
| Gemini Flash | 15 RPM, 1M token/giorno |
| AudD | 1000 richieste/mese |
| TMDb | Illimitato (non commerciale) |
| Spotify API | Nessun limite pratico |
| Telegram Bot | Nessun limite pratico |

## Struttura dati

Ogni entry in Firestore (`entries` collection):

```json
{
  "sourceUrl": "https://instagram.com/reel/...",
  "sourcePlatform": "instagram",
  "inputChannel": "telegram",
  "caption": "...",
  "status": "completed",
  "results": {
    "songs": [{ "title": "...", "artist": "...", "spotifyUrl": "...", "youtubeUrl": "..." }],
    "films": [{ "title": "...", "director": "...", "imdbUrl": "..." }]
  },
  "actionLog": [
    { "action": "url_received", "timestamp": "...", "details": {} }
  ],
  "createdAt": "..."
}
```

## Troubleshooting

**La pipeline è lenta (>30s)**: normale, ci sono chiamate a 5+ API esterne. Il frontend si aggiorna in real-time via Firestore onSnapshot.

**AudD non riconosce la canzone**: succede spesso con audio remixato o parlato sopra. L'analisi AI di Gemini sulla caption di solito compensa.

**Cobalt non riesce a scaricare il video**: Instagram cambia spesso le sue difese anti-scraping. Il fallback su OG meta scraping funziona per estrarre almeno la caption.

**Token Spotify scaduto**: il refresh è automatico. Se fallisce, ricollega Spotify dalla pagina Settings.
