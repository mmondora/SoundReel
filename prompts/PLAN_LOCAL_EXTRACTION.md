# PLAN — Estrazione + analisi 100% locale (Instagram only)

**Versione:** 1.0
**Data:** 2026-04-22
**Branch target:** `local-port` (cutover diretto, niente feature flag)
**Scope:** Solo Instagram. Altre piattaforme restano su path legacy invariato.

---

## 1. Obiettivo

Rimuovere tutti i servizi cloud dalla pipeline di estrazione e analisi per contenuti Instagram. Mantenere TMDb (film lookup cloud read-only) e Spotify (output playlist).

### Tool rimossi (per path Instagram)
- **AudD** (`audioRecognition.ts`) — fingerprint audio cloud
- **cobalt.tools** — extract media cloud
- **oEmbed endpoints** — metadata cloud
- **OG scraping** — fallback scraping
- **Instagram private API via cookies** (`fetchInstagramApi`) — path datacenter-IP blocked

### Tool nuovi (locali)
- **Whisper container** — ASR voce → transcript
- **OCR container** — Tesseract su frame video + slide carosello
- **ffmpeg** (embedded in sidecar Instaloader) — audio extract + frame sampling
- **Ollama vision (moondream, già in hub)** — descrizione visiva frame chiave

### Tool mantenuti
- **Instaloader** (esistente, esteso) — primary extractor IG, scarica media locale
- **Ollama text (qwen2.5:3b, già in hub)** — analisi testuale finale
- **TMDb** — film lookup (cloud read-only, invariato)
- **Spotify** — playlist output (cloud, invariato)

### Music identification
Solo `musicInfo` da Instaloader (`clips_music_attribution_info`). Nessun fingerprint, nessun fallback LLM su lyrics. Se metadata IG mancante → song non rilevata (accettato dal committente).

---

## 2. Architettura target

### Container topology

```
soundreel             Fastify backend
soundreel-db          Postgres 17
soundreel-instaloader sidecar: download IG + ffmpeg (audio extract + frame sample)
soundreel-whisper     NUOVO: ASR voce locale
soundreel-ocr         NUOVO: Tesseract OCR
ollama                ESISTE (hub): qwen2.5:3b text + moondream vision
```

### Volume condiviso

Nome: `soundreel_media` (bind mount namespaced per entry)

Mount su: `soundreel` (read), `soundreel-instaloader` (read+write), `soundreel-whisper` (read), `soundreel-ocr` (read).

Layout per entry:
```
/data/media/<entryId>/
  ├── video.mp4              (se reel/post video)
  ├── audio.wav              (16kHz mono, estratto da video)
  ├── frame-001.jpg          (ogni 2s)
  ├── frame-002.jpg
  ├── …
  ├── slide-001.jpg          (se carosello)
  ├── slide-002.jpg
  └── thumbnail.jpg
```

Cleanup: job cron container Postgres che elimina directory `<entryId>` dopo 7 giorni da `completed_at` (oppure cleanup inline a fine pipeline — decisione implementazione).

### Network

Tutti i nuovi container su network `default` (interno compose). `soundreel-whisper` e `soundreel-ocr` **non** esposti via Traefik (no router in `routers.yml`).

---

## 3. Nuova pipeline (IG only)

```
URL Instagram
  │
  ▼
POST soundreel-instaloader /download?url=...&entryId=...
  ├── instaloader scarica video.mp4 + slide*.jpg
  ├── ffmpeg estrae audio.wav da video.mp4
  ├── ffmpeg sample frames (1 ogni 2s) → frame-*.jpg
  └── restituisce JSON: {caption, musicInfo, videoPath, audioPath, thumbnailPath, slidePaths[], framePaths[]}
  │
  ▼
POST soundreel-whisper /asr (file audio.wav)
  └── transcript + lingua
  │
  ▼
POST soundreel-ocr /ocr (framePaths + slidePaths)
  └── {frames: [{ts, text}], slides: [{idx, text}], merged_text}
  │
  ▼
Ollama vision (moondream) su N frame chiave (es. 3-5 selezionati)
  └── visualContext string
  │
  ▼
Ollama text (qwen2.5:3b) call UNICA con prompt multimodale consolidato
  Input: caption + musicInfo + transcript + ocr_merged + visualContext + lingua
  Output: {songs, films, notes, links, tags, summary, transcription, overlayText}
  │
  ▼
Merge: musicInfo IG prevale su songs LLM (se presente)
  │
  ▼
Spotify search + playlist add
TMDb film search
  │
  ▼
persist Entry
```

---

## 4. Cambi container

### 4.1 `instaloader/` — estendere sidecar

**File modificati:**

- `instaloader/requirements.txt`
  - Aggiungi: (nessuno, ffmpeg è binary)

- `instaloader/Dockerfile`
  - Installa `ffmpeg` via apt:
    ```dockerfile
    RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
        && rm -rf /var/lib/apt/lists/*
    ```
  - `VOLUME /data/media`

- `instaloader/app.py`
  - Nuovo endpoint `POST /download`:
    - Body: `{url, entryId}`
    - Crea `/data/media/<entryId>/`
    - Usa `instaloader.Instaloader(download_videos=True, download_pictures=True, dirname_pattern='/data/media/{entryId}')` oppure scarica manualmente da `post.video_url` / `post.get_sidecar_nodes()`
    - Se video: `subprocess.run(['ffmpeg', '-i', video_path, '-vn', '-ac', '1', '-ar', '16000', audio_wav])`
    - Sample frame: `ffmpeg -i video.mp4 -vf fps=1/2 /data/media/<entryId>/frame-%03d.jpg`
    - Ritorna path **relativi al volume condiviso** (stesso path montato in backend)
  - Mantieni `/fetch` per retro-compat (deprecato, legacy path)
  - Health `/health` invariato

**Docker compose:**

```yaml
soundreel-instaloader:
  # … esistente …
  volumes:
    - soundreel_instaloader_session:/root/.config/instaloader
    - soundreel_media:/data/media        # NUOVO
```

### 4.2 `soundreel-whisper/` — NUOVO container

**Opzione scelta:** `onerahmet/openai-whisper-asr-webservice` (immagine pubblica, GPU opzionale, CPU fallback).

**Docker compose (aggiungere):**

```yaml
soundreel-whisper:
  image: onerahmet/openai-whisper-asr-webservice:latest
  container_name: soundreel-whisper
  environment:
    ASR_MODEL: small           # ~500MB, IT/EN OK
    ASR_ENGINE: faster_whisper # 3-5x più veloce di openai-whisper
  volumes:
    - soundreel_media:/data/media:ro
    - soundreel_whisper_models:/root/.cache/whisper  # cache modello
  networks: [default]
  restart: unless-stopped
```

**API:** `POST /asr?task=transcribe&encode=true&output=json` con file multipart. Ritorna `{text, segments, language}`.

**Volume nuovo:** `soundreel_whisper_models` (cache modelli).

### 4.3 `soundreel-ocr/` — NUOVO container

**Custom sidecar Python.**

**File nuovi:**

- `ocr/app.py`
  ```python
  from flask import Flask, request, jsonify
  from PIL import Image
  import pytesseract, os, logging

  app = Flask(__name__)

  @app.post('/ocr')
  def ocr():
      payload = request.get_json() or {}
      paths = payload.get('paths', [])
      lang = payload.get('lang', 'ita+eng')
      results = []
      for p in paths:
          if not os.path.isfile(p):
              results.append({'path': p, 'text': None, 'error': 'not_found'})
              continue
          try:
              img = Image.open(p)
              text = pytesseract.image_to_string(img, lang=lang).strip()
              results.append({'path': p, 'text': text or None})
          except Exception as e:
              results.append({'path': p, 'text': None, 'error': str(e)})
      merged = '\n'.join(r['text'] for r in results if r.get('text'))
      return jsonify({'results': results, 'merged': merged})

  @app.get('/health')
  def health():
      return {'ok': True}
  ```

- `ocr/requirements.txt`
  ```
  flask==3.0.3
  gunicorn==22.0.0
  pytesseract==0.3.13
  Pillow==10.4.0
  ```

- `ocr/Dockerfile`
  ```dockerfile
  FROM python:3.12-slim
  RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-ita tesseract-ocr-eng \
      && rm -rf /var/lib/apt/lists/*
  WORKDIR /app
  COPY requirements.txt .
  RUN pip install --no-cache-dir -r requirements.txt
  COPY app.py .
  EXPOSE 5001
  CMD ["gunicorn", "-b", "0.0.0.0:5001", "-w", "2", "--threads", "4", "--timeout", "60", "app:app"]
  ```

**Docker compose (aggiungere):**

```yaml
soundreel-ocr:
  build:
    context: ./ocr
  image: soundreel-ocr:local
  container_name: soundreel-ocr
  volumes:
    - soundreel_media:/data/media:ro
  networks: [default]
  restart: unless-stopped
```

### 4.4 `docker-compose.yml` — diff completo

- Nuovo volume `soundreel_media` (shared)
- Nuovo volume `soundreel_whisper_models`
- Mount `soundreel_media` su: `soundreel` (ro), `soundreel-instaloader` (rw), `soundreel-whisper` (ro), `soundreel-ocr` (ro)
- `depends_on` aggiornati su `soundreel`: attende anche whisper + ocr (`service_started`)
- Envvar su `soundreel`:
  - `WHISPER_URL=http://soundreel-whisper:9000`
  - `OCR_URL=http://soundreel-ocr:5001`
  - `MEDIA_ROOT=/data/media`

---

## 5. Cambi backend (TypeScript)

### 5.1 File NUOVI

#### `backend/src/services/instaloaderLocal.ts`

Sostituisce (logicamente) `instaloader.ts`. Chiama `POST /download` e ritorna path locali.

```ts
export interface InstaloaderDownload {
  caption: string | null;
  musicInfo: { title: string; artist: string } | null;
  videoPath: string | null;       // /data/media/<entryId>/video.mp4
  audioPath: string | null;       // /data/media/<entryId>/audio.wav
  thumbnailPath: string | null;
  slidePaths: string[];           // carosello
  framePaths: string[];           // frame video campionati
  success: boolean;
  error?: string;
}

export async function downloadWithInstaloader(
  url: string,
  entryId: string
): Promise<InstaloaderDownload> { … }
```

#### `backend/src/services/whisperClient.ts`

```ts
export interface WhisperResult {
  text: string | null;
  language: string | null;
  durationMs: number;
  status: 'ok' | 'skipped' | 'error';
  reason?: string;
}

export async function transcribeLocal(audioPath: string): Promise<WhisperResult> { … }
```

Implementazione: legge file da filesystem (volume condiviso), POST multipart a `${WHISPER_URL}/asr?task=transcribe&output=json`.

#### `backend/src/services/ocrClient.ts`

```ts
export interface OcrResult {
  perImage: Array<{ path: string; text: string | null }>;
  merged: string;
  status: 'ok' | 'error';
}

export async function ocrImages(paths: string[]): Promise<OcrResult> { … }
```

#### `backend/src/services/frameSelector.ts`

Seleziona N frame chiave tra tutti i campionati. Euristica v1: primo, ultimo, e 3 equidistanti nel mezzo. Upgrade futuro: diff pixel per scene change.

```ts
export function pickKeyFrames(framePaths: string[], n: number = 5): string[] { … }
```

### 5.2 File MODIFICATI

#### `backend/src/services/transcribeAudio.ts`

Rimpiazza stub. Wrapper che chiama `whisperClient.transcribeLocal(audioPath)`.

**Firma nuova:**
```ts
export async function transcribeAudio(audioPath: string | null): Promise<TranscriptionResult>
```

Rimuove `DownloadedMedia`, `audioUrl`, `mimeTypeOverride`, `useVertexAi` (tutti obsoleti).

#### `backend/src/services/aiAnalysis.ts`

Rewrite firma input:

```ts
export async function analyzeWithAi(input: {
  caption: string | null;
  musicInfo: { title: string; artist: string } | null;
  transcript: string | null;
  transcriptLanguage: string | null;
  ocrText: string | null;
  visualContext: string | null;
  carouselSlidePaths: string[];  // per vision su slide se needed
}): Promise<AiAnalysisResponse>
```

- Costruisce prompt unico multimodale da `promptLoader.getPrompt('contentAnalysis')` con variabili nuove
- Passa N frame chiave come `OllamaImage[]` a `generateText`
- Parsing JSON invariato

#### `backend/src/services/contentExtractor.ts`

**Opzione scelta:** dual-mode con branch per platform.

```ts
export async function extractContent(url, options): Promise<ExtractedContent> {
  const platform = detectPlatform(url);

  if (platform === 'instagram') {
    // NUOVO path: solo Instaloader local
    return extractInstagram(url, options.entryId);
  }

  // LEGACY path per altre piattaforme (invariato)
  return extractLegacy(url, options);
}
```

- `extractInstagram` = nuova funzione: chiama `downloadWithInstaloader`, ritorna `ExtractedContent` esteso con `localPaths`
- `extractLegacy` = rename del codice attuale (oEmbed + OG + cobalt + IG API cookies fallback). Mantiene compatibilità piattaforme non-IG
- Tipo `ExtractedContent` esteso con campo opzionale `localPaths?: {videoPath, audioPath, thumbnailPath, slidePaths[], framePaths[]}`

#### `backend/src/types/index.ts`

Estendere `ExtractedContent`:

```ts
export interface ExtractedContentLocalPaths {
  videoPath: string | null;
  audioPath: string | null;
  thumbnailPath: string | null;
  slidePaths: string[];
  framePaths: string[];
}

export interface ExtractedContent {
  caption: string | null;
  thumbnailUrl: string | null;
  audioUrl: string | null;
  videoUrl: string | null;
  hasAudio: boolean;
  hasCaption: boolean;
  musicInfo: { title: string; artist: string } | null;
  carouselUrls: string[];
  localPaths?: ExtractedContentLocalPaths;  // NUOVO (solo IG nuovo path)
}
```

Nota: `audioUrl`, `videoUrl`, `thumbnailUrl`, `carouselUrls` restano compilati anche per IG (da path locali servibili internamente? NO — per IG path nuovo questi restano `null`, solo `localPaths` popolato). Frontend deve leggere da DB `thumbnailUrl` salvato — quindi path locale va servito via endpoint Fastify statico (vedi 5.3).

#### `backend/src/routes/analyze.ts`

Rewrite flusso IG. Pseudocodice:

```ts
const entryId = await createEntry(initialEntry);

if (platform === 'instagram') {
  const dl = await downloadWithInstaloader(url, entryId);
  if (!dl.success) { fail(entryId, dl.error); return; }

  // Audio → Whisper
  const asr = featuresConfig.transcriptionEnabled && dl.audioPath
    ? await transcribeLocal(dl.audioPath)
    : { text: null, language: null, status: 'skipped' };

  // OCR frame + slide
  const ocr = await ocrImages([...dl.framePaths, ...dl.slidePaths]);

  // Vision su frame chiave
  const keyFrames = pickKeyFrames(dl.framePaths, 5);
  const visualContext = keyFrames.length
    ? await describeFramesWithVision(keyFrames)
    : null;

  // LLM multimodale
  const aiResponse = featuresConfig.aiAnalysisEnabled
    ? await analyzeWithAi({
        caption: dl.caption,
        musicInfo: dl.musicInfo,
        transcript: asr.text,
        transcriptLanguage: asr.language,
        ocrText: ocr.merged,
        visualContext,
        carouselSlidePaths: dl.slidePaths,
      })
    : emptyAiResponse;

  // Music: SOLO musicInfo IG (no AudD, no LLM fallback su songs)
  const audioResult = dl.musicInfo
    ? { title: dl.musicInfo.title, artist: dl.musicInfo.artist, album: null }
    : null;

  const merged = mergeResults(audioResult, aiResponse.result);

  // Spotify + TMDb invariati (come oggi)
  …
} else {
  // LEGACY path per altre piattaforme (invariato)
  …
}
```

**Action log entries nuove:**
- `instaloader_download` (con paths, musicInfo, durata)
- `whisper_asr` (con durata, lingua, char count)
- `ocr_extract` (con frame count, char count)
- `vision_describe` (con n frame analizzati)

**Action log entries rimosse** (per path IG):
- `media_downloaded` (sostituita da `instaloader_download`)
- `media_download_skipped`
- `media_download_failed`

#### `backend/src/services/ollamaClient.ts`

Nuova funzione helper:

```ts
export async function describeFramesWithVision(framePaths: string[]): Promise<string | null>
```

Legge file immagini da filesystem, converte base64, chiama Ollama con model `moondream:latest`, prompt: "Describe briefly the main scenes: settings, people, actions, products, brands visible."

#### `backend/src/server.ts`

- Aggiungi static route per `/media/<entryId>/<filename>` → serve da `process.env.MEDIA_ROOT`
- **Security:** solo path dentro `MEDIA_ROOT`, no path traversal (`path.resolve` + check `startsWith`)
- Scope: solo frontend interno / LAN-only (Traefik già LAN-only sul router principale)

#### `backend/src/services/promptLoader.ts`

Nuovo prompt default `contentAnalysis` aggiornato con variabili multimodali:

Variabili nuove:
- `caption`, `hasCaption`
- `musicInfo` (oggetto o null), `hasMusicInfo`
- `transcript`, `hasTranscript`, `transcriptLanguage`
- `ocrText`, `hasOcr`
- `visualContext`, `hasVisualContext`
- `isCarousel`, `carouselCount`

Template body istruisce LLM a:
- Non dedurre canzoni da transcript (perché musicInfo è autoritativo per IG)
- Usare transcript + OCR + visualContext come contesto per film, notes, tags, summary
- Se `musicInfo` presente, NON includere altre songs a meno di menzione esplicita in caption/ocr

### 5.3 Path assets: serving pubblico

Frontend usa `thumbnailUrl` per mostrare preview. Path locali non sono URL pubblici.

**Soluzione:** Fastify route `GET /media/<entryId>/<filename>`:
- LAN-only (già garantito da Traefik main router)
- Legge file da `MEDIA_ROOT`
- Salva in DB `entries.thumbnail_url = '/media/<entryId>/thumbnail.jpg'`

### 5.4 File MOVED → `_legacy/`

Move (non delete) per retro-compat piattaforme non-IG e rollback:

```
backend/src/services/_legacy/
  ├── audioRecognition.ts      (AudD)
  ├── instaloaderHttp.ts       (ex-instaloader.ts, fetch-only)
  └── mediaDownloader.ts       (download URL remoto)
```

`contentExtractor.ts` importa da `_legacy/` per `extractLegacy` (platforms non-IG). Il path Instagram non tocca queste funzioni.

**Nota:** i file spostati vanno aggiornati negli import (`analyze.ts` non importa più `mediaDownloader` né `audioRecognition` dal path IG; per legacy path sì).

### 5.5 Config + envvars

**Nuove envvar backend:**
- `WHISPER_URL=http://soundreel-whisper:9000`
- `OCR_URL=http://soundreel-ocr:5001`
- `MEDIA_ROOT=/data/media`

**Envvar dismesse alla fine:**
- `AUDD_API_KEY` (droppata)
- `COBALT_API_URL` (droppata)
- `INSTAGRAM_SESSION_ID`, `INSTAGRAM_CSRF_TOKEN`, `INSTAGRAM_DS_USER_ID` (droppate, fetchInstagramApi fuori da path IG)

**Features config DB (tabella `config`):**
- `cobaltEnabled` → deprecata per path IG, ignorata
- `mediaAnalysisEnabled` → semantica invariata (se false, skip Whisper+OCR+vision)
- `transcriptionEnabled` → semantica invariata (controlla Whisper)
- `aiAnalysisEnabled` → invariata
- `autoEnrichEnabled` → invariata (OpenAI enrich rimane opt-in)

---

## 6. Frontend

**Nessun cambio richiesto.** Il frontend consuma già `Entry.results` + `Entry.thumbnailUrl` + `Entry.sourcePlatform` + action log. Nuove action log appaiono automaticamente nel journal.

**Opzionale (post-v1):**
- Mostrare lingua transcript in `EntryCard`
- Badge "OCR" se `ocrText` presente
- Badge "local-extraction" vs "legacy" per distinguere entry processate col nuovo path

---

## 7. Sequenza esecutiva (ordine task)

### T1 — Extend `soundreel-instaloader` con `/download` + ffmpeg
**Acceptance:**
- Container build pulito con ffmpeg installato
- `curl POST /download -d '{"url":"...","entryId":"test-1"}'` torna JSON con path valorizzati
- File presenti in `/data/media/test-1/` dal container backend
- `/health` OK
- Legacy `/fetch` funziona ancora

### T2 — Nuovo container `soundreel-whisper`
**Acceptance:**
- Container up
- `curl POST /asr` con file wav ritorna transcript JSON
- Modello `small` cached in volume
- Cold start < 60s, warm call < 20s per reel 30s

### T3 — Nuovo container `soundreel-ocr`
**Acceptance:**
- Container up
- `curl POST /ocr` con `{paths:["/data/media/test-1/slide-001.jpg"]}` ritorna testo estratto
- Lingue IT+EN supportate

### T4 — Backend: client services nuovi
Crea `instaloaderLocal.ts`, `whisperClient.ts`, `ocrClient.ts`, `frameSelector.ts`, `describeFramesWithVision` in `ollamaClient.ts`.
**Acceptance:** `tsc` compila. Unit smoke-test: import tutti i moduli senza runtime error.

### T5 — Backend: static media serving
Fastify route `/media/:entryId/:filename` con path safety.
**Acceptance:**
- `curl https://soundreel.casamon.dev/media/test-1/thumbnail.jpg` serve file (LAN)
- Path traversal rifiutato (`../etc/passwd` → 403)

### T6 — Backend: `contentExtractor.ts` split IG / legacy
Refactor: `extractInstagram` nuovo, `extractLegacy` (codice attuale preservato).
**Acceptance:** `tsc` compila. Test manuale: URL TikTok usa ancora path legacy.

### T7 — Backend: `aiAnalysis.ts` rewrite multimodale + prompt nuovo
Aggiorna firma + template.
**Acceptance:** chiamata Ollama con tutte le variabili nuove, JSON parsato correttamente su reel di test.

### T8 — Backend: `analyze.ts` rewrite flusso IG
Wire tutto.
**Acceptance:**
- POST `/api/analyze` con URL IG test completa end-to-end
- Action log contiene tutte le nuove entry
- Entry in DB con `results`, `transcription`, `overlayText`, `visualContext`
- Nessuna chiamata AudD / cobalt (verify via network trace)

### T9 — Move legacy in `_legacy/`
Sposta file, aggiorna import paths.
**Acceptance:** `tsc` compila. Path non-IG (es. TikTok) funziona ancora.

### T10 — Cleanup envvar + compose
Rimuovi `AUDD_API_KEY` / `COBALT_API_URL` / cookie IG dal `.env` e da `docker-compose.yml`.
**Acceptance:** `docker compose config` valido. Boot backend sano.

### T11 — Validazione end-to-end
- Batch test su 20 reel campione (mix: con voce, senza voce, carosello, con musica IG, senza musica IG)
- Confronto manuale vecchi risultati (già in DB) vs nuovi
- Metriche: tempo pipeline, quality songs/films rilevati, fallimenti

**Acceptance criteria aggregato:**
- ≥80% dei reel testati: almeno pari quality al vecchio path
- Tempo pipeline < 60s per reel 30s (P90)
- Zero regressioni su path non-IG
- Nessun crash container per 24h

### T12 — Cleanup & commit
- Git commit per ogni fase (T1-T11)
- Rebuild hub: `cd geekom-hub && ./bin/regenerate-hub`
- Aggiorna `README.md` nuova architettura
- Deploy final

---

## 8. Test plan

### Test isolati (per container)

- **Instaloader `/download`:** 3 URL sample (reel video, carosello immagini, post singola immagine) → path corretti, file presenti, musicInfo valorizzato dove atteso
- **Whisper `/asr`:** 2 file wav sample (IT e EN) → transcript + lingua corretta
- **OCR `/ocr`:** 2 immagini sample con testo overlay (IT e EN) → testo estratto

### Test integrazione

Script `scripts/test-local-pipeline.sh`:
- Input: URL IG test
- Esegue intero flusso via POST `/api/analyze`
- Asserzioni su entry DB: campi presenti, action log ordinato, file presenti su volume

### Test regressione

Path non-IG:
- TikTok URL → action log mostra `extractWithOEmbed` (legacy), non tocca Instaloader/Whisper/OCR
- YouTube URL → idem

### Test performance

- 5 reel 30s in sequenza → tempo medio, P90, P99
- Monitor RAM container (`docker stats`) durante esecuzione concorrente

### Test fallimento

- IG URL inesistente → `instaloader_download` failed, entry `status=error`, pipeline non crasha
- Whisper offline → action log `whisper_asr` skipped/error, pipeline continua su OCR + caption
- OCR offline → action log `ocr_extract` error, pipeline continua
- Ollama offline → `ai_analyzed` error, Entry completata con solo `musicInfo` + Spotify

---

## 9. Rollback

Niente feature flag (cutover diretto). Rollback = `git revert <commit-range>` + `docker compose up -d --build`. Il path legacy è preservato in `_legacy/` e riattivabile rimuovendo il branch `if platform === 'instagram'` in `contentExtractor.ts`.

Tempo stimato rollback: < 10 minuti.

---

## 10. Rischi e mitigazioni

| Rischio | Severità | Mitigazione |
|---|---|---|
| Whisper lento su CPU | Medium | Modello `small`, reel = 15-60s accettabile. Monitor P90 |
| Ollama + Whisper + moondream contemporanei saturano RAM | High | Serializzare chiamate se serve. Test RAM pre-rollout. A8 Max = 32GB dovrebbe reggere |
| Instaloader bloccato da IG | Medium | Mantieni session via docker exec. Action log flag errore. Rollback rapido via `_legacy/` |
| OCR rumoroso (testo spurio su video frame) | Low | Filtra per lunghezza min (>5 char), deduplica tra frame |
| Perdita identification cover/remix senza AudD | Medium | **Accettato dal committente**. musicInfo IG è source of truth |
| Frame sampling perde scene chiave | Low | N=5 frame su 30s video = 1 ogni 6s, dense enough. Upgrade post-v1 con scene change |
| Path traversal su static media route | High | `path.resolve` + `startsWith(MEDIA_ROOT)` check obbligatorio |
| Disk fill su `/data/media` | Medium | Cleanup dopo 7gg. Alert disk > 80% via pulse |

---

## 11. Env / Secrets delta

### `.env` sezioni modificate

**Rimosse:**
```
AUDD_API_KEY=...
COBALT_API_URL=...
INSTAGRAM_SESSION_ID=...
INSTAGRAM_CSRF_TOKEN=...
INSTAGRAM_DS_USER_ID=...
```

**Aggiunte:**
```
WHISPER_URL=http://soundreel-whisper:9000
OCR_URL=http://soundreel-ocr:5001
MEDIA_ROOT=/data/media
WHISPER_MODEL=small
```

### `docker-compose.yml` volumes finali

```yaml
volumes:
  soundreel_pgdata:
  soundreel_instaloader_session:
  soundreel_media:              # NUOVO
  soundreel_whisper_models:     # NUOVO
```

---

## 12. Open decisions (da confermare prima di T1)

1. **Whisper model:** `small` (500MB, più veloce) o `medium` (1.5GB, più accurato)? → **proposta: `small`**, upgrade se quality bassa
2. **Frame sampling rate:** 1 ogni 2s o 1 ogni 3s? → **proposta: 1 ogni 2s**, max 15 frame per reel
3. **Key frame count per vision:** 3 o 5 o 7? → **proposta: 5**
4. **Cleanup `/data/media`:** inline a fine entry (aggressive) o TTL 7gg (conservativo per debug)? → **proposta: TTL 7gg**, cleanup via cron

---

## 13. Thumbnail persistente locale (cross-platform)

### Problema

Le thumbnail attualmente salvate in DB sono URL diretti a CDN delle piattaforme (es. Instagram `scontent-*.cdninstagram.com`). Questi URL sono **firmati con expiry** (tipicamente 24-72h). Dopo la scadenza il frontend riceve 404 → thumbnail rotte.

### Soluzione

**Per ogni entry (IG + legacy platforms)** scaricare thumbnail una volta, salvarla locale low-res, servirla via route interna stabile.

### Specifica

- **Path:** `/data/media/<entryId>/thumbnail.jpg`
- **Formato:** JPEG, max 320px lato lungo (compatto), quality 80
- **Storage:** volume `soundreel_media` (stesso usato per video/audio)
- **DB field:** `entries.thumbnail_url` = `/media/<entryId>/thumbnail.jpg` (path relativo servito da backend)
- **Route serving:** Fastify static `GET /media/:entryId/:filename` (già in piano, sezione 5.3)
- **Fallback:** se download fallisce, salva URL originale (comportamento attuale) + flag `thumbnail_local=false`

### Implementazione

**Nuovo servizio backend:**

`backend/src/services/thumbnailSaver.ts`
```ts
import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';

export async function saveThumbnailLocal(
  sourceUrl: string,
  entryId: string
): Promise<{ localPath: string; relativeUrl: string } | null> {
  try {
    const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());

    const dir = path.join(process.env.MEDIA_ROOT!, entryId);
    await fs.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, 'thumbnail.jpg');

    await sharp(buf)
      .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(outPath);

    return { localPath: outPath, relativeUrl: `/media/${entryId}/thumbnail.jpg` };
  } catch {
    return null;
  }
}
```

**Dependency nuova:** `sharp` (`npm i sharp` in `backend/`).

**Per path IG (nuovo):** Instaloader sidecar scarica già thumbnail. Il sidecar stesso resize con ffmpeg o Pillow prima di scrivere `/data/media/<entryId>/thumbnail.jpg`. Alternativa: thumbnail full-size dal sidecar, `thumbnailSaver` resize post-hoc (più flessibile, tengo questa).

**Per path legacy (altre piattaforme):** dopo `extractLegacy` che ritorna `thumbnailUrl`, chiamare `saveThumbnailLocal(thumbnailUrl, entryId)` in `analyze.ts`. Se successo, salvare `relativeUrl` in DB. Altrimenti `sourceUrl` originale.

### Cambi in `analyze.ts`

```ts
// Dopo extractContent, prima di updateEntry:
let persistentThumb: string | null = content.thumbnailUrl;
if (content.thumbnailUrl) {
  const saved = await saveThumbnailLocal(content.thumbnailUrl, entryId);
  if (saved) {
    persistentThumb = saved.relativeUrl;
    await appendActionLog(entryId, createActionLog('thumbnail_saved', {
      relativeUrl: saved.relativeUrl,
    }));
  } else {
    await appendActionLog(entryId, createActionLog('thumbnail_save_failed', {
      sourceUrl: content.thumbnailUrl,
    }));
  }
}

await updateEntry(entryId, {
  caption: content.caption,
  thumbnailUrl: persistentThumb,
  mediaUrl: content.videoUrl || content.audioUrl || null,
});
```

### Backfill entry esistenti

**Skip.** Entry esistenti (89) restano con URL IG scaduti (rotte). Nessun recovery. Solo nuovi post post-deploy hanno thumbnail permanente.

### Cleanup su delete entry

Quando entry eliminata (DELETE `/api/entries/:id`), directory `/data/media/<entryId>/` **non** rimossa immediatamente. Marcata con `deleted_at` e rimossa da cleanup job dopo **TTL 7 giorni** (stesso meccanismo del TTL generale — vedi sezione 2 volume layout).

Implementazione: tabella `config` key `deleted_entries_pending` con array `{entryId, deletedAt}`, cron job giornaliero svuota directory per entry con `deletedAt > 7gg`.

Alternativa semplice: cleanup cron scansiona `/data/media/` e elimina directory la cui entry non esiste più in DB da >7gg (orphan detection via JOIN). **Proposta: alternativa semplice**, niente tabella extra.

### Acceptance criteria

- Nuova entry IG: `thumbnail_url` in DB = `/media/<id>/thumbnail.jpg`, accessibile da frontend, file JPEG ≤ 50KB
- Nuova entry legacy (TT/YT): stesso behavior via `thumbnailSaver`
- Frontend: zero thumbnail rotte su entry post-deploy
- Delete entry: directory media rimossa
- Backfill script: idempotente, log chiaro

### Task delta

Nuovo task in sequenza:

**T5b (subito dopo T5 static serving):** Implementa `thumbnailSaver.ts` + wire in `analyze.ts` path IG e legacy + install `sharp`.

### Effort aggiuntivo

- T5b: 1.5h
- **Totale delta: +1.5h → 23h totali**

---

## 14. Stima effort

| Task | Effort |
|---|---|
| T1 (Instaloader extend) | 2h |
| T2 (Whisper container) | 1h |
| T3 (OCR container) | 2h |
| T4 (backend clients) | 2h |
| T5 (static media) | 1h |
| T5b (thumbnailSaver + wire) | 1.5h |
| T6 (contentExtractor split) | 2h |
| T7 (aiAnalysis rewrite + prompt) | 3h |
| T8 (analyze.ts rewire) | 3h |
| T9 (legacy move) | 1h |
| T10 (env cleanup) | 0.5h |
| T11 (validation) | 3h |
| T12 (commit + docs) | 1h |
| **Totale** | **~23h** |

---

**FINE PLAN.**
