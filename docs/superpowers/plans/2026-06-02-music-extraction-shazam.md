# Music Extraction Upgrade — Shazam + Multi-Song + YouTube Diretto + Caroselli Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade music extraction to Shazam-first fingerprinting with multi-song detection via librosa audio segmentation, direct YouTube links via yt-dlp, and structured per-slide extraction for Instagram carousels.

**Architecture:** `soundreel-instaloader` Python container gains three new HTTP endpoints (`/shazam/recognize`, `/shazam/scan-full`, `/yt/url`). The Node.js backend gets a new `shazamClient.ts` service. The IG analyze pipeline uses Shazam when audioPath is present, resolves YouTube URLs directly, and runs per-slide AI extraction for carousel posts. Both containers share the `soundreel_media` Docker volume — paths written by soundreel are readable by instaloader and vice versa.

**Tech Stack:** Python `shazamio`, `librosa`, `yt-dlp` (in soundreel-instaloader container); Node.js 20 + TypeScript Fastify backend; Ollama (`qwen2.5:3b`) for per-slide extraction.

---

## File Map

| File | Action |
|---|---|
| `instaloader/requirements.txt` | add shazamio, librosa, numpy, yt-dlp |
| `instaloader/Dockerfile` | add `libsndfile1` apt dep (needed by librosa) |
| `instaloader/app.py` | add 3 endpoints + helper functions (before `if __name__`) |
| `backend/src/services/shazamClient.ts` | new file |
| `backend/src/utils/db.ts` | add 4 flags to FeaturesConfig + DEFAULT_FEATURES |
| `backend/src/types/index.ts` | add `sourceSlide?: number` to Song and Film |
| `backend/src/routes/analyze.ts` | IG pipeline: use shazamClient; all songs: YouTube direct |
| `backend/src/services/aiAnalysis.ts` | add `extractFromSlides()` function |

---

## Task 1: instaloader — requirements + Dockerfile

**Files:**
- Modify: `instaloader/requirements.txt`
- Modify: `instaloader/Dockerfile`

- [ ] **Step 1: Update requirements.txt**

Replace contents of `instaloader/requirements.txt`:

```
instaloader==4.13.1
flask==3.0.3
gunicorn==22.0.0
requests==2.32.3
shazamio>=0.4.0
librosa>=0.10.0
numpy>=1.24.0
yt-dlp>=2024.1.0
```

- [ ] **Step 2: Add libsndfile1 to Dockerfile**

In `instaloader/Dockerfile`, change the apt-get block from:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*
```

to:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 3: Commit**

```bash
git add instaloader/requirements.txt instaloader/Dockerfile
git commit -m "feat(instaloader): add shazamio, librosa, yt-dlp dependencies"
```

---

## Task 2: instaloader — `/shazam/recognize` endpoint

**Files:**
- Modify: `instaloader/app.py` (add before `if __name__ == "__main__":` at line 492)

- [ ] **Step 1: Add imports at the top of app.py**

After the existing imports block (after `from flask import Flask, jsonify, request`), add:

```python
import asyncio
import tempfile
from shazamio import Shazam
```

- [ ] **Step 2: Add helper function and endpoint**

Insert the following before `if __name__ == "__main__":` (before line 492):

```python
# ---------------------------------------------------------------------------
# Shazam helpers
# ---------------------------------------------------------------------------

def _shazam_recognize(audio_path: str) -> dict | None:
    """Run Shazam fingerprint on a local audio file. Returns track dict or None."""
    async def _run():
        shazam = Shazam()
        return await shazam.recognize(audio_path)

    try:
        result = asyncio.run(_run())
    except Exception as exc:
        log.warning("shazam recognize error: %s", exc)
        return None

    track = result.get("track")
    if not track:
        return None

    title = track.get("title", "")
    artist = track.get("subtitle", "")  # Shazam uses 'subtitle' for artist

    # Extract Spotify URI from hub providers
    spotify_url: str | None = None
    hub = track.get("hub", {})
    for provider in hub.get("providers", []):
        caption = (provider.get("caption") or "").lower()
        if "spotify" in caption:
            for action in provider.get("actions", []):
                uri = action.get("uri", "")
                if uri.startswith("spotify:track:"):
                    spotify_url = f"https://open.spotify.com/track/{uri.split(':')[-1]}"
                    break
        if spotify_url:
            break

    return {
        "title": title,
        "artist": artist,
        "spotifyUrl": spotify_url,
        "youtubeUrl": None,  # resolved separately via /yt/url
    }


@app.route("/shazam/recognize", methods=["POST"])
def shazam_recognize():
    """Fingerprint a single local audio file with Shazam.

    Request JSON: {"audioPath": "/data/media/<entryId>/audio.wav"}
    Response: {"title": ..., "artist": ..., "spotifyUrl": ..., "youtubeUrl": null}
              or null body with 204 if not recognized.
    """
    data = request.get_json(silent=True) or {}
    audio_path = data.get("audioPath")
    if not audio_path or not Path(audio_path).is_file():
        return jsonify({"error": "audioPath missing or not found"}), 400

    log.info("shazam/recognize path=%s", audio_path)
    track = _shazam_recognize(audio_path)
    if not track:
        return "", 204

    log.info("shazam recognized title=%s artist=%s", track["title"], track["artist"])
    return jsonify(track)
```

- [ ] **Step 3: Verify syntax**

```bash
cd /home/mike/works/Soundreel/instaloader && python -c "import ast; ast.parse(open('app.py').read()); print('syntax ok')"
```

Expected: `syntax ok`

- [ ] **Step 4: Commit**

```bash
git add instaloader/app.py
git commit -m "feat(instaloader): add /shazam/recognize endpoint"
```

---

## Task 3: instaloader — `/shazam/scan-full` endpoint

**Files:**
- Modify: `instaloader/app.py` (add after Task 2 code, before `if __name__`)

- [ ] **Step 1: Add boundary detection helper and scan-full endpoint**

Insert after the `shazam_recognize` route function (before `if __name__ == "__main__":`):

```python
def _normalize_track_key(title: str, artist: str) -> str:
    """Normalize title+artist for deduplication."""
    return re.sub(r"[^a-z0-9]", "", f"{title}{artist}".lower())


def _detect_song_boundaries(audio_path: str, min_segment_sec: float = 15.0) -> list[tuple[float, float]]:
    """Use librosa to find likely song-change boundaries in an audio file.

    Returns list of (start_sec, end_sec) tuples for segments >= min_segment_sec.
    Falls back to [(0, duration)] if librosa fails.
    """
    import librosa  # imported here to avoid slow startup when not needed
    import numpy as np

    try:
        y, sr = librosa.load(audio_path, sr=22050, mono=True)
        duration = librosa.get_duration(y=y, sr=sr)

        if duration < 90.0:
            return [(0.0, duration)]

        hop = int(0.5 * sr)
        rms = librosa.feature.rms(y=y, frame_length=hop * 2, hop_length=hop)[0]
        onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)

        rms_max = rms.max() or 1e-8
        onset_max = onset_env.max() or 1e-8
        rms_n = rms / rms_max
        onset_n = onset_env / onset_max

        boundaries: list[float] = [0.0]
        n = min(len(rms_n), len(onset_n))
        for i in range(1, n):
            rms_drop = float(rms_n[i - 1]) - float(rms_n[i])
            onset_spike = float(onset_n[i]) > 0.5
            if rms_drop > 0.4 and onset_spike:
                t = float(librosa.frames_to_time(i, sr=sr, hop_length=hop))
                if t - boundaries[-1] >= min_segment_sec:
                    boundaries.append(t)

        segments: list[tuple[float, float]] = []
        for i, start in enumerate(boundaries):
            end = boundaries[i + 1] if i + 1 < len(boundaries) else duration
            if end - start >= min_segment_sec:
                segments.append((start, end))

        return segments or [(0.0, duration)]
    except Exception as exc:
        log.warning("librosa boundary detection failed: %s", exc)
        return [(0.0, -1.0)]  # signal: recognize full file


def _extract_segment_wav(src: str, start: float, end: float, dst: str) -> bool:
    """Extract audio segment using ffmpeg."""
    cmd = ["ffmpeg", "-y", "-ss", str(start), "-i", src, "-t", str(end - start),
           "-acodec", "pcm_s16le", "-ar", "44100", dst]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=60)
        return r.returncode == 0 and Path(dst).exists()
    except Exception:
        return False


@app.route("/shazam/scan-full", methods=["POST"])
def shazam_scan_full():
    """Scan an audio file for multiple songs using librosa segmentation + Shazam.

    Request JSON: {"audioPath": "/data/media/<entryId>/audio.wav"}
    Response: JSON array of track objects (may be empty []).
    """
    data = request.get_json(silent=True) or {}
    audio_path = data.get("audioPath")
    if not audio_path or not Path(audio_path).is_file():
        return jsonify({"error": "audioPath missing or not found"}), 400

    log.info("shazam/scan-full path=%s", audio_path)
    segments = _detect_song_boundaries(audio_path)
    log.info("detected %d segment(s)", len(segments))

    seen: set[str] = set()
    tracks: list[dict] = []

    with tempfile.TemporaryDirectory() as tmp_dir:
        for idx, (start, end) in enumerate(segments):
            if end < 0:
                # Fallback: recognize full file
                seg_path = audio_path
            else:
                seg_path = str(Path(tmp_dir) / f"seg_{idx:03d}.wav")
                if not _extract_segment_wav(audio_path, start, end, seg_path):
                    log.warning("segment extract failed idx=%d start=%.1f end=%.1f", idx, start, end)
                    continue

            track = _shazam_recognize(seg_path)
            if not track or not track.get("title"):
                continue

            key = _normalize_track_key(track["title"], track.get("artist", ""))
            if key in seen:
                continue
            seen.add(key)

            track["timestampMs"] = int(start * 1000)
            tracks.append(track)
            log.info("shazam found title=%s artist=%s at %.1fs", track["title"], track["artist"], start)

    return jsonify(tracks)
```

- [ ] **Step 2: Verify syntax**

```bash
cd /home/mike/works/Soundreel/instaloader && python -c "import ast; ast.parse(open('app.py').read()); print('syntax ok')"
```

Expected: `syntax ok`

- [ ] **Step 3: Commit**

```bash
git add instaloader/app.py
git commit -m "feat(instaloader): add /shazam/scan-full endpoint with librosa segmentation"
```

---

## Task 4: instaloader — `/yt/url` endpoint

**Files:**
- Modify: `instaloader/app.py` (add after Task 3 code, before `if __name__`)

- [ ] **Step 1: Add yt/url endpoint**

Insert after the `shazam_scan_full` route (before `if __name__ == "__main__":`):

```python
@app.route("/yt/url")
def yt_url():
    """Resolve a direct YouTube video URL via yt-dlp search.

    Query param: q=artist+title
    Response: {"url": "https://www.youtube.com/watch?v=..."} or {"url": null}
    """
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"error": "q param required"}), 400

    log.info("yt/url query=%s", q)
    try:
        result = subprocess.run(
            ["yt-dlp", "--get-url", "--no-playlist", f"ytsearch1:{q}"],
            capture_output=True, text=True, timeout=15,
        )
        url = result.stdout.strip().splitlines()[0] if result.stdout.strip() else None
        if url and url.startswith("http"):
            log.info("yt/url found url=%s", url[:80])
            return jsonify({"url": url})
    except subprocess.TimeoutExpired:
        log.warning("yt/url timeout query=%s", q)
    except Exception as exc:
        log.warning("yt/url error: %s", exc)

    return jsonify({"url": None})
```

- [ ] **Step 2: Verify syntax**

```bash
cd /home/mike/works/Soundreel/instaloader && python -c "import ast; ast.parse(open('app.py').read()); print('syntax ok')"
```

Expected: `syntax ok`

- [ ] **Step 3: Commit**

```bash
git add instaloader/app.py
git commit -m "feat(instaloader): add /yt/url endpoint via yt-dlp"
```

---

## Task 5: backend — `shazamClient.ts`

**Files:**
- Create: `backend/src/services/shazamClient.ts`

- [ ] **Step 1: Create the file**

```typescript
import { logInfo, logWarning, logError } from '../utils/logger';

export interface ShazamTrack {
  title: string;
  artist: string;
  spotifyUrl: string | null;
  youtubeUrl: string | null;
  timestampMs?: number;
}

function instaloaderUrl(): string {
  return (process.env.INSTALOADER_URL ?? '').replace(/\/$/, '');
}

async function postJson<T>(path: string, body: unknown, timeoutMs: number): Promise<T | null> {
  const base = instaloaderUrl();
  if (!base) {
    logWarning('INSTALOADER_URL not set, skipping shazam');
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 204) return null;
    if (!res.ok) {
      logWarning(`shazamClient ${path} HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logWarning(`shazamClient ${path} timeout after ${timeoutMs}ms`);
    } else {
      logError(`shazamClient ${path} error`, err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function recognizeAudio(audioPath: string): Promise<ShazamTrack | null> {
  const track = await postJson<ShazamTrack>('/shazam/recognize', { audioPath }, 60_000);
  if (track) logInfo('Shazam recognized', { title: track.title, artist: track.artist });
  return track;
}

export async function scanFullAudio(audioPath: string): Promise<ShazamTrack[]> {
  const tracks = await postJson<ShazamTrack[]>('/shazam/scan-full', { audioPath }, 300_000);
  if (!tracks) return [];
  logInfo('Shazam scan-full', { found: tracks.length });
  return tracks;
}

export async function resolveYoutubeUrl(artist: string, title: string): Promise<string | null> {
  const base = instaloaderUrl();
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const q = encodeURIComponent(`${artist} ${title}`);
    const res = await fetch(`${base}/yt/url?q=${q}`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { url: string | null };
    return data.url ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 2: Build backend to verify TypeScript**

```bash
cd /home/mike/works/Soundreel/backend && npm run build 2>&1 | tail -5
```

Expected: build completes with no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/shazamClient.ts
git commit -m "feat(backend): add shazamClient service"
```

---

## Task 6: Feature flags + Song/Film types

**Files:**
- Modify: `backend/src/utils/db.ts:247-265`
- Modify: `backend/src/types/index.ts:1-29`

- [ ] **Step 1: Add feature flags to FeaturesConfig**

In `backend/src/utils/db.ts`, replace the `FeaturesConfig` interface and `DEFAULT_FEATURES` (lines 247-265):

```typescript
export interface FeaturesConfig {
  cobaltEnabled: boolean;
  allowDuplicateUrls: boolean;
  autoEnrichEnabled: boolean;
  mediaAnalysisEnabled: boolean;
  transcriptionEnabled: boolean;
  aiAnalysisEnabled: boolean;
  pageExtractionEnabled: boolean;
  shazamEnabled: boolean;
  multiSongScanEnabled: boolean;
  youtubeDirect: boolean;
  carouselStructuredExtraction: boolean;
}

const DEFAULT_FEATURES: FeaturesConfig = {
  cobaltEnabled: false,
  allowDuplicateUrls: false,
  autoEnrichEnabled: false,
  mediaAnalysisEnabled: false,
  transcriptionEnabled: true,
  aiAnalysisEnabled: true,
  pageExtractionEnabled: true,
  shazamEnabled: true,
  multiSongScanEnabled: true,
  youtubeDirect: true,
  carouselStructuredExtraction: true,
};
```

- [ ] **Step 2: Add sourceSlide to Song and Film types**

In `backend/src/types/index.ts`, replace the `Song` and `Film` interfaces (lines 1-29):

```typescript
export interface Song {
  title: string;
  artist: string;
  album: string | null;
  source: 'audio_fingerprint' | 'ai_analysis' | 'both';
  spotifyUri: string | null;
  spotifyUrl: string | null;
  youtubeUrl: string | null;
  soundcloudUrl: string | null;
  addedToPlaylist: boolean;
  sourceSlide?: number;
}

export interface StreamingUrls {
  netflix: string;
  primeVideo: string;
  raiPlay: string;
  now: string;
  disneyPlus: string;
  appleTv: string;
}

export interface Film {
  title: string;
  director: string | null;
  year: string | null;
  imdbUrl: string | null;
  posterUrl: string | null;
  streamingUrls: StreamingUrls | null;
  sourceSlide?: number;
}
```

- [ ] **Step 3: Build to verify**

```bash
cd /home/mike/works/Soundreel/backend && npm run build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/utils/db.ts backend/src/types/index.ts
git commit -m "feat(backend): add shazam/carousel feature flags; sourceSlide on Song+Film"
```

---

## Task 7: analyze.ts — Shazam in IG pipeline + YouTube direct

**Files:**
- Modify: `backend/src/routes/analyze.ts`

This task makes two changes:
1. In the IG pipeline: call `scanFullAudio` when `audioPath` is present, use Shazam results in song building.
2. In song building (shared): resolve YouTube URLs directly via `resolveYoutubeUrl` instead of generating search URLs.

- [ ] **Step 1: Add shazamClient import**

At the top of `analyze.ts`, after the existing imports, add:

```typescript
import { scanFullAudio, resolveYoutubeUrl } from '../services/shazamClient';
import type { ShazamTrack } from '../services/shazamClient';
```

- [ ] **Step 2: Add shazamTracks variable in the pipeline state block**

Find the `// Shared pipeline state` comment (around line 117). The block currently declares `audioResult`. Add `shazamTracks` next to it:

```typescript
// Shared pipeline state (populated by one of: page / IG / legacy branch)
// ...existing declarations...
let audioResult: AudioRecognitionResult | null = null;
let shazamTracks: ShazamTrack[] = [];   // ← add this line
```

- [ ] **Step 3: Call scanFullAudio after existing IG music block**

Find the IG music block (around line 357–376). It ends after the `else` block with `reason: 'no music_info in IG metadata'`. Immediately after that closing `}`, add:

```typescript
          // Shazam multi-song scan on local audio
          if (featuresConfig.shazamEnabled && localPaths?.audioPath) {
            try {
              shazamTracks = await scanFullAudio(localPaths.audioPath);
              await appendActionLog(entryId, createActionLog('shazam_scan', {
                found: shazamTracks.length,
                audioPath: localPaths.audioPath,
              }));
              // If no musicInfo, use first Shazam track as primary audioResult
              if (!audioResult && shazamTracks[0]) {
                audioResult = {
                  title: shazamTracks[0].title,
                  artist: shazamTracks[0].artist,
                  album: null,
                };
              }
            } catch (e) {
              await appendActionLog(entryId, createActionLog('shazam_scan', {
                status: 'error', error: String(e),
              }));
            }
          }
```

- [ ] **Step 4: Replace YouTube URL generation in song building loop**

Find the song building loop (around line 470–494). The line:

```typescript
          youtubeUrl: generateYoutubeSearchUrl(songData.title, songData.artist),
```

Replace with:

```typescript
          youtubeUrl: (() => {
            // Use Shazam direct URL if available for this track
            const shazam = shazamTracks.find(
              (t) => t.title.toLowerCase() === songData.title.toLowerCase() &&
                     t.artist.toLowerCase() === songData.artist.toLowerCase()
            );
            return shazam?.youtubeUrl ?? null;
          })(),
```

Then, after `songs.push({...})` closes, add a post-processing step to resolve missing YouTube URLs. Find the `const films: Film[] = [];` line (around line 496) and insert before it:

```typescript
      // Resolve direct YouTube URLs for songs missing one
      if (featuresConfig.youtubeDirect) {
        await Promise.allSettled(
          songs.map(async (song, i) => {
            if (!song.youtubeUrl) {
              const url = await resolveYoutubeUrl(song.artist, song.title);
              if (url) songs[i] = { ...song, youtubeUrl: url };
            }
          })
        );
      } else {
        // Fallback to search URL when youtubeDirect disabled
        songs.forEach((song, i) => {
          if (!song.youtubeUrl) {
            songs[i] = { ...song, youtubeUrl: generateYoutubeSearchUrl(song.title, song.artist) };
          }
        });
      }

```

- [ ] **Step 5: Build to verify**

```bash
cd /home/mike/works/Soundreel/backend && npm run build 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/analyze.ts
git commit -m "feat(backend): wire Shazam into IG pipeline; YouTube direct URLs via yt-dlp"
```

---

## Task 8: Per-slide carousel extraction

**Files:**
- Modify: `backend/src/services/aiAnalysis.ts`
- Modify: `backend/src/routes/analyze.ts`

- [ ] **Step 1: Add extractFromSlides to aiAnalysis.ts**

Add at the end of `backend/src/services/aiAnalysis.ts`:

```typescript
export interface SlideItem {
  type: 'song' | 'film' | 'book' | 'album' | 'text';
  title: string;
  artist?: string | null;
  director?: string | null;
  year?: number | null;
  notes?: string | null;
  sourceSlide: number;
}

export async function extractFromSlides(
  slideOcrTexts: Array<{ slideIndex: number; text: string }>
): Promise<SlideItem[]> {
  if (slideOcrTexts.length === 0) return [];

  const total = slideOcrTexts.length;
  const results: SlideItem[] = [];

  for (const { slideIndex, text } of slideOcrTexts) {
    if (!text.trim()) continue;

    const prompt = `Questa è la slide ${slideIndex + 1} di ${total} di un carosello Instagram.

Testo OCR estratto:
${text}

Estrai tutti gli oggetti culturali menzionati in formato JSON array.
Per ogni oggetto usa questo schema:
{"type":"song"|"film"|"book"|"album"|"text","title":"...","artist":null,"director":null,"year":null,"notes":null}
Usa null per campi sconosciuti. Se non c'è nulla di estraibile, ritorna [].
Rispondi SOLO con il JSON array, senza testo aggiuntivo.`;

    try {
      const response = await generateText(prompt, []);
      const text_resp = response.text;
      const jsonMatch = text_resp.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;

      const parsed = JSON.parse(jsonMatch[0]) as Array<Partial<SlideItem>>;
      for (const item of parsed) {
        if (!item.title) continue;
        results.push({
          type: (item.type as SlideItem['type']) || 'text',
          title: item.title,
          artist: item.artist ?? null,
          director: item.director ?? null,
          year: item.year ?? null,
          notes: item.notes ?? null,
          sourceSlide: slideIndex,
        });
      }
    } catch (e) {
      logWarning(`extractFromSlides slide ${slideIndex} failed`, { error: String(e) });
    }
  }

  logInfo('extractFromSlides', { slides: total, items: results.length });
  return results;
}
```

- [ ] **Step 2: Add import in analyze.ts**

In `backend/src/routes/analyze.ts`, the current aiAnalysis import (line 4) is:

```typescript
import { analyzeWithAi, AiAnalysisResponse } from '../services/aiAnalysis';
```

Change it to:

```typescript
import { analyzeWithAi, extractFromSlides, AiAnalysisResponse } from '../services/aiAnalysis';
import type { SlideItem } from '../services/aiAnalysis';
```

Note: `emptyMedia` is a local function in `analyze.ts` at line 597 — do NOT import it.

- [ ] **Step 3: Add per-slide extraction in IG pipeline after OCR step**

In `analyze.ts`, find the OCR block in the IG pipeline (around line 310–322). After `await appendActionLog(entryId, createActionLog('ocr_extract', {...}));`, add:

```typescript
          // Per-slide structured extraction for carousels
          const slideItems: SlideItem[] = [];
          if (featuresConfig.carouselStructuredExtraction && (localPaths?.slidePaths?.length ?? 0) > 0) {
            const frameCount = localPaths?.framePaths?.length ?? 0;
            const slideOcrTexts = ocr.perImage
              .slice(frameCount)
              .map((r, i) => ({ slideIndex: i, text: r.text ?? '' }))
              .filter((s) => s.text.trim().length > 0);

            const extracted = await extractFromSlides(slideOcrTexts);
            slideItems.push(...extracted);

            await appendActionLog(entryId, createActionLog('carousel_extraction', {
              slides: localPaths?.slidePaths?.length ?? 0,
              itemsFound: extracted.length,
            }));
          }
```

- [ ] **Step 4: Use slideItems in song building**

After the `const merged = mergeResults(audioResult, aiResult);` line (around line 468), add:

```typescript
      // Merge carousel slide songs into the result set
      const slideSongs = slideItems.filter((i) => i.type === 'song' || i.type === 'album');
      const slideFilms = slideItems.filter((i) => i.type === 'film');
```

Then in the song building loop, after the existing `for (const songData of merged.songs) { ... }` block closes (after `songs.push({...})`), add a second loop for slide songs:

```typescript
      for (const slideSong of slideSongs) {
        const spotifyResult = await searchTrack(slideSong.title, slideSong.artist ?? '');
        let addedToPlaylist = false;
        if (spotifyResult) {
          addedToPlaylist = await addToPlaylist(spotifyResult.uri);
        }
        const ytUrl = featuresConfig.youtubeDirect
          ? await resolveYoutubeUrl(slideSong.artist ?? '', slideSong.title)
          : generateYoutubeSearchUrl(slideSong.title, slideSong.artist ?? '');
        songs.push({
          title: slideSong.title,
          artist: slideSong.artist ?? '',
          album: null,
          source: 'ai_analysis',
          spotifyUri: spotifyResult?.uri ?? null,
          spotifyUrl: spotifyResult?.url ?? null,
          youtubeUrl: ytUrl,
          soundcloudUrl: generateSoundcloudSearchUrl(slideSong.title, slideSong.artist ?? ''),
          addedToPlaylist,
          sourceSlide: slideSong.sourceSlide,
        });
      }
```

In the film building loop (after the existing `for (const filmData of merged.films) { ... }` block), add a loop for slide films:

```typescript
      for (const slideFilm of slideFilms) {
        const tmdbResult = await searchFilm(slideFilm.title, slideFilm.year?.toString() ?? null);
        films.push({
          title: slideFilm.title,
          director: slideFilm.director ?? null,
          year: slideFilm.year?.toString() ?? tmdbResult?.releaseDate?.split('-')[0] ?? null,
          imdbUrl: tmdbResult?.imdbId ? generateImdbUrl(tmdbResult.imdbId) : null,
          posterUrl: tmdbResult?.posterPath ?? null,
          streamingUrls: generateStreamingUrls(slideFilm.title),
          sourceSlide: slideFilm.sourceSlide,
        });
      }
```

- [ ] **Step 5: Build to verify**

```bash
cd /home/mike/works/Soundreel/backend && npm run build 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 6: Build Docker image**

```bash
cd /home/mike/works/Soundreel && ./scripts/build.sh 2>&1 | tail -20
```

Expected: both frontend and soundreel images build successfully.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/aiAnalysis.ts backend/src/routes/analyze.ts
git commit -m "feat(backend): per-slide carousel extraction + slideItems merged into songs/films"
```

---

## Final: Push + Deploy

- [ ] **Push to remote**

```bash
git push origin main
```

- [ ] **Deploy via sentinel**

```bash
touch /home/mike/works/Soundreel/.rebuild
sleep 70
cat /home/mike/works/Soundreel/.rebuild-log | head -5
```

Expected: last line shows `status: ok`.

- [ ] **Smoke test Shazam endpoint** (dopo deploy)

```bash
# Verify new instaloader endpoints exist (will return 400 without params, not 404)
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:5000/shazam/recognize
# Expected: 400

curl -s -o /dev/null -w "%{http_code}" "http://localhost:5000/yt/url"
# Expected: 400
```
