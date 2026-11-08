# ADR-0019: The server finds the covers (in the file, or on the Internet) and serves them; the clients only ask SoundReel

## Status
**Accepted** (8 November 2026), built in SoundReel 2.14.0 and Mondrop 1.7.0 (build 8, never uploaded before: it carries «Cerca» too). Michele answered the open question on 8 November: the same for the lyrics («Sì, cercale su Internet»): a release of its own, with its own ADR.

## Date
2026-11-08

## Owners
Michele Mondora

## Related
- spec `2026-11-08-player-cover-art-design.md` (C1–C8)
- ADR-0018 (clients talk only to SoundReel), ADR-0013 (enrichment through iTunes), `services/songEnrichment.ts`, `services/songMeta.ts`, `services/offlineManifest.ts`

---

## 1. Context
Michele (8 November): «Nel player iOS voglio avere la copertina del disco o della canzone se non c'è trovale su Internet, come le parole.»

Today a track has `coverUrl` only when the journal enriched the song (Deezer/iTunes). A song that exists only as a file (the NAS, geekom: ADR-0018) has no `song_meta` row and no cover. The app loads the cover **straight from the provider's site** (an iTunes or Deezer address), keeps no copy, and draws a fake cover when there is nothing. The rule of the day (ADR-0018, rule P) is that a client talks only to SoundReel.

## 2. Decision
1. **The server finds the cover; the app asks SoundReel.** A new route, `GET /api/mondrop/songs/:key/cover`, answers with the image of any song the user can play (journal or file-only), or `404`. Every track carries `coverPath` (relative, like `downloadPath`). `coverUrl` stays for the apps already installed.
2. **Order of the sources:** the cover the server already knows (journal) → the cover **embedded in the MP3** (ID3 `APIC`) when it is almost square **and at least 300 px** (downloaders write a 160×160 photo of the artist into every file: measured on the library) → the **Internet** (iTunes, then Deezer), only with a strong match of artist and title → the embedded one anyway (small or cropped) → nothing (the app draws its own).
3. **Found once, kept.** The image is resized to 800×800 and kept on disk (`MEDIA_ROOT/_covers/`); «not found» is remembered for three days. Searches on the Internet pass through the same throttled queue as the enrichment (iTunes allows about 20 requests a minute) and two requests for the same song share one search.
4. **Only what the provider needs** goes out: artist and title (and nothing about the user). The server does not use the API key or any account of a provider.
5. **The phone keeps the covers it has seen**, so a downloaded song shows its cover offline.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| The app asks iTunes or Deezer itself | Against rule P; every client would need the matching rules, the throttle and a fix at every change of the providers' APIs; no shared copy |
| The server only sends the provider's address (as `coverUrl` does) | The app still talks to a third party, there is no copy (offline, and a dead address is a dead cover), and a song with no `song_meta` row has none anyway |
| Write the found cover into the MP3's tags | The library files are the family's (read-only for SoundReel except its own folder); a cover found on the Internet is a guess, not worth changing a file for |
| Store the images in Postgres | Binary blobs in the database for a cache that can be rebuilt; a folder on the media volume is simpler and has precedent (`tts/`) |
| A cover next to every row of a list | One request per row, and nobody asked for it (Michele: «nel player»); kept as an open question |

## 4. Consequences
- ✅ File-only songs get a cover; the app never shows a third party's address; one search per song, then it is local.
- ✅ Additive: a new route and a new field, nothing removed; installed apps keep working with `coverUrl`.
- ⚠️ The Internet is asked from geekom: iTunes's limits apply to the whole server (the throttle is shared with the enrichment, so a burst of covers can delay it by seconds).
- ⚠️ A match that looks strong can still be a different edition of the album: the cover is the album's, not always the exact edition.
- ⚠️ `MEDIA_ROOT/_covers/` is served by the existing `/media/:entry/:file` route like every folder of the volume (album art, not private; names are hashes). Nothing sweeps it: it can be emptied by hand and is refilled when songs are played.

## 5. Open questions
None left. The lyrics («come le parole»): Michele said yes, find them on the Internet when they are missing (spec sections 4 and 6); built later, with its own ADR (where the texts come from, what is kept, the providers' limits). A small cover next to every row of a list: no, only in the player.
