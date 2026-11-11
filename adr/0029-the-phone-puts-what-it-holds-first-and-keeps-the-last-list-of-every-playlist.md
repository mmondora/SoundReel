# ADR-0029: The phone puts what it holds first and keeps the last list of every playlist; the server still decides what the lists are

## Status
**Accepted** (Michele's requests of 11 November, trying Mondrop 1.8.0 build 16; built in **build 17**, nothing changes on the server)

## Date
2026-11-11

## Owners
Michele Mondora

## Related
- spec `2026-11-10-mondrop-simplify-playlists-and-song-states-design.md` §10 (U10–U15)
- ADR-0018 (rule P: the clients talk only to SoundReel, which decides where a file comes from), ADR-0020 (the server decides what the Home shows; the app draws it), ADR-0023 (the list of playlists is searched, sorted and paged by the server)
- `docs/mondrop-sync.md` (the manifest of a playlist: `GET /api/mondrop/playlists/:id/offline`, `prepare`)

---

## 1. Context
Michele (11 November, trying build 16): «Su Mondrop le playlist e i brani devono essere in ordine di scaricati in locale e poi online. E quando da homepage clicco sulla playlist devo vedere la lista e poter mettere in play. Nessun sync evidente, tutto automatico. Vanno privilegiati i file già scaricati.» And: «Voglio un check di consistenza con sync sulle impostazioni che verifica tutte le playlist locali o già scaricate se hanno tutti i file e scaricano quelli che mancano».
- ADR-0020 says the app «draws and computes nothing» of what the server decided. But **the server cannot know which files this phone holds**: only the phone can put «on the phone» before «online».
- The page of a playlist asked SoundReel and showed a spinner until the answer: with a slow or missing network (the car) the user saw no list and could not press play, even for songs that were on the phone.
- The sync was visible everywhere (a bar at the top of every page, a «Sync» button, counters), while the decision of 11 November is that the sync is automatic and quiet.

## 2. Decision
1. **The phone reorders what it draws by what it holds, and by nothing else.** Lists of playlists and songs (the cards of the Home, the whole list of playlists, the songs of a playlist and of a row of the Home) are a **stable partition**: on the phone → online → error, with the order the server gave inside each group (`LocalFirst`). Membership, titles, which sections exist and which songs a playlist has stay the server's. Search results, and the pages of an album, an artist, a genre or a year, are **not** reordered (relevance and the disc decide). The queue made from a playlist follows the same rule (`localFirst`).
2. **The phone keeps the last list of every playlist it reads** (`PlaylistManifestCache`: a copy of the server's answer, one small file per playlist next to the songs, outside the backups). The page is drawn from it in its first frame and SoundReel is asked again behind it; a failed reading leaves it alone; the next answer replaces it; a playlist deleted on the server is removed when the whole list is read. It is **a copy, never a decision**: nothing is shown from it that the server did not say, and nothing is sent to the server from it.
3. **The sync is silent, except in one place.** The download of the playlist that plays is automatic and not announced (`DownloadOrigin.automatic`); the pages show no sync. The Settings have **the check of the playlists the phone holds** (`PlaylistConsistencyCheck`), which is the user's way to ask for a sync: it reads what each playlist has now, asks SoundReel to prepare what it never prepared, and downloads what is missing, with **one** size question for the whole check.
4. **«The phone holds a playlist»** when all its songs are on the phone or at least half of them (of the songs the phone has seen in it). A playlist that merely shares a few songs with another one is not «downloaded», and a «Limita» or «Annulla» given to a playlist that was played is not overridden.
5. **Whether the mini player is shown is a fact of the phone** (a song was started in this run and has not ended: `LocalAudioPlayer.inPlay`); it hides while a page scrolls down (`MiniPlayerScrollRule`).

## 3. Consequences
- **Rule P is intact:** where a file comes from stays SoundReel's decision, no client reads the network or names a store, and no route changes (the check uses `GET /api/mondrop/playlists`, `GET …/offline` and `prepare`, the calls of the playlist that plays).
- **ADR-0020 is refined, not reversed:** the Home still draws what the server sent; the one thing the app does with it is to put what is on the phone first.
- **More state on the phone:** a JSON file per playlist (tens of kilobytes for a playlist of a hundred songs; the lyrics of a song, when the server sends them, are in it). It is rewritten at every reading of the playlist. A deleted playlist's file goes at the next full reading of the list.
- **A kept list can be a little behind** (a song the server removed an hour ago is still there until the answer comes, a second later when there is a network).
- **The server pages the list of playlists** (ADR-0023): the order «on the phone first» is exact over the pages the app has loaded; with more than a page of playlists, a playlist on the phone that is on a page not yet loaded comes up when that page is.
- **The order is live** (recomputed at every drawing): downloads land in the order of the playlist, so the boundary moves with them; a song downloaded out of order moves up.

## 4. Alternatives considered
- **The server orders, given the phone's files** (the phone sends the set of its song keys): rejected — a large request on every list, a server that must know the phone, and no answer offline.
- **Freeze the order while a page is open:** rejected — more state and edge cases for a small gain; the typical download does not move a row (the boundary moves instead).
- **Keep the lists in the index of the songs** (`offline-index.json`): rejected — the index is rewritten at every download.
- **A «Sync» button on each playlist page:** removed — Michele asked for no sync in sight; the check in the Settings does the same for all the playlists the phone holds.
