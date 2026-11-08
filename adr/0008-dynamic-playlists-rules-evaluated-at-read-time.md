# ADR-0008: Dynamic playlists are rules evaluated at read time

## Status
Accepted (implemented in v2.8.0)

## Date
2026-11-07

## Owners
Michele Mondora

## Related
- `docs/mondrop-stats.md` §4; spec `2026-11-07-listening-stats-dynamic-playlists-design.md` (D6, D9)
- ADR-0007 (the events they read), ADR-0006 (what Sync downloads)
- `backend/src/services/{dynamicPlaylists,playlistResolver}.ts`, `backend/src/utils/genres.ts`

---

## 1. Context
Michele asked for playlists like "most played at night" and "7 to 8 in the morning". The songs of such a playlist
change as he listens, and Mondrop's Sync should always download what is true *now*.

## 2. Decision
1. A dynamic playlist is a **row in `playlists` with `kind = 'dynamic'` and a JSON `rule` (v1)**: scope (me /
   family), period, local time window (may cross midnight) and weekdays, order (most / least played, recent, never
   played), limit, minimum plays, genres, downloaded-only.
2. The song list is **computed whenever the playlist is read** (web, Mondrop list and manifest), from `play_events`
   restricted to the songs **the viewer** can see; a 60 s in-memory cache absorbs polling. Nothing is materialised.
3. Static operations (add / remove / reorder) on a dynamic playlist answer `409 playlist_is_dynamic`; the rule is
   edited with `PATCH`.
4. "Tipo" means **genre**. Deezer/iTunes spell it many ways, so genres go through one canonical mapping
   (`Alternativa` → `Alternative`, `Rap/Hip Hop` → `Hip-Hop/Rap`, …) used by the web filters, the dashboard and the
   rules alike; unknown names pass through untouched.
5. Presets (night, morning, lunch, evening, weekend, last month, recent, never played, family week) live on the
   server and are offered to the UI.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| Materialise the list and refresh it with a timer | Stale between runs, extra writes, a second source of truth next to `playlist_songs`. |
| Evaluate on the phone | The phone does not have the family's events nor the journal; rules would diverge per client. |
| Free-form SQL / expression language | Security and support burden for a handful of useful parameters. |
| Reuse static playlists and re-fill them | Mixes user-edited and generated songs; nothing says which is which. |

## 4. Consequences
- Every sync downloads the current selection; songs that left a dynamic playlist become orphans on the phone and are
  removed only on explicit request.
- One aggregate query per read (indexed); fine at this scale.
- A shared dynamic playlist shows each viewer **their own** most-played songs (scope "family" aside) — documented, and
  the reason `scope` exists.
- The rule schema is versioned (`v`); a future v2 can coexist.
