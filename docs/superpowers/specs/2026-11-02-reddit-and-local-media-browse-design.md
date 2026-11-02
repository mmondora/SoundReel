# Reddit extraction + local media browse

**Date**: 2026-11-02  
**Status**: Proposed  
**Depends on**: page pipeline (`pageExtractor`, `analyzeWebPage`), `/media/:entryId/:filename`, existing disk layout under `MEDIA_ROOT`

## Intent

1. Su **Reddit** (soprattutto link `/s/...`) ottenere testo del post, link all’articolo, eventuale contenuto dell’articolo, e una sintesi utile — non solo un summary corto.
2. **Rivedere offline** i media già scaricati: nell’inspector dell’entry e in una galleria/archivio dedicata.

## Evidence (prod, 2026-11-02)

- Reddit share links sono `source_platform: other`, pipeline page. Esempio `r/claudeskills/s/...`: summary 74 char, **0 links**, `rawLinks: []` hardcodato in `extractRedditRss`.
- Reel IG: ~97% con transcript; i “fallimenti” tipici sono Whisper `ok` con 0 chars (solo musica).
- `media_url` / `thumbnail_url` in DB puntano a **CDN Instagram** (scadono), mentre su disco esistono già `video.mp4`, `audio.wav`, `frame-*.jpg`, `thumbnail.jpg` servibili da `/media/<entryId>/...`.

## Goals

- Reddit: post text + comments utili + URL esterni estratti; se c’è un link articolo primario, fetch del contenuto e sintesi che lo includa.
- Inspector: player video/audio locale + navigazione frame passo passo, senza dipendere dal CDN.
- Archivio: pagina `/media` (o `/library`) con griglia dei salvataggi che hanno file locali, click → inspector/player.

## Non-goals

- Riscrivere tutta la pipeline IG per velocità in questo passo (resta backlog: latenza percepita).
- Sync wishlist streaming native (già fuori scope).
- Scaricare di nuovo da Instagram quando il file locale manca (solo mostrare cosa c’è; retry download resta il flusso “Retry” esistente).
- Trascrivere Reel solo-musica (Whisper vuoto è corretto).

## Architecture

### A. Reddit — extraction quality

```
share /s/xxx  →  resolve redirect  →  canonical.rss
                                      ├─ title, author, subreddit
                                      ├─ post HTML → text + **rawLinks**
                                      ├─ top comments (come oggi)
                                      └─ primaryOutboundLink? → extractPage(article)
                                           └─ merge article mainText into page payload
                                      → analyzeWebPage (prompt già webPageAnalysis)
```

**Changes**

1. `extractRedditRss`: parsare link `<a href>` dal content HTML del post → `rawLinks` (http/https, no reddit interni opzionali filtrabili).
2. Scegliere **primary article URL**: primo link esterno non-reddit / non-media image, o link con path “articolo” se unico.
3. Se c’è primary URL: chiamare `extractPage(articleUrl)` (HTML path, non Reddit). Se ottiene `mainText`, appendere sezione `## Linked article` al `mainText` Reddit e unire i suoi `rawLinks`.
4. Classificare `source_platform: 'reddit'` in `detectPlatform` (oggi finisce `other`) — cosmetico + filtri.
5. Prompt: nessuna nuova chiave obbligatoria; assicurarsi che `webPageAnalysis` usi tutto il `mainText` (già fa). Opzionale: alzare leggermente il budget testo per Reddit+articolo.
6. Persistenza: `results.summary` + `results.links` + eventuale `results.software` come già previsto dalla page AI. Caption/title del post in `caption` o summary header.

**Failure mode**: RSS fallisce → HTML fallback esistente; articolo fallisce → si tiene solo il post Reddit (log `reddit_article_fetch` error, non blocca).

### B. Local media URLs on entries

Preferenza di lettura (API o frontend):

| Asset | Path locale | Fallback |
|-------|-------------|----------|
| Video | `/media/<id>/video.mp4` | `entry.mediaUrl` CDN se file assente |
| Audio | `/media/<id>/audio.wav` | — |
| Thumb | `/media/<id>/thumbnail.jpg` | `entry.thumbnailUrl` |
| Frames | `/media/<id>/frame-NNN.jpg` | `results.slides[].imageUrl` |

**API nuova**

`GET /api/entries/:id/media` →

```json
{
  "entryId": "...",
  "videoUrl": "/media/.../video.mp4" | null,
  "audioUrl": "/media/.../audio.wav" | null,
  "thumbnailUrl": "/media/.../thumbnail.jpg" | null,
  "frames": ["/media/.../frame-001.jpg", ...],
  "slides": ["/media/.../slide-001.jpg", ...]
}
```

Implementazione: `localMedia.listEntryMedia(entryId)` (estende `localMedia.ts`).

Opzionale (stesso PR o subito dopo): in `listEntries`/`getEntry`, se esiste thumb/video locale, **sovrascrivere** i campi esposti al client così EntryCard smette di usare CDN morti senza cambiare ogni componente.

### C. Inspector — browse passo passo

In `EntryInspector` (e allineare `EntryCard` se serve):

- Se `videoUrl` locale → `<video controls src=local>` (non CDN).
- Strip frame: prev/next + thumbnails; click cerca nel video se possibile (metadata only in v1: mostra frame, non sync timestamp).
- Audio: player se c’è `audio.wav` e non c’è video, o controllo secondario.
- Mostrare badge “Locale” vs “Solo online” se manca il file.

### D. Archivio `/library` (o `/media-library`)

- Nuova route frontend + link in Header/nav.
- `GET /api/library?limit=&cursor=` → entry con almeno un file locale (query FS o cache: elenco dir sotto `MEDIA_ROOT` ∩ entries).
- Griglia: thumb locale, piattaforma, data, badge video/audio/frames.
- Click → `/?entry=<id>` (inspector home) o pagina dedicata con stesso player.

## Order of work

1. **Reddit rawLinks + article fetch** (qualità percepita alta, backend-only + test).
2. **`GET /api/entries/:id/media` + prefer local URLs** in getEntry/listEntries.
3. **Inspector player + frame strip**.
4. **Library page**.

## Testing

- Unit: `extractRedditRss` con fixture XML che contiene `<a href="https://example.com/article">` → rawLinks popolati.
- Unit: article merge appende sezione e non droppa il post se article 404.
- Unit: `listEntryMedia` con dir fake.
- Frontend: inspector mostra video locale quando API lo espone; library render empty state.
- Manuale: un link Reddit `/s/...` reale + un Reel con `video.mp4` su disco.

## Risks

- Fetch articolo può essere lento/bloccato (paywall, bot wall) → timeout stretto (8–12s), non fallire l’entry.
- Library su 1400+ dir: paginare, non caricare tutte le stat in un colpo sulla UI.
- Sovrascrivere `mediaUrl` in listEntries cambia comportamento CDN: solo se il file locale **esiste**.
