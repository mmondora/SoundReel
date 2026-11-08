# ADR-0020: The server decides what the Mondrop Home shows, in one route; the app draws it

## Status
**Accepted** (8 November 2026), built in SoundReel 2.18.0 (**in production since 8 November, 18:34**) and Mondrop 1.7.0 (build 9: on TestFlight since 8 November, 18:49, uploaded with an Admin API key). Michele chose it: «A, si giallo» (spec `2026-11-08-mondrop-home-spotify-design.md`).

## Date
2026-11-08

## Owners
Michele Mondora

## Related
- spec `2026-11-08-mondrop-home-spotify-design.md` (H1–H12)
- ADR-0018 (rule P: clients talk only to SoundReel; the server decides how many lists there are and where a file is), ADR-0019 (covers), ADR-0007 (listening events), ADR-0008 (dynamic playlists)
- `services/mondropHome.ts`, `routes/mondrop.ts`, `docs/mondrop-sync.md`

---

## 1. Context
Michele (8 November): «No aspetta, non mi piace il "cerca musica" - fai una proposta alla spotify». The first tab of Mondrop was the Player, a dead end when nothing is queued. The proposal he approved («A, si giallo») makes the first tab a **Home**: what to resume, the playlists, what was heard lately, what is new from the reels, with the search field on top. Everything on it except «Riprendi» (the phone's own queue) is information that lives on the server: the playlists, the listening events, the journal.

## 2. Decision
1. **One route, `GET /api/mondrop/home`**, answers with the **sections ready to draw**: `{ user, displayName, sections: [{ id, title, kind, playlists | tracks }] }`. The server decides which sections exist, their order, their titles and their content; a section with nothing in it is not sent. The app draws what it gets and ignores a `kind` it does not know.
2. **Built from what already exists**: the playlist summaries (`listPlaylists` + `resolveSummaries`), the counted plays of `play_events` (recent songs, and which songs were never played), the aggregated journal (new from the reels), and `buildTracks` for the tracks, so a track is the same object as in the library and in «Cerca» (state, `coverPath`, `downloadPath`, `mediaUrl: null`).
3. **Rule P holds**: no field names a store or an address; the Home never reads the network the phone is on.
4. **Reads only**: it queues no download and records nothing; it touches only the data of the key's user (`requireMondrop`).
5. **A failing section costs only that section** (logged); the route does not fail because «recent» did.
6. **«Riprendi» is not on the server.** The phone saves its own queue and reloads it, paused, at launch. Resuming on another device would need a position-sync protocol; nobody asked for it.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| The app builds the Home from `/playlists`, `/library`, stats… | Several round trips for the first screen, and the logic of «recent» and «new» would live in every client (rule P: the server decides what exists and what to show); a new section would need an app release |
| One route per section | The app would decide which sections exist and in what order; more requests; a section that fails leaves a hole the app must explain |
| «Riprendi» on the server (cross-device) | A protocol to send the position every few seconds, conflicts between two devices, privacy of what is playing; the single-device case is what was drawn |
| Compose the mosaic of a playlist on the server (one image) | Image work (and a cache to sweep) for a thing the app can draw from four covers it already knows how to ask for; `coverKeys` leaves the choice of the songs to the server |

## 4. Consequences
- ✅ One request for the front page; sections can change without an app update (a new `id` with an old `kind` is drawn by old apps too).
- ✅ Additive: a new route; installed apps never call it.
- ⚠️ The route is the sum of three queries and one `buildTracks` of at most 40 songs: bounded by the limits (12 playlists, 20 + 20 songs), no pagination.
- ⚠️ «New from the reels» needs the set of the songs the user has played: one more small query on `play_events` (indexed by user).
- ⚠️ The playlist mosaic uses the first four songs, not the first four with a cover.

## 5. Open questions
None. «Mostra tutti» for the two song rows, the iPadOS sidebar and resuming on another device are not asked for (spec §6).
