# ADR-0030: The downloads follow the order in which the songs are about to play; the player says it, the engine arranges it, the server is not asked

## Status
**Accepted** (Michele, 11 November, after trying Mondrop 1.8.0 build 17, to the question «should the sync download first the songs that are about to play?»: «Sì. Sync scarica i brani in ordine di stanno per suonare.»; built in **build 18**, nothing changes on the server)

## Date
2026-11-11

## Owners
Michele Mondora

## Related
- spec `2026-11-10-mondrop-simplify-playlists-and-song-states-design.md` §10.5 (U16)
- ADR-0029 (the phone puts what it holds first: only the phone knows its own files), ADR-0018 (rule P: the clients talk only to SoundReel, which decides where a file comes from)
- `docs/mondrop-sync.md` (the manifest of a playlist, `prepare`, the file of a song)

---

## 1. Context
- Since build 16 the phone downloads, by itself and in the background, the missing songs of the playlist that plays (ADR-0029 made that silent). Until build 17 they went down **in the order of the playlist**, whatever the user was listening to: start a playlist of two hundred songs from the hundred-and-fortieth, or shuffle it, and the songs that would play in the next minutes were at the end of the line, to be streamed online while the ones nobody was about to hear came down first.
- Michele (11 November, to the question «if the sync should download first the songs that are about to play»): «Sì. Sync scarica i brani in ordine di stanno per suonare.»
- Only the phone knows what is about to play: the queue lives in the player (the order the user chose, a shuffle, a song added from Cerca) and changes at every skip.

## 2. Decision
1. **The player says what is about to play, the engine arranges what waits.** The order is the queue **from the song in play to its end and then, round the loop, from its first song** (`UpcomingOrder.keys`: the order they will play with the loop on; with the loop off the songs already passed are the last, good if the user goes back). The player reports it at every change — a song starts, the user skips, another queue starts, a song is added from Cerca — through one observer (`LocalAudioPlayer.observeUpcoming`, wired at launch to `SyncEngine.setUpcoming`, the way the playing playlist already is). Nothing is in play (a queue brought back paused at launch, the end of the last song, an empty queue): **no order**, and the queue of the downloads stays as it is.
2. **The engine puts what waits in that order** (`SyncEngine.setUpcoming`, `UpcomingOrder.arrange`, a stable ordering): the songs the order names first, in its order; the others after, as they were. It is **live**: a new order re-arranges what waits, and songs queued later — the server prepares a playlist in waves — take their place when they arrive.
3. **What has begun is never touched, and what the user asked for by name stays ahead.** Nothing is cancelled for a new order (the two downloads in progress finish). A download the user asked for — «Riscarica», «Riprova», «Scarica» in Cerca, the song that plays now (`front`) — is **pinned** (`QueuedJob.pinned`) and stays ahead of the order of the queue.
4. **«Limita» keeps the songs about to play.** The size question (ADR-0029, `SyncSizeGuard`) is asked over the songs in this order (`SyncEngine.inPlayOrder`), so «Limita a 2 GB» means *the 2 GB that play first*, then the order of the playlist, for the playing sync and for the check of the Settings alike; the text of the question says so.
5. **It applies to everything that goes through the engine**, whoever queued it: the playlist that plays, the check of the playlists (Settings), «Scarica» from Cerca. The rule of **which** playlists and songs are downloaded does not change (U2, U15, the skip-list).
6. **Rule P is intact**: the order decides *when* a file that SoundReel has ready comes down, never *from where*; no route, no field, no address changes.

## 3. Consequences
- **A listening that jumps pays off at once:** a shuffled playlist, a start from the middle, a skip far ahead bring down the next songs first; what the user is not about to hear waits.
- **The rows move a little differently:** the songs land in the order they play, so one that arrives goes up into the group «sul telefono» where its place in the playlist puts it (ADR-0029: the order of the lists is live), not only at the boundary.
- **The preparation on the server is not reordered.** A song that SoundReel has not prepared yet comes down when it is ready, and the server prepares a playlist in the order of the playlist (`prepare`), not in the order of the queue. Changing that is a field in the request and a server release: left open (ROADMAP).
- **One more thing in the queue file of the engine** (`pinned`, optional): a queue saved by an older build loads as before, and an older build reads a newer file ignoring it.
- **A few calls more:** the order is recomputed at every change of the queue (linear in its length) and the waiting jobs are written to their file only when their order really changed.

## 4. Alternatives considered
- **The server orders the downloads** (the phone sends the queue): rejected — a large request at every skip and a server that must know the player; the phone already has the file list and the queue.
- **Cancel the downloads in progress when the order changes:** rejected — a song half-way down would be thrown away for a few seconds of gain, and the engine keeps the resume data only for failures.
- **A second queue «urgent» next to the normal one:** rejected — two places to look at and to persist, for what one stable ordering does.
- **Only the next N songs first:** rejected — N is a number to choose and to explain; the whole order is as simple and has no cliff.
- **Download in the order of the playlist, as before:** it was the open question; Michele answered it.
