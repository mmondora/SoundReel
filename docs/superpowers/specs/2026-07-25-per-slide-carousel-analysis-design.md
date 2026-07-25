# Per-Slide Carousel Analysis Design

**Date:** 2026-07-25
**Status:** Approved
**Scope:** Give every slide of an Instagram carousel (and every keyframe group of a multi-page post) its own stored OCR text, visual description, explanatory paragraph and relevant links, rendered per slide in the entry detail view alongside the slide image.

---

## Problem

A carousel is currently flattened into one blob. Reference case, entry `5dcb8146` ("6 Best Streaming Apps"):

- `instaloader_download` → `slides: 8`
- `ocr_extract` → `withText: 8, mergedChars: 6554` — every slide carried text
- Stored result → `summary: ''`, `notes: 0`, `films: 0`, `links: 0`, `overlayText: null`

Two distinct failures compound here:

1. **Per-slide detail is discarded.** `ocrClient.ocrImages()` already returns `perImage[]` (`{path, text, error}`), but `analyze.ts` keeps only `ocr.merged`. The eight separate texts — one per streaming app — are collapsed into one 6.5k-character wall before any model sees them, and the per-slide structure is never persisted.
2. **On analysis failure the OCR text is lost entirely.** When the model returned no usable JSON, the old code returned `EMPTY_RESULT`, which has no `overlayText`, so 6554 characters of successfully extracted text were dropped. (Partially mitigated earlier today — the empty path now carries `overlayText` through — but the per-slide loss in (1) remains.)

The user-visible result: a carousel explaining six streaming apps produces an entry with no summary, no notes and no links, when the source text names Jellyfin, Plex, Kodi, JustWatch, Stremio and Reelgood explicitly.

## Goal

For entry `5dcb8146`, each of the eight slides shows its own paragraph and its own links (jellyfin.org, plex.tv, kodi.tv, justwatch.com, stremio.com, reelgood.com), next to the slide image — and the same structure works for any carousel (book lists, recipes, product roundups), not just streaming apps.

---

## What already exists (no new infrastructure needed)

| Capability | Where | Status |
|---|---|---|
| Per-image OCR text | `services/ocrClient.ts` → `OcrResult.perImage[]` | Returned today, discarded by the caller |
| Slide images on disk | Written by the instaloader service under `MEDIA_ROOT/<entryId>/` | Persist until the retention purge (`routes/admin.ts` cleanup cycle) |
| HTTP access to slides | `routes/media.ts` → `/media/:entryId/:filename` | Already serving |
| Per-slide LLM call | `services/aiAnalysis.ts` → `extractFromSlides()` | Exists but extracts only songs/films/books, output flattened into the top-level arrays |
| Vision model | `services/ollamaClient.ts` → `describeFramesWithVision()` | Video keyframes only; slides never reach it |

---

## Approach

### One model call for all slides, not one per slide

The per-slide texts are sent together in a single call that returns an array of per-slide results.

Rejected alternative — one call per slide (the shape `extractFromSlides` already uses): for an 8-slide carousel that is 8 calls instead of 1, and each slide is analysed blind to its neighbours. A slide reading "3. Kodi — open source, huge plugin ecosystem" is far better understood when the model can see it is item 3 of a list titled "6 Best Streaming Apps". Batching is both cheaper and higher quality here.

### Vision only where OCR came up short

Carousel slides are overwhelmingly text-heavy screenshots, and the vision model is slow (a measured `vision_describe` on video frames took 163s). Running moondream on all 8 slides would add minutes to every carousel for near-zero gain.

Vision therefore runs **only on slides whose OCR text is below a threshold** (`SLIDE_VISION_MIN_OCR_CHARS = 40`, matching the cascade's existing "is there real text here" bar) — i.e. genuinely image-only slides, where it is the only way to know what the slide shows.

### Slide links are *suggested*, not *extracted*

This is the one place where the link rule established earlier today is deliberately not applied. That rule — a link is kept only when its URL appears literally in the source text — exists to kill hallucinated URLs in *extraction*. Per-slide links are the opposite: the source says "Plex" and the whole point is to resolve that to `plex.tv`, a URL that by definition is not in the source.

So slide links:
- skip the source-text containment check,
- must still pass `isPlausibleUrl()` (rejects `https://...` and other placeholder shapes),
- are stored in a separate field from extracted links and rendered with a distinct marker, so "found in the post" and "suggested by the model" never look the same to the reader.

---

## Data model

`backend/src/types/index.ts` and `frontend/src/types/index.ts` (kept in sync as today):

```ts
export interface SlideLink {
  url: string;
  label: string;
}

export interface EntrySlide {
  /** 0-based position in the carousel. */
  index: number;
  /** Servable path under /media/<entryId>/, or null if the file is gone. */
  imageUrl: string | null;
  /** OCR text for this slide alone. */
  ocrText: string | null;
  /** Vision description — only populated for slides with little or no OCR text. */
  visualDescription: string | null;
  /** The model's paragraph explaining this slide. */
  summary: string | null;
  /** Model-suggested destinations for what this slide is about. */
  links: SlideLink[];
}
```

`EntryResults` gains `slides?: EntrySlide[]`. Optional, so every existing entry stays valid and the field is simply absent for non-carousel posts.

---

## Pipeline changes

### `backend/src/services/slideAnalysis.ts` (new)

```ts
export interface SlideAnalysisInput {
  entryId: string;
  slidePaths: string[];
  ocrPerSlide: Array<string | null>;
  caption: string | null;
}

export async function analyzeSlides(input: SlideAnalysisInput): Promise<EntrySlide[]>
```

1. Build the per-slide record: index, `imageUrl` derived from the on-disk filename, `ocrText` from the OCR result.
2. For slides under the OCR threshold, call the vision model for `visualDescription`.
3. Render the new `slideAnalysis` prompt with the caption plus every slide's text/description, and make **one** model call.
4. Parse the returned array, matching entries back by index; validate each link with `isPlausibleUrl` and each text field with the placeholder filter added earlier today.
5. Return `EntrySlide[]`; on any failure return the slides with OCR/vision populated but `summary: null, links: []` — the raw per-slide text is still a large improvement over today, so a model failure must not lose it.

Reuses the Ollama→Claude cascade via `analyzeWithAi`'s existing helpers, so an empty local result falls back to Claude exactly as the main analysis does.

### `backend/src/services/promptLoader.ts`

New editable template `slideAnalysis` (registered in `PromptsConfig`, so it appears in the Prompts settings page like the others), instructing: for each numbered slide, write a short paragraph explaining what it covers, and list the official destinations for anything named in it (apps, sites, products, books, films), as `{index, summary, links: [{url, label}]}`.

### `backend/src/routes/analyze.ts`

After the existing OCR step, when `slidePaths.length > 0`, call `analyzeSlides` with `ocr.perImage` sliced past the frame offset (the same `frameCount` slice `extractFromSlides` already uses), store the result as `results.slides`, and log a `slides_analyzed` action with `{slides, withOcr, withVision, withSummary, totalLinks}` for the Activity timeline.

The existing flat `songs`/`films` extraction from slides is left untouched — this adds a layer, it does not replace one.

### `backend/src/scripts/backfillSlides.ts` (new)

Backfills carousels analysed before this feature. Selects entries with no `results.slides` whose media directory still holds slide images, re-runs OCR and `analyzeSlides` from the files on disk, and updates the entry. Never re-scrapes Instagram. Same `--dry-run` / `--limit` flags and resumability as the existing backfill scripts.

---

## Frontend

`frontend/src/components/EntryInspector.tsx` gains a "Slides" section, rendered when `entry.results.slides?.length`:

- One block per slide: thumbnail (`imageUrl`, lazy-loaded, hidden on load error) beside the paragraph.
- Slide number label ("Slide 3 / 8").
- Links as chips, visually marked as suggested rather than extracted.
- OCR text behind a per-slide expander, collapsed by default — it is long and mostly useful for debugging.
- Slides with neither summary nor links are still listed, showing their OCR/vision text, so nothing silently disappears.

New i18n keys (IT + EN) for the section title, the slide counter, the suggested-links label and the OCR expander. New CSS for the slide block and thumbnail.

---

## Error handling

Follows the project's pipeline-resilience convention: OCR failure, vision failure, model failure and JSON parse failure each degrade to the richest structure still available (per-slide text without paragraphs, or no `slides` field at all) and are logged to `actionLog`. Slide analysis never fails the entry — the rest of the pipeline is unaffected.

## Testing

- `slideAnalysis.test.ts`: mocked model + OCR (no real calls, per CLAUDE.md). Covers the batched call receiving every slide's text; index-matching when the model returns them out of order or omits some; vision invoked only below the OCR threshold; placeholder and implausible links rejected; and the degraded path preserving OCR text when the model fails.
- `promptLoader.test.ts`: extend to assert the `slideAnalysis` template exists and renders slide texts.
- Frontend: no component tests exist for the inspector today; verification is typecheck plus a live check against entry `5dcb8146`, which must end up showing eight paragraphs with the six streaming-app links.

## Verification target

Entry `5dcb8146` after backfill shows eight slides, each with its own paragraph, and links covering Jellyfin, Plex, Kodi, JustWatch, Stremio and Reelgood.
