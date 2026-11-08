# ADR-0018: Clients talk only to SoundReel; one search across the journal, the library and the NAS, and tracks that exist only as files can be played

## Status
**Accepted** (8 November 2026): Michele answered the open questions (spec section 6). Built in steps: SoundReel 2.13.0 (search, library-only songs, no `mediaUrl`), Mondrop 1.7.0 (Cerca), then SoundReel 2.14.0 (the web play plan).

## Date
2026-11-08

## Owners
Michele Mondora

## Related
- spec `2026-11-08-mondrop-search-spotify-style-design.md` (S1–S8)
- ADR-0011 (library search for the web), ADR-0013 (choosing what to play), ADR-0017 (one identity per thing), ADR-0010 (the box is the file; its direct-LAN download by the app is superseded here), ADR-0006 (the MP3 store), spec `2026-11-07-web-player-ux-design.md` (rules W5–W7, the «Sorgente» switch: superseded here, pending Michele's confirmation)
- `routes/mondrop.ts` (`/api/mondrop/library`), `services/offlineManifest.ts` (`findSong`, `resolveSongServing`), `services/librarySearch.ts`, `services/mediaIndex.ts`, `services/musicSnapshot.ts`

---

## 1. Context
Michele (8 November): in Mondrop he could not find Bassi Maestro, whose music is on the NAS (45 audio files) and on geekom (10), and he finds the search «molto confusa»: «posso cercare anche senza avere/fare playlist, alla spotify».

Two facts of the code explain it. (1) Mondrop's «Libreria» reads `GET /api/mondrop/library`, which is `getUserSongs`: **only the songs of the journal**, that is, what arrived from a post or a link. Bassi Maestro has 0 songs in the journal. (2) **Serving starts from the journal too**: `findSong` looks the key up in `getUserSongs`, so a key that is not there answers `song_not_found` and cannot be played, downloaded or put in a playlist. The web already searches three places (ADR-0011) but returns locations of files, not playable tracks, and is not reachable with a Mondrop key.

## 2. Decision
0. **The rule (P): clients talk only to SoundReel.** Michele (8 November): «la logica di avere 3 liste o store [sia] server in sounreel e non in mondrop. Quello deve andare sempre e solo su soundreel», and «Idem il player web (locale o in internet)». Mondrop **and** the web player, at home **and** over the internet, ask SoundReel and nothing else; that there are three stores (journal, local folders, NAS), how they are searched together, which one holds a file and from where it is served, is **server logic**. A client has no store address, no DLNA, no folder path and no network test to choose a source, and a response has no field that names a store.
   - **Today it is broken in two places**: the app's `DownloadURLChooser` puts the media server's LAN `mediaUrl` first when `home` (from `GET /api/mondrop/net`), so at home it talks to the NAS directly; the web player's `effectiveSource` picks media server / disk / YouTube in the browser from `GET /api/net` and plays from YouTube over the internet.
   - **Consequences**: the server stops sending `mediaUrl` (installed apps fall back to `downloadPath`, always valid for a `ready` track); Mondrop 1.7.0 drops the direct path and the `home` choice; the web player drops its own network-based choice (`GET /api/net`, `effectiveSource`) and follows the server's play plan; for the web player the **server decides what plays** (a *play plan*, `GET /api/songs/:key/play`): from the internet YouTube, always; at home the file if it is there, otherwise YouTube while the server prepares it, then the file (Michele's answer, spec S11). The browser follows the plan and makes no network test of its own; the «Sorgente» switch is only a preference sent to the server. An automated test fails the build if a client source reintroduces a store address or a network-based source choice.
1. **A new read-only route, `GET /api/mondrop/search`**, answers with tracks, artists and albums from **three sources at once**: the user's journal, the local folders (geekom's `~/Music`, the extra folders) and the NAS catalogue (`media_index`). The matching rules are ADR-0011's (word order, case and accents do not count); the identity of a track is its **`songKey`** (artist + title, the same key as playlists, `song_files` and `song_meta`), so the same song found in several places is **one row**; the response does **not** say which store holds it (rule P). The existing `/api/mondrop/library` and the offline manifests do **not change** (installed 1.5/1.6 apps keep working).
2. **A track that exists only as a file is playable.** `findSong` falls back, for a key that is not in the journal, to a **library-only song** rebuilt from the local snapshot or `media_index` by that key. It is accepted by the Mondrop and web song routes (`/songs/:key`, `/file`, `/download`, the sync) **only if the file exists**. A song of this kind is **never downloaded from YouTube** and **creates no entry in the journal** (ADR-0017: one thing, one voice). **No `song_files` row is written for it**: its file is resolved at read time from **the exact file its library entry names** (geekom's disk and/or the box, ADR-0010: the song IS that file), never from a loose name match, because the match key strips «(2019 Remastered)» and would play one version's file for another's row. The playlist route `POST /api/mondrop/playlists/:id/songs` accepts such a key too (a playlist holds keys).
3. **The library (geekom, NAS) is common to the family; the journal part of the search is per user.** As with the web «Cerca in», the folders are not private.
4. **The app gets one «Cerca» tab** (S2–S5): a field always visible, results as Brani / Artisti / Album, one tap plays, no playlist needed, browsing (Album, Autori, Tipi, Anni, Playlist) as shortcuts in its empty state; the old «Libreria» tab is absorbed.
5. **Nothing is written to the NAS or to the files**: search and playback are read-only; files are served with `Range` as today.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| Create a journal entry for every library file | Pollutes the journal with things that never came from a post, breaks «una cosa = una voce» and the meaning of «Dal post», and would need an import of ~7,000 files |
| Extend `/api/mondrop/library` with a `scope` | The Libreria contract (facets, paging, manifests) is in installed apps; mixing sources there would change what 1.5/1.6 see. A new route is additive |
| Mondrop (or the web player) talks DLNA or HTTP to the box directly, or chooses the store | Against rule P: works only on the home LAN, knows nothing of geekom's files, gives no stable key for playlists, offline and stats, and puts store logic in every client |
| Search only on the phone over a downloaded catalogue | ~8,000 tracks to keep fresh on every device, and it still would not play anything |
| Let any key be served | An attacker or a bug could ask the server to fetch arbitrary things; a key is accepted only if a file for it exists in the library or the NAS |

## 4. Consequences
- ✅ «bassi maestro» finds the 45 + 10 tracks (deduplicated) and a tap plays them; no more playlists or «dimensions» to understand.
- ✅ Additive: no change to existing routes, schema or installed apps.
- ⚠️ A library-only song has no post, no mentions, and no year or genres (tags are read from names and from the box's catalogue): it shows as «Senza anno» in the Anni browse.
- ⚠️ The NAS part is as fresh as `media_index` (refreshed hourly, and empty while the stick is out, as on 8 November until 12:58) and the local part as the folder snapshot.
- ⚠️ `play_events` and other keyed tables will receive keys that are not in the journal: every reader of those tables must tolerate a key with no song behind it.
- ⚠️ The step that retires our own copies once the box has the original (ADR-0010) now excludes the box's replica of our own store folder from the candidates (`findBoxOriginal`): without it a copy could be taken as its own original and the only file of a song deleted.
- ⚠️ Mondrop 1.7.0 is a new TestFlight build; the server change is needed first (a new app on an old server shows an empty Cerca).

## 5. Open questions
None. Answered by Michele on 8 November (spec section 6): «Cerca» replaces the «Libreria» tab; a tap plays and queues the following tracks; the Playlist tab stays as it is; for the web player, «se siamo su internet parte da youtube, sempre. se siamo in casa parte da youtube nel frattempo».
