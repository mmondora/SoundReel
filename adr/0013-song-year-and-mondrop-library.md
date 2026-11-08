# ADR-0013: Release year per song, and a library endpoint for Mondrop

## Status
Accepted (to be implemented in v2.9.0)

## Date
2026-11-08

## Owners
Michele Mondora

## Related
- spec `2026-11-08-player-selection-and-filters-design.md` (X1–X6)
- `song_meta`, `services/songEnrichment.ts`, `routes/mondrop.ts`

---

## 1. Context
Michele wants to choose what to play on the web and on the phone — a playlist, an album, a song, or everything of a
kind — filtering by genre, album, author and **years** («anni 80»). Genre, album and author are already known per song;
the **year** is not stored anywhere, and the phone only knows songs through the playlists it syncs, so it cannot offer
albums, artists or decades beyond them.

## 2. Decision
1. **`song_meta.release_year` (INT, nullable) + `release_year_checked_at`.** Filled by the enrichment that already
   runs for every song: Deezer's album `release_date` (the album is already fetched for the genres), else iTunes
   `releaseDate`. A value outside 1900…current year+1 is discarded. The decade is derived (`year / 10 * 10`), never stored.
2. **A one-off background fill** for the songs already in the library: low rate (about one request per 0.6 s), only songs
   with `release_year_checked_at IS NULL`, marked checked even when no provider has a date so it never repeats.
3. **Mondrop gets the facets**: tracks in manifests and `GET /api/mondrop/songs/:key` carry `album`, `genres`
   (canonical names) and `year`; `GET /api/mondrop/library` lists all the songs the user can see (state included) with
   filters and facet counts, paged, so the phone can browse albums, artists, genres and decades beyond its playlists.
4. **The web uses the same facets** from `GET /api/songs` (`meta.releaseYear`); no second filtering engine on the
   server: filtering stays a pure client function shared by the Playlist manager and the player.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| Derive the year from the MP3 tags | Only for files we hold, and Spooty/YouTube files often have no year; the provider data covers every song |
| Compute facets on the phone from downloaded tracks only | Misses everything not yet synced: the opposite of "choose what to play" |
| Store the decade | Redundant; a derived value cannot disagree with the year |
| Fill years at request time | Network calls on the read path; a one-off background fill keeps reads local |

## 4. Consequences
- ✅ «Anni 80» works on web and phone with one data point; no new service.
- ✅ The phone can browse its whole library even before syncing it.
- ⚠️ About 785 provider requests once, spread over minutes; songs the providers do not know stay without a year
  (listed under «Senza anno»).
- ⚠️ Year quality is the provider's (a compilation album date can be later than the song's); good enough for decades.
