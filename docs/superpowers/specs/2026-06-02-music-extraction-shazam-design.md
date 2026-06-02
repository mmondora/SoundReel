# Design: Music Extraction — Shazam + Multi-Song + YouTube Diretto + Caroselli Strutturati

**Data:** 2026-06-02  
**Status:** approved  

---

## Obiettivo

Migliorare l'estrazione musicale su tre fronti:

1. **Fingerprinting**: Shazam come riconoscitore principale (restituisce Spotify + YouTube diretti), AudD come fallback.
2. **Multi-song detection**: rilevare e identificare più canzoni in un video compilation via segmentazione audio intelligente (`librosa`).
3. **YouTube diretto**: link al video specifico invece della search URL.
4. **Caroselli strutturati**: estrazione per-slide di canzoni, film, testi da caroselli Instagram.

---

## Architettura

```
analyze.ts
  ├── audioPath → shazamClient.recognizeAudio()      # Shazam first
  │     └── se no spotifyUrl → AudD fallback
  │     └── se no youtubeUrl → shazamClient.resolveYoutubeUrl()
  ├── se duration > 90s → shazamClient.scanFullAudio()  # multi-song
  ├── songs senza youtubeUrl → shazamClient.resolveYoutubeUrl()
  └── carosello → OCR per-slide → AI strutturata per-slide → merge
```

Il container `soundreel-instaloader` evolve in **media processor** centralizzato per tutto il processing audio/media Python.

---

## Sezione 1: Instaloader container — nuovi endpoint

### Dipendenze aggiunte (`requirements.txt`)

```
shazamio>=0.4.0
librosa>=0.10.0
yt-dlp>=2024.1.0
```

### `POST /shazam/recognize`

Fingerprint singolo su un file audio locale.

**Request:** `{ "audioPath": "/data/media/abc123/audio.wav" }`

**Response:**
```json
{
  "title": "Song Title",
  "artist": "Artist Name",
  "spotifyUrl": "https://open.spotify.com/track/...",
  "youtubeUrl": "https://www.youtube.com/watch?v=...",
  "confidence": 0.95
}
```
Ritorna `null` se non riconosciuta.

### `POST /shazam/scan-full`

Multi-song detection per compilation video.

**Request:** `{ "audioPath": "/data/media/abc123/audio.wav" }`

**Algoritmo:**
1. `librosa.load()` carica l'audio
2. Calcola RMS energy + onset strength ogni 0.5s
3. Rileva boundary cambio canzone: calo RMS >40% + spike onset strength
4. Se durata totale < 90s: esegue recognize singolo sull'intero file, ritorna
5. Per ogni segmento ≥15s: chiama `/shazam/recognize` sul segmento
6. Dedup per `spotifyUrl` o `(title_normalized, artist_normalized)`
7. Ritorna array ordinato per `timestampMs`

**Response:**
```json
[
  { "title": "...", "artist": "...", "spotifyUrl": "...", "youtubeUrl": "...", "timestampMs": 0 },
  { "title": "...", "artist": "...", "spotifyUrl": "...", "youtubeUrl": "...", "timestampMs": 47000 }
]
```

### `GET /yt/url?q=artist+title`

Risolve YouTube URL diretto via yt-dlp.

**Comando interno:**
```bash
yt-dlp --get-url --no-playlist "ytsearch1:artist title"
```

**Response:** `{ "url": "https://www.youtube.com/watch?v=..." }` o `{ "url": null }` se non trovato.

**Timeout:** 15s. Fallback silenzioso (non blocca la pipeline).

---

## Sezione 2: Backend Node.js — nuovo servizio

### `services/shazamClient.ts`

```typescript
export interface ShazamTrack {
  title: string;
  artist: string;
  spotifyUrl: string | null;
  youtubeUrl: string | null;
  timestampMs?: number;
}

export async function recognizeAudio(audioPath: string): Promise<ShazamTrack | null>
export async function scanFullAudio(audioPath: string): Promise<ShazamTrack[]>
export async function resolveYoutubeUrl(artist: string, title: string): Promise<string | null>
```

Tutte le funzioni leggono `INSTALOADER_URL` da env. Timeout: 60s per `recognizeAudio`, 300s per `scanFullAudio`, 15s per `resolveYoutubeUrl`.

### Modifiche `routes/analyze.ts`

**Audio fingerprinting (sostituisce flusso AudD-first):**

```
se audioPath presente:
  1. shazamClient.recognizeAudio(audioPath)
     → se risultato con spotifyUrl: usa Shazam result, log 'shazam_recognized'
     → se risultato senza spotifyUrl: AudD fallback, log 'shazam_no_spotify_audd_fallback'
     → se null: AudD fallback, log 'shazam_failed_audd_fallback'
  2. se youtubeUrl ancora null: shazamClient.resolveYoutubeUrl(artist, title)

shazamClient.scanFullAudio(audioPath)   # sempre chiamato se audioPath presente
  → il Python service controlla durata internamente:
      se < 90s: esegue recognize singolo, ritorna array con 1 elemento
      se >= 90s: segmentazione completa
  → merge con song principale (dedup per spotifyUrl)
  → log 'multi_song_scan', count trovate
```

**YouTube diretto su tutte le canzoni:**

Dopo AI analysis, per ogni `song` senza `youtubeUrl`:
```
shazamClient.resolveYoutubeUrl(song.artist, song.title)
```
Runs in parallel con `Promise.allSettled`.

### Modifiche `services/_legacy/audioRecognition.ts`

Rimane invariato — diventa fallback secondario chiamato solo da `analyze.ts` quando Shazam fallisce.

---

## Sezione 3: Tipi

### `types/index.ts` — modifiche a `Song`

```typescript
interface Song {
  // campi esistenti...
  youtubeUrl: string | null;  // ora URL diretto (non search), può essere null
  sourceSlide?: number;       // indice slide carosello (0-based), presente solo per song da carousel
}
```

Stesso `sourceSlide` aggiunto a `Film`.

### DB — nessuna migrazione

`songs` e `films` sono `jsonb[]` in Postgres. I nuovi campi sono additivi e retrocompatibili. I vecchi record mantengono `youtubeUrl` come search URL — non vengono aggiornati retroattivamente.

---

## Sezione 4: Caroselli strutturati

### Problema attuale

OCR gira su ogni slide, ma il testo viene concatenato in un blob unico passato all'AI. Si perde la struttura per-slide.

### Nuovo flusso

```
slides[]: string[] (path immagini)
  → OCR per-slide (già esistente, produce ocrText[])
  → per ogni slide con ocrText non vuoto:
      AI structured extraction (nuovo prompt)
      → [{ type, title, artist, year, ... }]
  → merge: song items → entry.songs, film items → entry.films
  → per ogni song estratta: searchSpotifyTracks() + resolveYoutubeUrl()
```

### Prompt AI per-slide

```
Questa è la slide {{slideIndex}} di {{totalSlides}} di un carosello Instagram.

Testo OCR estratto:
{{ocrText}}

Estrai tutti gli oggetti culturali menzionati in formato JSON array.
Per ogni oggetto:
{ "type": "song"|"film"|"book"|"album"|"text", "title": "...", "artist": "...", 
  "director": "...", "year": null|number, "notes": "..." }

Usa null per campi sconosciuti. Se non c'è nulla di estraibile, ritorna [].
Rispondi SOLO con il JSON array, senza testo aggiuntivo.
```

### Attivazione

Il flusso per-slide si attiva solo se `slidePaths.length > 0` e `featuresConfig.carouselStructuredExtraction === true` (nuovo flag in settings).

### Nota audio carosello

I caroselli Instagram sono foto — nessun audio per slide. La musica del carosello (1 sola, da `musicInfo` API meta) continua a essere gestita dal flusso audio esistente.

---

## Resilienza

| Step | Fallimento | Comportamento |
|---|---|---|
| Shazam recognize | timeout / errore | AudD fallback, log warning |
| Shazam scan-full | timeout / errore | songs[] vuoto, continua pipeline |
| yt-dlp resolve | timeout / errore | `youtubeUrl: null`, nessun blocco |
| AI per-slide | errore JSON / timeout | slide ignorata, log warning |
| Spotify search per slide song | not found | `spotifyUrl: null`, song inclusa comunque |

---

## Feature flags (settings DB)

| Flag | Default | Descrizione |
|---|---|---|
| `shazamEnabled` | `true` | Abilita Shazam come fingerprinter principale |
| `multiSongScanEnabled` | `true` | Attiva scan-full per video >90s |
| `youtubeDirect` | `true` | Risolve YouTube URL diretto via yt-dlp |
| `carouselStructuredExtraction` | `true` | AI per-slide su caroselli |

---

## File modificati

| File | Tipo modifica |
|---|---|
| `instaloader/app.py` | aggiunge 3 endpoint + librerie |
| `instaloader/requirements.txt` | +shazamio, librosa, yt-dlp |
| `instaloader/Dockerfile` | +dipendenze sistema per librosa (libsndfile) |
| `backend/src/services/shazamClient.ts` | nuovo file |
| `backend/src/routes/analyze.ts` | modifica pipeline audio + carousel |
| `backend/src/services/aiAnalysis.ts` | aggiunge prompt per-slide carousel |
| `backend/src/types/index.ts` | +sourceSlide su Song/Film |
