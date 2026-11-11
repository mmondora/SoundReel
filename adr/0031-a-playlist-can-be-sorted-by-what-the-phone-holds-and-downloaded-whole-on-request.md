# ADR-0031: A playlist can be sorted by what the phone holds and downloaded whole on request; the server says when each song was added

## Status
**Accepted** (Michele's request of 11 November, after Mondrop 1.8.0 build 18, with his answer «Tutti e due»; built in **build 19**, with one optional field from the server, **SoundReel 2.26.0**)

## Date
2026-11-11

## Owners
Michele Mondora

## Related
- spec `2026-11-10-mondrop-simplify-playlists-and-song-states-design.md` §12 (U17–U20)
- ADR-0029 (the phone puts what it holds first; the sync is silent except the check in the Settings), ADR-0030 (the downloads follow the order the songs are about to play), ADR-0023 (the server searches, sorts and pages the list of playlists), ADR-0018 (rule P)
- `docs/mondrop-sync.md` (the manifest of a playlist)

---

## 1. Context
Michele (11 November): «Voglio in tutte le playlist anche degli ordinamenti tipo : data di creazione, nome, stato ( locali o online ). Inoltre su una playlist vogli o anche il bottone 'scarica tutta'» — and, asked where, «Tutti e due»: the list of playlists and the songs inside each one.
- The list of playlists already sorted by date of creation, last change, name and size (the server does it, ADR-0023), but ADR-0029's «what is on the phone first» was a **fixed partition on top of every sort**: with «Nome» chosen, the playlists on the phone still came first.
- The songs inside a playlist had **no choice of order at all**: the phone-first partition was the only one.
- ADR-0029 removed the «Sync» button of the page of a playlist (Michele had asked for no sync in sight); the only way to ask for a download was the check in the Settings and, per song, «Riscarica».
- The server knows when each song was put in a playlist (`playlist_songs.added_at`) but the manifest did not say.

## 2. Decision
1. **«Stato» is a sort, and the others are pure.** The list of playlists has «Stato (sul telefono / online)» as its first sort and the one it opens on (so the screen is what it was in build 17 until the person chooses); «Sul telefono prima» and «Online prima» are its two directions. With any other sort the list is **exactly what the server sent** — no partition in front of it. «Stato» is the phone's own (only the phone knows which files it holds): the server is asked for the date of creation, the newest first, and the phone partitions; because a partition by state is only right over the whole list, **«Stato» loads every page** (100 at a time, the server's maximum) before it is done.
2. **The songs of a playlist have their own menu of orders** (`SongSort`): state (the start, as before), the order of the playlist, name, and date of addition, each with its direction. A tap on a song and «Suona» queue the songs **in the order on the screen**; «Mescola» keeps mixing each group and playing the phone's first (ADR-0029). The two choices (list, songs) are **kept** between launches (`SortPreferences`).
3. **The server says when each song entered a playlist.** `addedAt` (ISO, UTC) on every track of the manifest of a hand-made or automatic playlist, from `playlist_songs.added_at`; absent for a dynamic playlist (its rule decides what is in it), for the library, search and Home lists and for one song. **Optional and additive**: no new route, installed apps ignore it, a failure reading the dates only costs the dates. The app offers «Data di aggiunta» only when some song has a date.
4. **«Scarica tutta» is the person's own sync of one playlist** (`PlaylistDownloadAll`), a button on its page: the same sync as ever — SoundReel prepares the playlist, what is missing from the phone is queued, the songs the server is still preparing come as they turn ready — **with the question over the limit of the Settings** (a new gate for each press, so an «Annulla» is not remembered) and **announced when it ends** (`DownloadOrigin.sync`), because the person asked for it. It is there only when something could come, it says what it would bring and shows that it is at work, and it leaves out what the person took off the phone on purpose (that has «Riscarica») and what is stuck (it has «Riprova» and «Link»).
5. **ADR-0029 is amended in one point:** «A «Sync» button on each playlist page: removed» is no longer the whole truth. «No sync in sight» still holds for the **automatic** sync; the button the person presses returns under a name that says what it does.

## 3. Consequences
- **Rule P is intact.** The order and the button decide what the phone shows and when it asks; where a file comes from stays SoundReel's (the button calls the same `prepare` and downloads from the same place as every sync).
- **More requests for «Stato»:** the whole list in as many pages of 100 as it takes (one for most people). A list with a failing page keeps what arrived and says why.
- **A server release is needed for one of the four entries.** Everything but «Data di aggiunta» works with SoundReel 2.25.2; that entry appears when the 2.26.0 is in production (**with Michele's OK**, like every deploy).
- **The queue changes with the screen:** a tap plays the songs that follow on the screen, not those that follow in the playlist; the voice and Siri («metti la playlist X») keep the playlist order with the phone first.
- **Two places now ask the question over the limit on their own** (the playing sync, the Settings check and the button each wait for their answer): a small `SizeQuestionPresenter` serves the page; the other two keep their own copy of the same waiting.

## 4. Alternatives considered
- **Keep the phone-first partition in front of every sort:** rejected — «nome» and «data» would not be a name or a date; it was the reason for the request.
- **Sort the songs on the server:** rejected for «stato» (the server does not know the phone's files) and not needed for the others (a few hundred songs at most, already on the page).
- **Page «Stato» like the others and partition what was loaded:** rejected — a list «sorted by state» with an online playlist before a local one because the local one was on page two is wrong in a way the person sees.
- **«Scarica tutta» bringing back what the person removed on purpose:** left out — it would undo a decision, and the row has «Riscarica»; one line in the spec says how to flip it.
- **A «Sync» button as before:** rejected — Michele asked to see no «Sync»; this one says «Scarica tutta» and what it will bring.
- **Put the date of addition in a new route:** rejected — it is one field of a manifest the app reads anyway.
