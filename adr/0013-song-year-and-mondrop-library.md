# ADR-0013: Release year per song, and a library endpoint for Mondrop

## Status
Accepted (implemented in v2.9.0)

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
   runs for every song, **from iTunes only**: the `releaseDate` of the result whose artist AND title both match (and
   only when the mention has an artist). A value outside 1900…current year+1 is discarded. The decade is derived
   (`year / 10 * 10`), never stored. When Deezer was the provider, iTunes is asked for the year alone
   (`enrichSongWithYear`); a song iTunes does not know well stays without a year ("Senza anno"): unknown beats wrong.
   *(The first draft took Deezer's album date; measurement showed that is wrong, see section 5.)*
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
| Deezer's album `release_date` (the first draft) | It is the date of an **edition** (remasters, reissues): wrong decade for half of the classics tried (section 5) |
| MusicBrainz `first-release-date` | Tried: one *recording* per version, each with its own later date (Bohemian Rhapsody: earliest candidate 1992, not 1975), and an HTTP 503 after two requests at 1/s. Not adopted |
| "Earliest year among all matching results" | Worse than the first strong match with iTunes (Billie Jean 1966, through a compilation of another recording); only fixed one of Deezer's four misses |
| Derive the year from the MP3 tags | Only for files we hold, and Spooty/YouTube files often have no year; the provider data covers every song |
| Compute facets on the phone from downloaded tracks only | Misses everything not yet synced: the opposite of "choose what to play" |
| Store the decade | Redundant; a derived value cannot disagree with the year |
| Fill years at request time | Network calls on the read path; a one-off background fill keeps reads local |

## 4. Consequences
- ✅ «Anni 80» works on web and phone with one data point; no new service.
- ✅ The phone can browse its whole library even before syncing it.
- ⚠️ About 785 iTunes requests once. iTunes allows roughly 20 a minute, so the pass takes about 50 minutes at the
  built-in 3 s pace; it stops by itself if the provider stops answering and tries again an hour later. Songs iTunes
  does not know well stay without a year (listed under «Senza anno»).
- ⚠️ A year the provider has wrong is still wrong; the strong-match rule and the one-source rule keep that rare.

## 5. Evidence for iTunes as the only source (measured 2026-11-08, manual probe, 8 well-known songs)
Year taken from the first result whose artist and title match; truth = original release year.

| Song | Truth | Deezer album date | iTunes `releaseDate` |
|------|-------|-------------------|----------------------|
| Queen, Bohemian Rhapsody | 1975 | 2005 ✗ | 1975 ✓ |
| Michael Jackson, Billie Jean | 1982 | 2009 ✗ | 1982 ✓ |
| Madonna, Like a Prayer | 1989 | 1989 ✓ | 1989 ✓ |
| Whitney Houston, I Wanna Dance with Somebody | 1987 | 1987 ✓ | 1987 ✓ |
| a-ha, Take On Me | 1985 | 2017 ✗ | 1985 ✓ |
| Kavinsky, Nightcall | 2010 | 2012 (decade ✓) | 2010 ✓ |
| Daft Punk, One More Time | 2000 | 2001 (decade ✓) | 2000 ✓ |
| Nirvana, Smells Like Teen Spirit | 1991 | 2011 ✗ | 1991 ✓ |

Decade right: Deezer 4 of 8 (the four misses are classics, exactly what "anni 80" is for), iTunes **8 of 8**. iTunes keeps
the track's original date even when the match is a compilation ("Greatest Hits", "Nevermind (Deluxe)").

**Side finding (same day):** Deezer's search with both fields (`artist:"…" track:"…"`) returns **no results at all** any
more, while a plain `artist title` query works. The last song enriched through Deezer is dated 2026-09-08; everything since
came from iTunes (the fallback), silently. Not changed here (the provider that now carries every song is the one whose
dates are right, and its covers are 100 px); recorded as a follow-up in the ROADMAP.
