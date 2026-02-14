# SoundReel — Documentazione

> Versione 1.4.0 — Febbraio 2026

## Cos'è SoundReel

SoundReel è una web app personale (single-user) che analizza contenuti social — Instagram Reels, TikTok, YouTube, e altri — per estrarre automaticamente **canzoni**, **film**, **note**, **link** e **tag** menzionati. Le canzoni identificate vengono aggiunte a una playlist Spotify. Tutto viene registrato in un journal cronologico consultabile da browser o via Telegram bot.

---

## Funzionalità

### Analisi contenuti social
- Incolla un URL da Instagram, TikTok, YouTube, Facebook, Twitter/X, Threads, Reddit, Vimeo, Spotify, SoundCloud o qualsiasi sito web
- La pipeline estrae automaticamente:
  - **Canzoni** — dall'audio del video (fingerprinting AudD), dai metadati Instagram del reel, o dall'analisi AI della caption
  - **Film/Serie** — menzionati nella caption, con ricerca automatica su TMDb per poster e link IMDb
  - **Note** — categorizzate: luoghi, eventi, brand, libri, prodotti, citazioni, persone
  - **Link** — estratti dalla caption
  - **Tag** — hashtag e menzioni rilevanti
  - **Sintesi** — riassunto AI di 1-2 frasi del contenuto del post

### Playlist Spotify automatica
- OAuth 2.0 PKCE per collegare il proprio account Spotify
- Crea automaticamente una playlist privata "SoundReel"
- Ogni canzone identificata viene cercata su Spotify e aggiunta alla playlist
- Link YouTube generati per ogni canzone (ricerca, non API)

### Telegram Bot
- Invia un link social al bot e ricevi l'analisi direttamente in chat
- Comandi: `/start` (benvenuto), `/stats` (statistiche), `/status` (ultima entry)
- Risposte formattate con emoji, canzoni, film, note e link

### Deep Search (Enrichment)
- Pulsante 🔍 sulle entry card per arricchire i risultati con link verificati dal web
- Usa OpenAI Responses API (gpt-4o-mini) con web search integrato
- Genera link a video musicali, pagine Wikipedia, siti ufficiali di brand/prodotti, trailer di film
- API key configurabile da Impostazioni

### Retry
- Pulsante ↻ su ogni entry completata per rianalizzare da zero
- Cancella l'entry esistente e rilancia l'analisi sullo stesso URL

### Prompt AI personalizzabili
- Due prompt modificabili dall'interfaccia: analisi contenuto (Gemini) e risposta Telegram
- Template Handlebars con variabili disponibili
- Reset ai default in qualsiasi momento

### Console di debug
- Log in tempo reale di tutte le operazioni
- Filtri per livello (debug/info/warn/error), funzione, entry ID
- Dettagli espandibili con dati JSON e stack trace
- Pulizia automatica dopo 7 giorni

---

## Architettura

### Stack tecnologico

| Componente | Tecnologia |
|---|---|
| Frontend | React 18 + Vite + TypeScript, SPA su Firebase Hosting |
| Backend | Firebase Cloud Functions 2nd gen (Node.js 20, TypeScript) |
| Database | Cloud Firestore |
| AI | Gemini 2.0 Flash (`@google/generative-ai` SDK) |
| Music Recognition | AudD API (audio fingerprinting) + Instagram metadata |
| Film DB | TMDb API |
| Music Streaming | Spotify Web API (OAuth 2.0 PKCE) |
| Messaging | Telegram Bot API (webhook) |
| Video Extraction | cobalt.tools API (opzionale) |
| Enrichment | OpenAI Responses API (gpt-4o-mini + web_search_preview) |

### Pipeline di analisi

```
URL in ingresso
    │
    ├─ 1. Idempotenza: verifica se URL già processato
    │
    ├─ 2. Estrazione contenuto
    │     ├─ Instagram con cookie → API privata (caption + video + thumbnail + musica)
    │     ├─ Altre piattaforme → oEmbed API
    │     ├─ Fallback → OG meta scraping
    │     └─ Audio → cobalt.tools (se abilitato)
    │
    ├─ 3. Analisi parallela
    │     ├─ AudD audio fingerprinting (o Instagram music metadata)
    │     └─ Gemini AI analysis (caption + thumbnail)
    │
    ├─ 4. Merge risultati (deduplica canzoni da audio + AI)
    │
    ├─ 5. Spotify: cerca tracce → aggiungi a playlist
    │
    ├─ 6. TMDb: cerca film → link IMDb + poster
    │
    └─ 7. Salva entry completata in Firestore
```

### Resilienza

Ogni step della pipeline è indipendente. Se uno fallisce, gli altri continuano:

- cobalt fallisce → usa OG meta scraping (solo caption + thumbnail)
- AudD non trova nulla → usa metadati Instagram o solo risultato Gemini
- Gemini fallisce → usa solo risultato AudD
- Spotify non trova la canzone → logga, non blocca
- TMDb non trova il film → mostra titolo/regista senza link IMDb
- Ogni errore viene registrato nell'actionLog dell'entry

### Firestore

**Una sola collection `entries`** — ogni documento è un'entry analizzata con:
- `sourceUrl`, `sourcePlatform`, `inputChannel`
- `caption`, `thumbnailUrl`
- `status` (processing / completed / error)
- `results` — oggetto con `songs[]`, `films[]`, `notes[]`, `links[]`, `tags[]`, `summary`, `enrichments[]`
- `actionLog[]` — cronologia di ogni azione eseguita
- `createdAt` — server timestamp

**Collection `config`** — documenti di configurazione:
- `spotify` — token OAuth, playlist ID
- `features` — feature flags (cobalt, duplicate URLs)
- `instagram` — cookie di sessione per API autenticata
- `openai` — API key per enrichment
- `prompts` — template AI personalizzati

**Collection `logs`** — log di debug con retention automatica di 7 giorni

### Cloud Functions

Tutte 2nd gen, region `europe-west1`, CORS abilitato:

| Funzione | Metodo | Scopo |
|---|---|---|
| `analyzeUrl` | POST | Pipeline principale di analisi (120s timeout) |
| `enrichEntry` | POST | Enrichment OpenAI con web search |
| `telegramWebhook` | POST | Webhook bot Telegram |
| `deleteEntry` | POST | Elimina singola entry |
| `deleteAllEntries` | POST | Elimina tutte le entry |
| `getFeatures` / `updateFeatures` | GET/POST | Gestione feature flags |
| `getInstagramCookies` / `updateInstagramCookies` | GET/POST | Gestione cookie Instagram |
| `getOpenAI` / `updateOpenAI` | GET/POST | Gestione config OpenAI |
| `getPrompts` / `updatePrompt` / `resetPrompt` | GET/POST | Gestione prompt AI |
| `cleanupLogs` | Scheduled | Pulizia log >7 giorni |
| `clearAllLogs` | POST | Cancella tutti i log |

### Frontend

SPA React con 4 pagine:

| Route | Pagina | Descrizione |
|---|---|---|
| `/` | Home | Input URL + Journal con entry card in tempo reale |
| `/settings` | Impostazioni | Spotify, Instagram, OpenAI, feature flags, lingua |
| `/prompts` | Prompt AI | Editor dei template Gemini e Telegram |
| `/console` | Console | Log di debug con filtri e dati espandibili |

Aggiornamenti in tempo reale tramite Firestore `onSnapshot`. Dark mode non presente, tema chiaro Apple-style. Supporto multilingua italiano/inglese.

---

## API esterne e chiavi

### Secrets (Firebase Secret Manager)

| Secret | Servizio | Come ottenerlo |
|---|---|---|
| `GEMINI_API_KEY` | Google AI Studio | [aistudio.google.com](https://aistudio.google.com) |
| `AUDD_API_KEY` | AudD | [audd.io](https://audd.io) |
| `SPOTIFY_CLIENT_ID` | Spotify | [developer.spotify.com](https://developer.spotify.com/dashboard) |
| `SPOTIFY_CLIENT_SECRET` | Spotify | Dashboard stessa app |
| `TMDB_API_KEY` | TMDb | [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) |
| `TELEGRAM_BOT_TOKEN` | Telegram | [BotFather](https://t.me/BotFather) |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram | Stringa custom per validazione webhook |

### Config runtime (Firestore, modificabili da UI)

| Chiave | Servizio | Come ottenerlo |
|---|---|---|
| OpenAI API Key | OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Instagram Cookies | Instagram | DevTools → Application → Cookies → instagram.com |

---

## Note di utilizzo

### Setup iniziale

```bash
# 1. Clona e configura
git clone <repo>
cd soundreel
./scripts/setup.sh

# 2. Configura secrets
./scripts/set-secrets.sh

# 3. Deploy
./scripts/deploy.sh
```

### Configurazione Instagram

Per analizzare reel Instagram con estrazione musica:

1. Apri Instagram nel browser e fai login
2. DevTools (F12) → Application → Cookies → instagram.com
3. Copia: `sessionid`, `csrftoken`, `ds_user_id`
4. Impostazioni app → Cookie Instagram → incolla e salva
5. Abilita il toggle

I cookie scadono periodicamente — se l'estrazione smette di funzionare, aggiornali.

### Configurazione Spotify

1. Impostazioni → Collega Spotify
2. Autorizza l'accesso
3. La playlist "SoundReel" viene creata automaticamente al primo brano

### Enrichment con OpenAI

1. Impostazioni → OpenAI Deep Search
2. Inserisci API key da platform.openai.com
3. Abilita il toggle
4. Usa il pulsante 🔍 sulle entry card

### Comandi utili

```bash
# Dev locale frontend
cd frontend && npm run dev

# Dev locale con emulatori Firebase
firebase emulators:start --only functions,firestore

# Deploy solo frontend
./scripts/deploy-hosting.sh

# Deploy solo functions
bash scripts/deploy-functions.sh

# Deploy completo
./scripts/deploy.sh

# Build di verifica
cd functions && npm run build
cd frontend && npm run build
```

### Piattaforme supportate

Instagram, TikTok, YouTube, Facebook, Twitter/X, Threads, Snapchat, Pinterest, LinkedIn, Reddit, Vimeo, Twitch, Spotify, SoundCloud — e qualsiasi URL web generico via OG scraping.

### Limiti noti

- Instagram richiede cookie di sessione per l'estrazione completa (caption, video, musica). Senza cookie, il fallback OG scraping potrebbe non funzionare per contenuti privati o protetti.
- cobalt.tools è disabilitato di default perché l'API pubblica richiede autenticazione. Per l'estrazione audio da piattaforme non-Instagram, considerare il self-hosting di cobalt.
- I token Spotify scadono dopo 1 ora ma vengono rinnovati automaticamente. Se la playlist smette di funzionare, ricollegare da Impostazioni.
- L'enrichment OpenAI ha un costo per chiamata API. Usare `gpt-4o-mini` minimizza i costi.
