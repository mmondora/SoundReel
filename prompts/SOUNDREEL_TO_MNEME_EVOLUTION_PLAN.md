# Piano Evolutivo: SoundReel -> Mneme

> Documento generato dall'analisi della codebase SoundReel v1.4.20
> Data: 2026-04-06
> SoundReel cloud resta in produzione su `main`. Mneme evolve in un worktree separato.

---

## Fase 1 — SoundReel As-Is (Mappa reale della codebase)

### Struttura del progetto

SoundReel e' una **web app** (non iOS), composta da:

| Target | Tecnologia | Deploy |
|--------|-----------|--------|
| Frontend SPA | React 18 + Vite + TypeScript | Firebase Hosting (`soundreel-776c1.web.app`) |
| Backend API | Firebase Cloud Functions 2nd gen, Node.js 20, TypeScript | `europe-west1` |
| Database | Cloud Firestore | 3 collection: `entries`, `config/*`, `logs` |
| Bot Telegram | Webhook su Cloud Function | Stesso deploy delle functions |

**13 Cloud Functions** esportate da `functions/src/index.ts`:
`analyzeUrl`, `telegramWebhook`, `updatePrompt`, `getPrompts`, `resetPrompt`, `deleteEntry`, `deleteAllEntries`, `cleanupLogs`, `clearAllLogs`, `getFeatures`, `updateFeatures`, `getInstagramCookies`, `updateInstagramCookies`, `enrichEntry`, `getOpenAI`, `updateOpenAI`, `readEntries`, `testReadConnection`, `getApiKeys`, `updateApiKeys`, `instagramHealthCheck`

**Dipendenze principali (backend):** `firebase-admin`, `firebase-functions`, `@google/generative-ai`, `@google-cloud/vertexai`, `handlebars`
**Dipendenze principali (frontend):** `firebase`, `react`, `react-router-dom`, `handlebars`

Nessun framework CSS, nessuna component library. CSS custom con variabili CSS.

### Data layer

**Firestore — 3 collection:**

- **`entries`**: documento per ogni URL analizzato. Campi: `sourceUrl`, `sourcePlatform` (14 piattaforme), `inputChannel` (web/telegram), `caption`, `thumbnailUrl`, `mediaUrl`, `status` (processing/completed/error), `results` (songs[], films[], notes[], links[], tags[], summary, transcript, enrichments[], transcription, visualContext, overlayText), `actionLog[]`, `createdAt`
- **`config/*`**: documenti di configurazione — `spotify` (OAuth tokens), `features` (7 feature flags), `instagram` (session cookies), `openai` (API key), `prompts` (4 template Handlebars), `apiKeys` (chiavi API esterne)
- **`logs`**: log strutturati con level/function/entryId/timestamp, 3 index compositi

**Nessun App Group, nessun CoreData, nessun SwiftData** — e' un'app web.

### Networking

Layer di rete custom in `frontend/src/services/api.ts`:
- 15+ funzioni che chiamano Cloud Functions via `fetch()` con base URL da `VITE_FUNCTIONS_URL`
- Nessun layer di caching HTTP, nessun retry automatico
- Error handling basico: catch generico con messaggi in italiano

Backend chiama 8+ API esterne:
- **Gemini 2.0 Flash** (via Google AI Studio SDK o Vertex AI)
- **AudD** (`https://api.audd.io/`) per audio fingerprinting
- **Spotify Web API** per search + playlist management
- **TMDb** (`https://api.themoviedb.org/3/`) per film
- **OpenAI** (`gpt-4o-mini` con web search) per enrichment
- **Cobalt self-hosted** su Cloud Run per estrazione video/audio
- **Instagram Private API** con session cookies
- **oEmbed API** per 9 piattaforme social

### Auth

**Nessuna autenticazione utente.** App single-user by design.
- Firestore rules: `allow read: if true; allow write: if false;`
- Tutte le scritture passano dall'admin SDK (Cloud Functions)
- Spotify OAuth PKCE per il collegamento playlist (token in Firestore `config/spotify`)
- Telegram webhook protetto da `X-Telegram-Bot-Api-Secret-Token`
- API keys in Firebase Secret Manager (7 secrets)

### Share Extension

**Non esiste.** SoundReel e' una web app. Gli input sono:
1. URL incollato nel frontend (form `UrlInput`)
2. URL inviato al bot Telegram
3. API `readEntries` per integrazione DawnPulse Social

### UI e navigazione

**React Router v6** con 8 route:

| Route | Pagina | Responsabilita' |
|-------|--------|-----------------|
| `/` | Home | Master-detail: lista entry (CompactCard) + inspector (EntryInspector). Mobile: tabs |
| `/entries` | EntriesPage | Lista paginata di tutte le entry, raggruppate per mese |
| `/songs` | SongsPage | Catalogo canzoni aggregate, con badge sorgente (AudD/AI) |
| `/films` | FilmsPage | Catalogo film, con link streaming (Netflix/Prime/Disney+/etc.) |
| `/notes` | NotesPage | Note categorizzate (place/event/brand/book/product/quote/person/other) |
| `/settings` | Settings | Spotify OAuth, feature toggles, Instagram cookies, OpenAI config, lingua |
| `/prompts` | Prompts | Editor template Handlebars per i 4 prompt AI |
| `/console` | Console | Viewer log real-time con filtri e ricerca |

**16 componenti** React funzionali con hooks.
**Nessun design system formale** — CSS custom con variabili, tema dark/light Apple-inspired.
**i18n** con Context API: italiano e inglese, 150+ chiavi.

### Test

**Nessun test automatico.** Zero file di test nel progetto. Esplicita scelta documentata in CLAUDE.md: "NON creare test automatici a meno che non venga richiesto esplicitamente."

---

## Fase 2 — Target: Mneme

*(Ripreso dalla richiesta — qui per completezza e come riferimento per il delta)*

Mneme e' un **personal knowledge vault** con:

- **Capture universale**: Share Extension iOS (qualsiasi tipo), Telegram bot, input manuale da app
- **Data model**: `Memo` con id, user_id, source, content_type, raw_url/text/file, title, summary, tags, collection_id, note, status (pending->synced->indexed->error)
- **Backend on-prem**: FastAPI + PostgreSQL + pgvector su Mac Mini M4
- **AI locale**: Ollama (nomic-embed-text per embedding, llama3.1:8b per RAG/summarization)
- **Auth**: JWT homemade, multi-utente familiare, token in Keychain
- **App iOS 3 tab**: Feed, Collections, Ask Mneme (chat RAG)
- **Sync offline-first**: coda locale + Background URLSession

---

## Fase 3 — Piano Evolutivo

### 3a. Delta Analysis

#### PIPELINE DI ANALISI CONTENUTI

| Componente SoundReel | File | Verdetto | Motivazione |
|---------------------|------|----------|-------------|
| Content Extractor (oEmbed + OG scraping) | `functions/src/services/contentExtractor.ts` | **ESTESO** | La logica di estrazione metadata da URL (14 piattaforme, oEmbed, OG tags) e' riusabile. Va generalizzata: oggi estrae solo caption/thumbnail/audio per analisi musicale, Mneme deve estrarre testo completo, immagini, documenti. Da portare da TypeScript/Node a Python/FastAPI. |
| Instagram Private API client | `functions/src/services/contentExtractor.ts` (linee 50-180) | **ELIMINATO** | Logica fragile basata su session cookies con health check continuo. Mneme non ha bisogno di reverse-engineering Instagram — la Share Extension cattura il contenuto direttamente. |
| Cobalt.tools integration | `functions/src/services/contentExtractor.ts` | **ELIMINATO** | Servizio self-hosted su Cloud Run per estrazione video. Mneme non scarica video da piattaforme social — riceve contenuto dalla Share Extension o da URL generici. |
| Platform detection | `functions/src/services/contentExtractor.ts` (`detectPlatform()`) | **RIUTILIZZATO** | Mappa di 14 pattern URL→piattaforma. Utile come metadata `source` nel Memo. Conversione triviale TS→Python. |
| AI Analysis (Gemini) | `functions/src/services/aiAnalysis.ts` | **SOSTITUITO** | Oggi usa Gemini 2.0 Flash (SaaS). Mneme usa Ollama locale (llama3.1:8b). La struttura "assembla prompt + parse JSON response" e' riusabile come pattern, ma l'implementazione va riscritta per ollama SDK. I prompt Handlebars vanno ripensati per il modello locale (piu' piccolo, meno capace di istruzioni complesse). |
| Prompt Loader (Handlebars) | `functions/src/services/promptLoader.ts` | **ESTESO** | Sistema di templating con cache, CRUD via API, default hardcoded. Il pattern e' buono. Va esteso con prompt per summarization, tagging, embedding. Da TS a Python (Jinja2 al posto di Handlebars). |
| Audio Recognition (AudD) | `functions/src/services/audioRecognition.ts` | **ELIMINATO** | Servizio SaaS specifico per music fingerprinting. Mneme non ha questo use case — e' un knowledge vault, non un music analyzer. |
| Spotify Integration | `functions/src/services/spotify.ts` | **ELIMINATO** | OAuth PKCE, playlist management, track search. Specifico per SoundReel. Nessun equivalente in Mneme. |
| Film Search (TMDb) | `functions/src/services/filmSearch.ts` | **ELIMINATO** | Ricerca film e link streaming. Specifico per SoundReel. |
| Result Merger | `functions/src/services/resultMerger.ts` | **ELIMINATO** | Deduplica songs/films da audio+AI. Logica specifica per il dominio musicale/cinematografico. |
| OpenAI Enrichment | `functions/src/services/openaiEnrich.ts` | **ELIMINATO** | Usa GPT-4o-mini con web search. Mneme usa solo AI locale. |
| Gemini Client (dual mode) | `functions/src/services/geminiClient.ts` | **SOSTITUITO** | Wrapper per Google AI Studio + Vertex AI. Va sostituito con Ollama client. |
| Audio Transcription | `functions/src/services/transcribeAudio.ts` | **ESTESO** | Trascrizione speech-to-text via Gemini. Il concetto serve (Mneme riceve anche audio), ma va re-implementato con Whisper locale via Ollama o `faster-whisper`. |
| Media Downloader | `functions/src/services/mediaDownloader.ts` | **ESTESO** | Download con timeout e size limit. Pattern riusabile per Mneme quando riceve URL. Da TS a Python (`httpx`/`aiohttp`). |

#### DATA MODEL

| Componente SoundReel | File | Verdetto | Motivazione |
|---------------------|------|----------|-------------|
| Entry type | `functions/src/types/index.ts` | **SOSTITUITO** | `Entry` ha campi specifici (sourceUrl, sourcePlatform, songs, films). Mneme ha `Memo` con struttura completamente diversa (content_type, raw_url/text/file, collection_id, embedding). Nessun campo riusabile 1:1. |
| Song/Film/Note types | `functions/src/types/index.ts` | **ELIMINATO** | Tipi dominio-specifici. In Mneme tutto e' un Memo con tags e collections. |
| ActionLog pattern | `functions/src/types/index.ts` | **RIUTILIZZATO** | Il pattern di logging embedded nel documento (action, details, timestamp) e' un buon pattern di audit trail. Va adattato per PostgreSQL. |
| Firestore utils | `functions/src/utils/firestore.ts` | **SOSTITUITO** | Helper CRUD per Firestore. Va riscritto per SQLAlchemy/PostgreSQL. La struttura (find, create, update, appendLog) e' un buon reference per il repository pattern. |
| Feature flags | `functions/src/utils/firestore.ts` (`FeaturesConfig`) | **ESTESO** | 7 toggle in Firestore. Il pattern e' buono, va portato in PostgreSQL config table o environment variables. |

#### BACKEND INFRASTRUCTURE

| Componente SoundReel | File | Verdetto | Motivazione |
|---------------------|------|----------|-------------|
| Firebase Cloud Functions | `functions/src/index.ts` | **SOSTITUITO** | 13 HTTP functions serverless. Mneme usa FastAPI con routing tradizionale. La mappa delle route e' un buon reference per i FastAPI endpoints. |
| Firebase Hosting | `firebase.json` | **ELIMINATO** | Hosting statico per SPA React. Mneme e' un'app iOS con backend on-prem. |
| Cloud Firestore | `firestore.rules`, `firestore.indexes.json` | **SOSTITUITO** | NoSQL document store. Mneme usa PostgreSQL + pgvector. Schema completamente diverso. |
| Firebase Secret Manager | `scripts/set-secrets.sh` | **SOSTITUITO** | 7 secrets in GCP. Mneme usa `.env` locale o Vault su Mac Mini. Meno secrets necessari (no SaaS API keys tranne forse Telegram). |
| Deploy scripts | `scripts/*.sh` | **SOSTITUITO** | Firebase-specific. Mneme ha deploy diverso (Docker Compose o systemd su Mac Mini). |
| Version bumping | `scripts/bump-version.sh` | **RIUTILIZZATO** | Pattern di version bump su package.json + README badge. Adattabile per `pyproject.toml` + iOS `Info.plist`. |

#### FRONTEND / UI

| Componente SoundReel | File | Verdetto | Motivazione |
|---------------------|------|----------|-------------|
| React SPA intera | `frontend/src/` | **ESTESO** | La web UI resta come homepage di Mneme. Va adattata: sostituire Firebase SDK con chiamate API REST al backend FastAPI, aggiungere login JWT, nuovo data model Memo, tab Collections e Ask Mneme. L'UX master-detail, il console, i settings restano. |
| Design system CSS | `frontend/src/styles/index.css` | **RIUTILIZZATO** | Il design Apple-inspired con variabili CSS resta. Va esteso con componenti per Collections (tree view) e Ask Mneme (chat UI). |
| i18n system | `frontend/src/i18n/` | **ESTESO** | Il catalogo di 150+ chiavi IT/EN resta e va ampliato con le nuove sezioni (Collections, Ask Mneme, Auth). Per iOS: le chiavi vanno mappate anche su `Localizable.strings`. |
| Spotify OAuth PKCE | `frontend/src/services/spotify.ts` | **ELIMINATO** | Specifico per SoundReel. |

#### INTEGRAZIONI ESTERNE

| Componente SoundReel | File | Verdetto | Motivazione |
|---------------------|------|----------|-------------|
| Telegram Bot webhook | `functions/src/telegramWebhook.ts` | **ESTESO** | Il bot Telegram e' un canale di input per Mneme. Va adattato: oggi analizza URL, Mneme deve accettare qualsiasi contenuto (URL, testo, foto, file, audio) e creare un Memo pending. La struttura webhook + comandi (/start, /stats, /status) e' riusabile. Da TS a Python (`python-telegram-bot` o webhook FastAPI). |
| Telegram response template | `config/prompts.telegramResponse` | **ESTESO** | Template Handlebars per la risposta formattata. Va adattato per il formato Memo (non piu' songs/films). |
| Debug Logger | `functions/src/services/debugLogger.ts` | **ESTESO** | Classe Logger con log strutturati, sanitizzazione dati sensibili, fire-and-forget su Firestore. Pattern eccellente. Va portato su Python logging con output su PostgreSQL o file. |

#### NUOVO (non esiste in SoundReel)

| Componente Mneme | Motivazione |
|-----------------|-------------|
| **App iOS (SwiftUI)** | SoundReel non ha app nativa. Intero frontend da scrivere: 3 tab (Feed, Collections, Ask Mneme), NavigationStack, modelli SwiftData/CoreData per cache locale. |
| **Share Extension iOS** | Non esiste. Da creare: accetta URL, testo, immagini, file, audio. Comunica con app principale via App Group. |
| **PostgreSQL + pgvector** | SoundReel usa Firestore (NoSQL). Schema relazionale completamente nuovo: users, memos, collections, embeddings, sessions. |
| **FastAPI backend** | SoundReel usa Cloud Functions (serverless). Server persistente con async pipeline, background tasks, WebSocket per real-time. |
| **Ollama integration** | SoundReel usa Gemini (SaaS). Client Ollama per embedding (nomic-embed-text), summarization e RAG (llama3.1:8b). |
| **JWT auth system** | SoundReel non ha auth. Sistema completo: registrazione, login, token refresh, Keychain storage iOS, middleware FastAPI. |
| **Vector search / RAG** | SoundReel non ha search semantica. pgvector per similarita', retrieval pipeline, chat UI con citazioni. |
| **Offline-first sync** | SoundReel e' online-only. Coda locale iOS, conflict resolution, Background URLSession. |
| **Collections (albero 2 livelli)** | SoundReel non ha organizzazione. CRUD collections, drag-and-drop, nesting. |

---

### 3b. Rischi e vincoli

#### Rischi architetturali

1. **Cambio totale dello stack (rischio ALTO)**
   SoundReel e' TypeScript/Firebase/Firestore/React. Mneme e' Python/FastAPI/PostgreSQL/SwiftUI. Non e' un'evoluzione incrementale — e' una riscrittura con ispirazione concettuale. Il codice SoundReel non puo' essere portato direttamente; solo pattern e logiche possono essere riutilizzati.

2. **AI locale vs SaaS (rischio MEDIO-ALTO)**
   SoundReel usa Gemini 2.0 Flash che e' capace di istruzioni complesse, multimodale (immagini + audio + testo), e con context window enorme. `llama3.1:8b` su Mac Mini M4 e' significativamente meno capace. I prompt attuali (`contentAnalysis`, `mediaAnalysis`) producono JSON strutturato con 7+ campi — un modello 8B potrebbe non farcela con la stessa affidabilita'. **Mitigazione**: prompt piu' semplici, pipeline a step singoli (prima summarize, poi tag, poi embed), validation robusta dell'output.

3. **Offline-first sync e' complesso (rischio ALTO)**
   SoundReel e' online-only con Firestore real-time. Mneme richiede coda locale, conflict resolution, retry con backoff, Background URLSession. Questo e' uno dei pattern piu' difficili da implementare correttamente in iOS. **Mitigazione**: iniziare con sync semplice (POST al server, retry su failure) e aggiungere complessita' incrementalmente.

4. **Multi-utente richiede isolamento dati (rischio MEDIO)**
   SoundReel e' single-user senza auth. Mneme ha JWT + isolamento per famiglia. Ogni query deve filtrare per `user_id`. Un errore nel middleware auth espone i dati di altri utenti. **Mitigazione**: Row-Level Security (RLS) in PostgreSQL come safety net oltre al filtro applicativo.

5. **Mac Mini M4 come server (rischio MEDIO)**
   Nessuna ridondanza, nessun failover. Power outage = downtime. Backup richiede strategia esplicita. **Mitigazione**: pg_dump schedulato, UPS, Tailscale per accesso remoto.

#### Dipendenze hard-coded da rompere

- **Cobalt URL**: `https://cobalt-972218119922.europe-west1.run.app/` in `contentExtractor.ts:12` — non serve in Mneme
- **Firebase project ID**: `soundreel-776c1` in Vertex AI config (`geminiClient.ts`) — non serve
- **Spotify OAuth redirect**: hardcoded nel frontend e in Spotify Developer Dashboard — non serve
- **Instagram API App ID**: `936619743392459` in `contentExtractor.ts` — non serve
- **Frontend URL in Telegram response**: `https://soundreel-776c1.web.app/?entry=${entryId}` in `telegramWebhook.ts` — va sostituito con deep link all'app iOS

#### Debiti tecnici di SoundReel da NON portare in Mneme

- **Nessun test**: Mneme deve nascere con test dal giorno zero (almeno unit test per la pipeline AI e integration test per gli endpoint)
- **Firestore rules permissive** (`allow read: if true`): PostgreSQL RLS e' obbligatorio
- **`.env` in git**: secrets devono restare fuori dal repository
- **Nessun CI/CD**: Mneme deve avere almeno un GitHub Actions per build + test
- **Logging su collection separata**: in PostgreSQL va in tabella con foreign key, non fire-and-forget

---

### 3c. Ordine di esecuzione consigliato

#### Sprint 0 — Setup e fondamenta
**Cosa**: Creare il worktree `mneme`, inizializzare il progetto Python (FastAPI), configurare PostgreSQL + pgvector su Mac Mini M4, setup Docker Compose per dev locale.

**Deliverable**:
- `docker-compose.yml` con PostgreSQL 16 + pgvector + FastAPI
- Schema iniziale: tabelle `users`, `memos`, `collections`, `embeddings`
- Endpoint health check: `GET /health` -> 200
- Alembic migrations funzionanti
- Test: `pytest` con almeno un test che verifica la connessione DB

**Perche' prima**: tutto il resto dipende da DB e server funzionanti.

**Complessita'**: MEDIA (setup infrastrutturale, nessuna logica applicativa)

---

#### Sprint 1 — Auth JWT + modello Memo base
**Cosa**: Implementare JWT auth (registrazione, login, refresh token), CRUD base per Memo (create, read, list, update status), middleware auth su tutti gli endpoint.

**Deliverable**:
- `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`
- `POST /memos`, `GET /memos`, `GET /memos/{id}`, `PATCH /memos/{id}`
- JWT con expiry configurabile, refresh token rotation
- RLS su PostgreSQL per isolamento utenti
- Test: auth flow completo, CRUD memo, isolamento dati tra utenti

**Perche' dopo Sprint 0**: richiede DB funzionante. Tutto il resto richiede auth.

**Complessita'**: MEDIA (pattern JWT ben noto, ma RLS richiede attenzione)

---

#### Sprint 2 — Telegram Bot adattato
**Cosa**: Portare il bot Telegram da TS a Python. Adattare per Mneme: accetta URL, testo, foto, file, audio. Crea Memo `pending` nel DB. Comandi: `/start`, `/stats`, `/status`.

**Deliverable**:
- Webhook FastAPI per Telegram
- Handler per messaggi con URL, testo, media
- Creazione Memo con `status: pending` per ogni input
- Risposte conferma al mittente
- Auth: associazione chat_id -> user_id (setup iniziale)
- Test: mock webhook, verifica creazione memo

**Perche' dopo Sprint 1**: richiede auth + CRUD memo. Il Telegram bot e' il canale di input piu' immediato da testare (non serve app iOS).

**Complessita'**: BASSA (port diretto con adattamenti, pattern gia' rodato in SoundReel)

---

#### Sprint 3 — Pipeline AI asincrona (Ollama)
**Cosa**: Implementare la pipeline di processing asincrona: estrazione testo da URL → summarization → tagging → embedding. Tutto via Ollama locale.

**Deliverable**:
- Worker asincrono (Celery o `asyncio` task queue) che processa Memo pending
- Step 1: Content extraction (readability per URL, OCR per immagini, trascrizione per audio)
- Step 2: Summarization via llama3.1:8b
- Step 3: Auto-tagging via llama3.1:8b
- Step 4: Embedding via nomic-embed-text, salvato in pgvector
- Transizione stato: `pending` -> `synced` -> `indexed` (o `error`)
- Logging strutturato per ogni step (ispirato all'ActionLog di SoundReel)
- Test: pipeline completa con contenuto di test, verifica embedding nel DB

**Perche' dopo Sprint 2**: richiede Memo nel DB. E' il cuore di Mneme — tutto il valore e' qui.

**Complessita'**: ALTA (integrazione Ollama, prompt engineering per modello piccolo, gestione errori asincroni, pipeline multi-step)

---

#### Sprint 4 — Vector search + endpoint RAG
**Cosa**: Implementare ricerca semantica e endpoint per "Ask Mneme" (chat RAG con citazioni).

**Deliverable**:
- `POST /search` — ricerca semantica via pgvector (cosine similarity)
- `POST /ask` — query in linguaggio naturale, retrieval dei memo rilevanti, generazione risposta con llama3.1:8b, citazioni ai memo sorgente
- Paginazione risultati
- Filtri per collection, tag, content_type, date range
- Test: ricerca con memo noti, verifica rilevanza, verifica citazioni

**Perche' dopo Sprint 3**: richiede embeddings nel DB.

**Complessita'**: ALTA (RAG pipeline, prompt engineering per citazioni, tuning similarita')

---

#### Sprint 5 — Collections CRUD
**Cosa**: Implementare struttura ad albero (max 2 livelli) per organizzare i memo.

**Deliverable**:
- `POST /collections`, `GET /collections`, `PATCH /collections/{id}`, `DELETE /collections/{id}`
- Nesting: collection puo' avere parent_id (max 1 livello di profondita')
- `PATCH /memos/{id}` per assegnare/rimuovere collection
- Vincolo: collection appartiene a un utente (isolamento)
- Test: CRUD collection, nesting, assegnazione memo

**Perche' dopo Sprint 4**: non blocca nulla ma ha senso avere search funzionante prima di organizzare.

**Complessita'**: BASSA (CRUD standard con vincolo di profondita')

---

#### Sprint 6 — Frontend Web: adattamento a Mneme
**Cosa**: Evolvere la React SPA esistente per lavorare con il backend FastAPI. L'UX master-detail che piace resta, ma il data layer cambia completamente.

**Deliverable**:
- Sostituire `firebase` SDK con client API REST verso FastAPI (fetch + JWT bearer token)
- Login page con JWT (email + password)
- Token storage in localStorage/sessionStorage con refresh automatico
- Nuovo tipo `Memo` al posto di `Entry` nei componenti
- Home page: lista memo (CompactCard adattato) con master-detail inspector
- Filtri per content_type, status, tags, date range
- Shimmer effect per memo `pending` (come prima per `processing`)
- Settings page adattata: config utente, toggle pipeline features
- Console/logs: connessa al nuovo backend
- Rimuovere: Spotify OAuth, componenti SongItem/FilmItem specifici SoundReel
- Aggiungere: pagina Collections (tree view navigabile)
- Aggiungere: pagina Ask Mneme (chat UI con input, risposte, citazioni cliccabili)
- Test: almeno smoke test con Vitest per i nuovi service layer

**Perche' dopo Sprint 5**: richiede tutti gli endpoint backend + collections funzionanti.

**Complessita'**: MEDIA-ALTA (l'UI esiste gia', ma il data layer cambia tutto e servono 2 nuove pagine significative)

---

#### Sprint 7 — App iOS: progetto base + Feed tab
**Cosa**: Creare il progetto Xcode, configurare SwiftUI, implementare il primo tab (Feed) con lista memo e stato shimmer per pending.

**Deliverable**:
- Progetto Xcode con target app + target Share Extension (vuoto)
- Networking layer: `URLSession` con JWT auth, token refresh, error handling
- Modello `Memo` in SwiftUI/Codable
- Tab Feed: lista memo con pull-to-refresh, paginazione, filtri per tipo/stato
- Shimmer effect per memo in stato `pending`
- Login screen con JWT
- Keychain storage per token
- Test: unit test per networking layer e model decoding

**Perche' dopo Sprint 6**: richiede tutti gli endpoint backend funzionanti. Il frontend web fa da reference per l'UX.

**Complessita'**: ALTA (nuovo progetto iOS da zero, networking layer, auth flow)

---

#### Sprint 8 — App iOS: Collections tab + Ask Mneme tab
**Cosa**: Implementare gli altri due tab.

**Deliverable**:
- Tab Collections: albero navigabile, tap per vedere memo nella collection, create/edit/delete
- Tab Ask Mneme: chat UI, input testuale, risposta con citazioni tappabili ai memo sorgente
- NavigationStack per drill-down
- Test: UI test per navigazione base

**Perche' dopo Sprint 7**: richiede app base funzionante.

**Complessita'**: ALTA (chat UI, citazioni interattive, tree navigation)

---

#### Sprint 9 — Share Extension iOS
**Cosa**: Implementare la Share Extension che accetta qualsiasi contenuto.

**Deliverable**:
- Share Extension target con UTTypes: `public.url`, `public.plain-text`, `public.image`, `public.audio`, `public.data`
- App Group per comunicazione con app principale
- UI minimale: conferma di salvataggio, scelta collection opzionale
- Creazione Memo locale (coda offline) + sync al backend
- Test: share da Safari (URL), Note (testo), Foto (immagine)

**Perche' dopo Sprint 8**: richiede app e collections funzionanti.

**Complessita'**: MEDIA (Share Extension ha quirk noti, App Group setup, ma pattern ben documentato)

---

#### Sprint 10 — Offline-first sync
**Cosa**: Implementare coda locale per memo creati offline, sync automatico al ritorno della connessione.

**Deliverable**:
- SwiftData/CoreData locale come cache
- Coda operazioni pending (create memo, update collection)
- `NWPathMonitor` per rilevare connettivita'
- `Background URLSession` per sync in background
- Conflict resolution: last-write-wins (semplice) con log dei conflitti
- Test: crea memo offline, verifica sync quando torna online

**Perche' ultimo**: e' il layer piu' complesso e meno critico per un MVP. L'app funziona gia' online-only dopo Sprint 9.

**Complessita'**: ALTA (background sync iOS e' notoriamente difficile, conflict resolution)

---

### Riepilogo sprint

| Sprint | Deliverable | Complessita' | Dipendenze |
|--------|------------|-------------|------------|
| 0 | Infrastruttura (Docker, PostgreSQL, FastAPI) | MEDIA | Nessuna |
| 1 | Auth JWT + CRUD Memo | MEDIA | Sprint 0 |
| 2 | Telegram Bot (Python) | BASSA | Sprint 1 |
| 3 | Pipeline AI (Ollama) | ALTA | Sprint 1 |
| 4 | Vector search + RAG | ALTA | Sprint 3 |
| 5 | Collections CRUD | BASSA | Sprint 1 |
| 6 | Frontend Web: adattamento React SPA | MEDIA-ALTA | Sprint 1-5 |
| 7 | App iOS: base + Feed | ALTA | Sprint 1-5 |
| 8 | App iOS: Collections + Ask Mneme | ALTA | Sprint 7 |
| 9 | Share Extension | MEDIA | Sprint 8 |
| 10 | Offline-first sync | ALTA | Sprint 9 |

**Note sul parallelismo**: Sprint 2, 3, e 5 possono procedere in parallelo dopo Sprint 1. Sprint 4 dipende solo da Sprint 3. Sprint 6 e 7 possono procedere in parallelo appena Sprint 1-5 sono pronti (web e iOS sono client indipendenti).

---

### 3d. Invarianti da preservare

Queste sono le cose che **non devono cambiare** durante l'evoluzione, perche' rappresentano valore utente o comportamenti critici gia' validati in SoundReel:

1. **SoundReel cloud resta operativo su `main`**
   L'app attuale continua a funzionare. Il worktree Mneme non tocca il deploy Firebase. L'utente puo' continuare a usare SoundReel via web e Telegram durante tutto lo sviluppo di Mneme.

2. **Il bot Telegram non si interrompe**
   Durante la migrazione, il bot Telegram SoundReel resta attivo. Il nuovo bot Mneme usa un token diverso (nuovo bot via BotFather) per evitare conflitti. Quando Mneme e' pronto, si puo' switchare.

3. **Pattern di resilienza della pipeline**
   SoundReel ha una pipeline dove ogni step e' indipendente: se uno fallisce, gli altri continuano. Questo pattern DEVE essere preservato in Mneme. Se Ollama non riesce a fare il summary, l'embedding viene comunque tentato. Se l'embedding fallisce, il memo resta con stato `synced` (non `indexed`) ma non si perde.

4. **Logging dettagliato di ogni azione**
   L'`actionLog` embedded nell'entry SoundReel traccia ogni step con timestamp, durata, costo. Mneme deve avere lo stesso livello di osservabilita' sulla pipeline di processing.

5. **Idempotenza**
   SoundReel controlla `sourceUrl` prima di riprocessare. Mneme deve fare lo stesso: se un URL e' gia' stato salvato, non creare duplicati (a meno di flag esplicito).

6. **Feature flags**
   SoundReel ha 7 toggle per attivare/disattivare funzionalita' senza redeploy. Mneme deve mantenere questa flessibilita' (es. toggle per embedding, summarization, transcription).

7. **Dati SoundReel migrabili**
   Al termine dello sviluppo, deve essere possibile migrare le entry SoundReel esistenti in Mneme come Memo. Il mapping e': Entry → Memo con `content_type: 'social_url'`, `source: sourcePlatform`, `raw_url: sourceUrl`, `summary: results.summary`, `tags: results.tags`. Canzoni, film e note diventano parte del campo `raw_text` o note del memo. Questo va pianificato ma eseguito solo alla fine.

---

## Appendice — Strategia worktree

```bash
# Da /Users/mike/work/Soundreel (main = SoundReel cloud, resta intatto)
git worktree add ../Mneme mneme

# Il branch 'mneme' diverge da main e contiene:
# - Nuovo backend Python in /backend/
# - Nuovo progetto iOS in /ios/
# - Prompt e config adattati in /prompts/
# - Docker Compose per dev locale
# - Il frontend/ React puo' essere rimosso o ignorato

# SoundReel cloud continua a deployarsi da main
# Mneme si sviluppa indipendentemente su mneme branch
```

La struttura del worktree Mneme sara':

```
Mneme/
├── backend/
│   ├── app/
│   │   ├── main.py           # FastAPI app
│   │   ├── auth/             # JWT auth
│   │   ├── api/              # Route handlers
│   │   ├── models/           # SQLAlchemy models
│   │   ├── services/         # Pipeline, Ollama, embedding
│   │   ├── schemas/          # Pydantic schemas
│   │   └── utils/            # Logger, config
│   ├── alembic/              # DB migrations
│   ├── tests/
│   ├── pyproject.toml
│   └── Dockerfile
├── frontend/                 # React SPA evoluta da SoundReel
│   ├── src/
│   │   ├── components/       # CompactCard, EntryInspector -> MemoInspector, etc.
│   │   ├── pages/            # Home, Collections (NEW), AskMneme (NEW), Settings, Console
│   │   ├── services/         # api.ts (REST verso FastAPI), auth.ts (JWT)
│   │   ├── hooks/            # useJournal -> useMemos, useAuth (NEW)
│   │   ├── types/            # Memo, Collection, User (nuovi tipi)
│   │   ├── i18n/             # Esteso con nuove chiavi
│   │   └── styles/           # CSS mantenuto + nuovi componenti
│   ├── package.json
│   └── vite.config.ts
├── ios/
│   ├── Mneme/                # App target
│   ├── MnemeShare/           # Share Extension target
│   └── Mneme.xcodeproj
├── docker-compose.yml        # PostgreSQL + pgvector + FastAPI + frontend dev
├── prompts/                  # Template per AI (portati da SoundReel)
├── scripts/
│   ├── setup.sh
│   └── deploy.sh
└── CLAUDE.md                 # Aggiornato per Mneme
```
