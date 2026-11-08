# Player Hub — B+A + Reader TTS

Data: 2026-11-05  
Stato: **scelte di prodotto congelate in bozza** — ancora nessuna modifica a `/player` di produzione  
Board: `/designs/player-hub/`

## Decisioni (tue)

1. **Shell B + superfici A** — Tesla apre sull’hub a ripiani (*Continua*); il tap apre Ascolta / Leggi / Esplora.
2. **Reader = TTS online** — il client **non** sintetizza voce; il rendering audio è **delegato a un servizio**. Il player ripoduce stream/file e memorizza posizione (pausa / ripresa), come per la musica.

## Architettura UX congelata

```
/player (futuro hub)
├── Shell B — ripiani Continua | Musica | Libri | Prodotti | Film
└── Superficie A — chrome Tesla fisso
    ├── Ascolta  → coda sticky YouTube (oggi)
    ├── Leggi    → audiobook TTS (servizio) + progress
    └── Esplora  → scheda prodotto + chips Grok
```

Flusso Tesla tipico: apri hub → **Continua** (libro al 42% o brano in coda) → un tap → superficie già nel mode giusto.

## Reader TTS — modello

### Cosa fa il client (Tesla / browser)

- Mostra copertina, titolo, capitolo, barra progresso.
- Controlli grandi: ⏸ / ▶ / −15s / +30s (stesso linguaggio di Ascolta).
- Persiste `position` (secondo audio o locator capitolo+offset).
- **Non** chiama Web Speech API; **non** fa TTS in-browser.

### Cosa fa il servizio TTS

- Input: `bookKey` + `chapterId` (o range di testo) + `voice` + `lang`.
- Output: audio (mp3/opus) **cacheable** + metadati (`durationSec`, opz. word/sentence marks).
- Idempotente: stesso pezzo → stesso file in cache (hash testo+voice).

### Flusso

1. Utente apre libro da Continua / ripiano Libri.
2. Backend risolve testo capitolo (da ingest PDF/EPUB/md — spec 2026-08-25 — o file locale).
3. Se manca audio in cache → enqueue job TTS sul servizio → quando pronto, URL `/media/.../ch04.mp3` (o stream).
4. Client fa play sull’URL; progresso in `reading_progress` (o `listen_progress`).
5. Pausa / chiusura / crash → ripresa dallo stesso offset.

### Perché “servizio” e non on-device

- Tesla browser: TTS locale inaffidabile, voci scarse, niente cache condivisa casa/auto.
- Stesso capitolo renderizzato una volta, ascoltato ovunque.
- Allinea il mode Leggi al mode Ascolta (entrambi = **play di media**).

## Backend TTS — decisione Geeko (2026-11-07)

Inbox: `geekom-hub/inbox/2026-11-07-soundreel-tts-spike.md`

**A — `edge-tts-adapter` Docker su rete `web`.** B rimandata (gpu-router quando c’è motore locale). C scartata (systemd host).

Due livelli:

1. **Motore (hub):** `POST /v1/audio/speech` OpenAI-compat → `audio/mpeg` (+ `X-Duration-Sec`). URL `http://edge-tts-adapter:8080` (`TTS_URL`). Nessun Traefik.
2. **Render (SoundReel):** `POST /api/tts/render` + jobs + cache hash in `/data/media/tts/<hash>.mp3`.

**Privacy:** edge-tts manda il testo ai server Microsoft. Ok per spike/demo. Per documenti personali in prod serve via esplicito (alternativa futura: mlx-audio su vulcano via router).

Voci: `it-IT-DiegoNeural` (default), fallback `it-IT-ElsaNeural`.  
Chunk ~450 parole ≈ 3 min; timeout motore 60s dentro job async SoundReel.

Scaffold adapter: Geeko **aspetta il via** prima di creare `geekom-hub/edge-tts-adapter/`.

### Contratto render SoundReel (non ancora implementato)

```
POST /api/tts/render
{ "bookKey", "chapterId", "text"?, "voice"? }
→ { "status": "ready"|"pending"|"error", "audioUrl"?, "durationSec"?, "jobId"? }

GET  /api/tts/jobs/:id
GET/PUT /api/reading-progress/:itemKey
```

## Gap contenuti (invariato, bloccante per Leggi vero)

Senza testo capitolo (PDF/EPUB/md ingerito) il TTS non ha input.  
v1 demo: libro fixture + capitoli testo. v1 reale: ingest documenti.

## Prototipi / spike

| Path | Stato |
|------|--------|
| `/designs/player-hub/` | Board B+A |
| `/designs/player-hub/reader-tts.html` | **Spike:** play `demo-ch04.mp3` (edge-tts reale) + progress |
| `/designs/player-hub/demo-ch04.mp3` | ~30s, DiegoNeural |
| `/designs/player-hub/explore.html` | Scheda + Grok chips |
| `/designs/player-hub/SPIKE.md` | note spike |

Niente wiring su `/player` di produzione.

## Non obiettivi (restano)

- Deploy hub/TTS in produzione in questa fase.
- Sostituire il player musica attuale.
- Evidenziazione parola-per-parola obbligatoria in v1.

## Prossimi passi

1. ~~B+A + reader TTS servizio~~
2. ~~Chiedere a Geeko~~ → A adapter; scaffold in attesa via
3. **Via a Geeko** per creare `edge-tts-adapter`? (sì/no + ok privacy Microsoft per demo)
4. Poi: SoundReel `TTS_URL` + `/api/tts/render` in worktree, ancora fuori da `/player` prod
