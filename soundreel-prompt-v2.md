# Prompt: SoundReel — Social Music & Film Extractor

## Contesto

Devo costruire una web app personale (single user) chiamata **"SoundReel"** che fa questo:

1. Ricevo contenuti social (Reels Instagram, TikTok, post) tramite **Telegram bot** o **incollando un link nel frontend web**
2. L'app **analizza il contenuto** per identificare **canzoni** (artista, album, titolo) e **film** (titolo, regista) menzionati o presenti nel video
3. Le canzoni identificate vengono **cercate su Spotify** e **aggiunte automaticamente a una playlist catchall**
4. I film identificati vengono **loggati con link IMDb**
5. Tutto viene registrato in un **journal cronologico** visibile nel frontend

---

## Architettura

### Stack tecnologico

| Layer | Tecnologia | Note |
|-------|-----------|------|
| Frontend | **React + Vite + TypeScript** | SPA pura, no framework SSR |
| Hosting frontend | **Firebase Hosting** | File statici, free tier |
| Backend/API | **Firebase Cloud Functions (2nd gen, Node.js)** | Serverless, free tier 125K invocazioni/mese |
| Database | **Cloud Firestore** | Document DB, una collection, un documento per entry |
| AI Analysis | **Gemini (via Vertex AI o Google AI Studio)** | Gemini Flash, free tier 15 RPM |
| Music Recognition | **AudD** (https://audd.io) | Audio fingerprinting, free tier 1000 req/mese |
| Film DB | **TMDb API** (https://themoviedb.org) | Free, genera link IMDb |
| Spotify | **Spotify Web API** | OAuth 2.0 PKCE, playlist management |
| Telegram | **Telegram Bot API** | Webhook su Cloud Function |
| Logging infrastrutturale | **Cloud Logging** | Automatico con Cloud Functions, gratis |

**Principio: tutto Google, tutto serverless, tutto free tier.** L'unica roba esterna a Google è AudD (music recognition), TMDb (film), Spotify e Telegram — per ovvi motivi.

---

### Canali di input

1. **Telegram Bot**: condivido un link da qualsiasi app social → Telegram → bot riceve il messaggio → avvia pipeline → risponde con riepilogo
2. **Web Frontend**: campo input dove incollare un URL → stessa pipeline

---

### Data Model — Firestore

**Una sola collection: `entries`**

Ogni documento è una entry processata. Struttura:

```json
{
  "id": "auto-generated",
  "sourceUrl": "https://www.instagram.com/reel/abc123",
  "sourcePlatform": "instagram",
  "inputChannel": "telegram",
  "caption": "Che scena pazzesca in Interstellar, con Stay di Hans Zimmer...",
  "thumbnailUrl": "https://...",
  "status": "completed",
  "results": {
    "songs": [
      {
        "title": "Stay",
        "artist": "Hans Zimmer",
        "album": "Interstellar OST",
        "source": "both",
        "spotifyUri": "spotify:track:xxx",
        "spotifyUrl": "https://open.spotify.com/track/xxx",
        "youtubeUrl": "https://youtube.com/results?search_query=Hans+Zimmer+Stay",
        "addedToPlaylist": true
      }
    ],
    "films": [
      {
        "title": "Interstellar",
        "director": "Christopher Nolan",
        "year": "2014",
        "imdbUrl": "https://www.imdb.com/title/tt0816692/",
        "posterUrl": "https://image.tmdb.org/..."
      }
    ]
  },
  "actionLog": [
    { "action": "url_received", "details": { "channel": "telegram" }, "timestamp": "2025-01-31T10:00:00Z" },
    { "action": "content_extracted", "details": { "hasAudio": true, "hasCaption": true }, "timestamp": "2025-01-31T10:00:02Z" },
    { "action": "audio_analyzed", "details": { "provider": "audd", "found": true }, "timestamp": "2025-01-31T10:00:05Z" },
    { "action": "ai_analyzed", "details": { "provider": "gemini", "songs": 1, "films": 1 }, "timestamp": "2025-01-31T10:00:07Z" },
    { "action": "spotify_added", "details": { "track": "Stay", "playlist": "SoundReel Catchall" }, "timestamp": "2025-01-31T10:00:09Z" },
    { "action": "film_found", "details": { "title": "Interstellar", "provider": "tmdb" }, "timestamp": "2025-01-31T10:00:10Z" },
    { "action": "completed", "details": {}, "timestamp": "2025-01-31T10:00:10Z" }
  ],
  "createdAt": "2025-01-31T10:00:00Z"
}
```

**Idempotenza**: prima di processare, cercare `sourceUrl` in Firestore. Se esiste già, restituire i risultati esistenti senza riprocessare.

**Query principali**:
- Journal: `orderBy('createdAt', 'desc').limit(50)`
- Solo canzoni: filtrare lato client su `results.songs.length > 0` (per volumi personali è efficiente)
- Solo film: idem su `results.films`

---

### Pipeline di analisi

Implementare come **una Cloud Function principale** (`analyzeUrl`) chiamata sia dal webhook Telegram che dall'endpoint web.

```
Input: URL
  │
  ├─ Step 1: CHECK IDEMPOTENZA
  │   → cerca sourceUrl in Firestore
  │   → se esiste, return risultati esistenti
  │
  ├─ Step 2: CREA ENTRY in Firestore (status: "processing")
  │   → log action: "url_received"
  │
  ├─ Step 3: ESTRAI CONTENUTO dal link
  │   → cobalt.tools API per scaricare video/audio
  │   → fallback: scraping meta tag OpenGraph per caption + thumbnail
  │   → log action: "content_extracted"
  │
  ├─ Step 4: RICONOSCIMENTO AUDIO (parallelo con Step 5)
  │   → invia audio a AudD API
  │   → output: { title, artist, album } o null
  │   → log action: "audio_analyzed"
  │
  ├─ Step 5: ANALISI AI (parallelo con Step 4)
  │   → invia caption + thumbnail a Gemini Flash
  │   → prompt (vedi sotto)
  │   → output: { songs: [...], films: [...] }
  │   → log action: "ai_analyzed"
  │
  ├─ Step 6: MERGE RISULTATI
  │   → unisci Step 4 + Step 5
  │   → deduplica per title+artist (canzoni) e title (film)
  │   → marca "source": "audio_fingerprint" | "ai_analysis" | "both"
  │
  ├─ Step 7: SPOTIFY (per ogni canzone)
  │   → cerca su Spotify Web API (/v1/search)
  │   → se trovata, aggiungi a playlist catchall (/v1/playlists/{id}/tracks)
  │   → genera YouTube search link
  │   → log action: "spotify_added" per ogni traccia
  │
  ├─ Step 8: FILM DB (per ogni film)
  │   → cerca su TMDb API (/3/search/movie)
  │   → estrai IMDb link e poster
  │   → log action: "film_found" per ogni film
  │
  └─ Step 9: AGGIORNA ENTRY in Firestore
      → salva results, aggiorna status: "completed"
      → log action: "completed"
```

**Step 4 e 5 devono essere eseguiti in parallelo** (`Promise.all`) per ridurre latenza.

Se qualsiasi step fallisce, loggare l'errore nell'actionLog e proseguire con gli step successivi. La pipeline è resiliente: se l'audio non si estrae, l'AI analizza solo la caption. Se AudD non trova nulla, si usa solo il risultato AI.

---

### Prompt Gemini per analisi contenuto

```
Analizza questo contenuto proveniente da un post social e identifica tutte le menzioni di canzoni e film/serie TV.

Per le CANZONI cerca: musica in sottofondo, canzoni citate nel testo, artisti menzionati, album o tracce specifiche.
Per i FILM/SERIE cerca: titoli di film o serie TV, scene o citazioni riconoscibili, registi o attori menzionati.

Caption del post:
"{caption}"

{Se disponibile: [thumbnail del post allegata come immagine]}

Rispondi ESCLUSIVAMENTE con JSON valido, senza markdown, senza commenti, senza altro testo:
{
  "songs": [
    { "title": "nome canzone", "artist": "artista", "album": "album o null" }
  ],
  "films": [
    { "title": "titolo", "director": "regista o null", "year": "anno o null" }
  ]
}

Se non trovi nulla, rispondi: { "songs": [], "films": [] }
```

---

### Cloud Functions

Tutte le Cloud Functions sono 2nd gen (basate su Cloud Run), Node.js 20, TypeScript.

```
functions/
├── src/
│   ├── index.ts                 # export di tutte le functions
│   ├── analyzeUrl.ts            # pipeline principale (HTTPS callable)
│   ├── telegramWebhook.ts       # webhook handler Telegram (HTTPS trigger)
│   ├── services/
│   │   ├── contentExtractor.ts  # estrazione video/caption da URL (cobalt + OG scraping)
│   │   ├── audioRecognition.ts  # AudD integration
│   │   ├── aiAnalysis.ts        # Gemini integration
│   │   ├── spotify.ts           # Spotify search + playlist add + OAuth token refresh
│   │   ├── filmSearch.ts        # TMDb integration
│   │   └── resultMerger.ts      # merge + deduplica risultati
│   └── utils/
│       ├── firestore.ts         # helper Firestore (get, save, update entry)
│       └── logger.ts            # wrapper per action log
```

**Endpoint esposti:**
- `POST /analyzeUrl` — riceve `{ url: string }`, avvia pipeline, ritorna entry completa
- `POST /telegramWebhook` — riceve update Telegram, estrae URL dal messaggio, chiama `analyzeUrl`

---

### Frontend React + Vite

SPA con queste pagine/sezioni (React Router):

#### Pagina principale `/`

Layout semplice, dark mode:

1. **Header**: nome app "SoundReel", contatori (totale entries, canzoni, film)
2. **Input bar**: campo URL + bottone "Analizza". Durante il processing mostra uno spinner e aggiorna il journal in tempo reale (Firestore onSnapshot listener)
3. **Journal**: lista di card, ordine cronologico decrescente. Ogni card mostra:
   - Icona piattaforma (Instagram/TikTok/altro) + data + canale input (🤖 Telegram / 🌐 Web)
   - Caption (prime 2 righe, espandibile)
   - Sezione canzoni: per ognuna → titolo — artista — album, icone cliccabili 🟢 Spotify 🔴 YouTube, badge ✓ se aggiunta alla playlist
   - Sezione film: per ognuno → titolo — regista — anno, link IMDb
   - Accordion "Dettagli pipeline" che mostra l'actionLog step-by-step con timestamp

#### Pagina settings `/settings`

- **Spotify**: bottone per collegare account (OAuth PKCE flow), stato connessione, nome playlist attiva
- **Info**: contatori, link alla playlist Spotify

#### Struttura progetto frontend

```
src/
├── main.tsx
├── App.tsx                # Router + layout
├── components/
│   ├── Header.tsx         # nome app + stats
│   ├── UrlInput.tsx       # campo input + bottone analizza
│   ├── Journal.tsx        # lista entry
│   ├── EntryCard.tsx      # singola entry con songs/films/log
│   ├── SongItem.tsx       # riga canzone con link Spotify/YouTube
│   ├── FilmItem.tsx       # riga film con link IMDb
│   └── ActionLog.tsx      # accordion pipeline log
├── pages/
│   ├── Home.tsx
│   └── Settings.tsx
├── services/
│   ├── firebase.ts        # init Firebase app + Firestore
│   ├── api.ts             # chiamate a Cloud Functions
│   └── spotify.ts         # OAuth flow helper
├── hooks/
│   ├── useJournal.ts      # onSnapshot listener Firestore
│   └── useAnalyze.ts      # trigger analisi + stato loading
└── styles/
    └── index.css          # dark mode base, minimal CSS
```

**Styling**: CSS semplice o Tailwind CSS (se si vuole utility-first). No component library, no Material UI. Design scuro, funzionale, minimal.

---

### Telegram Bot

- Creare bot con @BotFather, ottenere token
- Registrare webhook: `https://us-central1-{project}.cloudfunctions.net/telegramWebhook`
- Il bot gestisce:
  - **Messaggio con URL**: estrae il primo URL dal testo, chiama `analyzeUrl`, risponde con:
    ```
    🎵 SoundReel ha analizzato il tuo link!

    🎶 Canzoni trovate:
    • Stay — Hans Zimmer (Interstellar OST) ✓ Aggiunta alla playlist

    🎬 Film trovati:
    • Interstellar (2014) — Christopher Nolan

    📋 Dettagli: {link al frontend}
    ```
  - **`/status`**: ultima entry processata
  - **`/stats`**: totale entries, canzoni, film
  - **Messaggio senza URL**: risponde "Inviami un link da Instagram, TikTok o qualsiasi post social e lo analizzo per te!"

---

### Configurazione Spotify

**OAuth 2.0 Authorization Code Flow con PKCE** (il flow giusto per SPA):

1. L'utente va su `/settings`, clicca "Collega Spotify"
2. Redirect a Spotify authorize con scope: `playlist-modify-public playlist-modify-private`
3. Callback su `/settings?code=xxx`
4. Il frontend scambia il code per access_token + refresh_token
5. I token vengono salvati in Firestore: `config/spotify` document
6. Le Cloud Functions leggono il token da Firestore, refreshano se scaduto

**Playlist**: al primo collegamento, la Cloud Function crea una playlist "SoundReel" se non esiste, e salva il playlist_id nel documento config.

---

### Environment Variables / Secrets

Usare **Firebase Environment Configuration** o **Secret Manager** per:

```
# Firebase (automatico)
# Non serve configurare, il SDK Firebase Admin si autentica da solo nelle Cloud Functions

# Telegram
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_WEBHOOK_SECRET=xxx

# Spotify
SPOTIFY_CLIENT_ID=xxx
SPOTIFY_CLIENT_SECRET=xxx

# Music Recognition
AUDD_API_KEY=xxx

# Film DB
TMDB_API_KEY=xxx

# Gemini (se via Google AI Studio, serve API key. Se via Vertex AI, l'auth è automatica)
GEMINI_API_KEY=xxx
```

---

## Requisiti non funzionali

- **Zero infrastruttura**: tutto Firebase/GCP, tutto serverless, tutto free tier
- **Costi stimati**: 0€/mese per uso personale (poche decine di analisi al giorno)
- **Single user**: proteggere gli endpoint con un semplice secret token negli header. Le Cloud Functions verificano il token prima di processare. Il webhook Telegram è protetto dal secret nel URL.
- **Resilienza**: ogni step della pipeline è indipendente. Se uno fallisce, gli altri continuano. Tutto loggato nell'actionLog.
- **Idempotenza**: stesso URL → stessi risultati, nessun riprocessamento
- **Real-time**: il frontend usa Firestore `onSnapshot` per aggiornare il journal in tempo reale quando una entry viene processata

---

## Piano di implementazione

### Fase 1 — Setup e fondamenta
1. Creare progetto Firebase (`firebase init` con Hosting, Functions, Firestore)
2. Setup frontend React + Vite + TypeScript
3. Pagina base con header e journal vuoto
4. Deploy iniziale su Firebase Hosting

### Fase 2 — Pipeline core
5. Cloud Function `analyzeUrl` con struttura pipeline (inizialmente solo Step 1-2-9: ricevi URL, crea entry, segna completed)
6. Estrazione contenuto: integrare cobalt.tools per download + OG meta scraping come fallback
7. Integrazione AudD per riconoscimento audio
8. Integrazione Gemini per analisi caption + thumbnail
9. Result merger con deduplica
10. Salvataggio completo in Firestore

### Fase 3 — Integrazioni esterne
11. Spotify: OAuth flow nella pagina settings
12. Spotify: ricerca tracce + aggiunta automatica a playlist
13. TMDb: ricerca film + link IMDb
14. YouTube: generazione link di ricerca per ogni canzone

### Fase 4 — Telegram
15. Cloud Function webhook Telegram
16. Parsing messaggi, estrazione URL, chiamata pipeline
17. Risposta formattata al bot
18. Comandi /status e /stats

### Fase 5 — Frontend completo
19. Journal con EntryCard completa (songs, films, action log)
20. Real-time update con onSnapshot
21. Loading states e error handling nel UI
22. Dark mode, responsive, design minimale

### Fase 6 — Polish
23. Error handling robusto su tutta la pipeline
24. Retry logic per API esterne (Spotify, AudD, TMDb)
25. Rate limiting awareness (non superare free tier)
26. README con istruzioni setup

---

## Note importanti per lo sviluppo

1. **Estrazione video da Instagram**: cobalt.tools è la migliore opzione gratuita ma può rompersi. Implementare SEMPRE il fallback su OG meta scraping (caption + thumbnail). Per molti Reels, la caption da sola è sufficiente per l'analisi AI.

2. **YouTube links**: non usare YouTube Data API (quota limitata e complessa). Generare semplicemente `https://youtube.com/results?search_query={encodeURIComponent(artist + " " + title)}`. Pragmatico e funziona sempre.

3. **Timeout Cloud Functions**: la pipeline completa può richiedere 15-30 secondi. Configurare il timeout delle Cloud Functions a 60s minimo. Per l'endpoint web, restituire immediatamente l'ID della entry e usare onSnapshot per gli aggiornamenti real-time. Per Telegram, il webhook può rispondere dopo il processing (Telegram tollera fino a 60s).

4. **Token Spotify**: l'access token scade dopo 1 ora. Prima di ogni operazione Spotify, la Cloud Function deve verificare se il token è scaduto e refresharlo se necessario. Salvare il nuovo token in Firestore.

5. **Gemini multimodale**: se si ha la thumbnail del post, inviarla insieme alla caption a Gemini. L'analisi visiva può catturare informazioni non presenti nel testo (es. copertina di un album visibile nell'immagine, locandina di un film).
