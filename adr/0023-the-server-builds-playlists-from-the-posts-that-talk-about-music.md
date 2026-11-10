# ADR-0023: The server builds playlists from the posts that talk about music: one per specific title, one rolling playlist per generic theme; the list of playlists is searched, filtered, sorted and paged by the server

## Status
**Proposed** (10 November 2026): Michele's request, designed with defaults he can correct (spec §5). **Built and tested** as SoundReel 2.20.0 and Mondrop build 12 (before the collections, ADR-0022); it waits for his OK to deploy and to upload the build, one by one. A preview on the real library (10 November, nothing written) gave 36 new playlists, 5 posts joining a theme and 1 post skipped as not about music, from the 42 posts that name at least two songs.

## Date
2026-11-10

## Owners
Michele Mondora

## Related
- spec `2026-11-10-auto-playlists-and-playlist-list-design.md` (P1–P11)
- ADR-0008 (dynamic playlists are rules evaluated at read time: these ones are **static**), ADR-0015 (the inbox announces; `info` messages expire after 3 days), ADR-0018 (rule P), ADR-0020 (the server decides what the Mondrop Home shows), ADR-0021 (the same shape: the server finds, keeps and serves), ADR-0022 (the collections)
- `services/playlists.ts`, `services/jobQueueWorker.ts` (`onAnalysisFinished`), `services/softwareExtraction.ts` (a dedicated second call that never fails the analysis)

---

## 1. Context
Michele (10 November): «voglio anche che se il reeel/post parla di musiche ( ecco le 5 musiche di natale ) mi venga creata una "playlist con il titolo adeguato" e le 5 musiche dentro. se il titolo è generico ( ecco gli album jaaz da ascoltare ... ) la play list è "jazz da ascoltare" e deve essere una sola. in tal caso le musiche sono ordinate per data di inserimento, le ultime per prime per facilitare gli ascolti. mondrop deve permettere di vedere queste play list. Se le play list diventano molte devo poterle selezionare/paginare/cercare, e di fianco al nome la data di creazione e un ordine di data. questo anche su mondrop.»

Today a playlist is only made by hand (or as a rule). Of 719 entries with songs only **94** have songs that come from the **content** of the post (the AI read them in a list) and only **42** have at least two; the other ~626 have only the audio fingerprint of a background track. The list routes answer with **every** playlist, by last change, with no search, no pages and no creation date.

## 2. Decision
1. **A post that talks about music becomes a playlist.** «Talks about music» = at least **2 songs whose source is the content** (`ai_analysis`, `both`, `music_list`); a single song or only the audio fingerprint does not. The local model, in the same call that gives the title, also says whether the post **really is about music** (`aboutMusic`): the «songs» of a post about films did make a playlist in the first trial on the real library, and now do not.
2. **A dedicated local call** (after the analysis, never inside it, JSON-Schema constrained, never Claude) gives `{ title, kind, existingTheme }`. **`one_off`** (a precise title: a number, an occasion, a year, an artist): one playlist per post, the songs in the order of the post. **`theme`** (a generic title: a genre, a mood, a habit): **one playlist per theme**; a new post of the same theme **joins it**, its songs go **on top** (newest first), a song already there is not added twice. The theme is found by the exact title the model chooses among the existing ones, then by a normalized key, then by word overlap.
3. **The title is cleaned** (no `#`, `@`, quotes, emoji, «ecco i»; 60 characters); if there is no good title the entry stays pending and **no playlist is made with a bad title**.
4. **They are ordinary static playlists** of the user with `origin = 'auto'`: Mondrop and the site already show, download, play, edit, share and delete them. Only an «automatic» label tells them apart.
5. **Once per entry and respecting the user:** `auto_playlist_runs` remembers every entry seen; a playlist the user **deleted is not recreated** (a theme registry keeps the key without a playlist); a **renamed** one keeps receiving its theme (the key is not the name).
6. **The unique indexes of the database** guarantee one playlist per theme and one per source entry, even if two runs overlap.
7. **The list is the server's job (rule P):** `GET /api/playlists` and `GET /api/mondrop/playlists` take `q`, `filter` (all, auto, mine, shared, dynamic), `sort` (created, updated, name, size), `order`, `limit` (max 100), `offset` and answer `total`; every playlist carries `createdAt`, `origin`, `autoKind`. **No parameters = the answer of today**, so the installed apps do not change. The site and Mondrop show the creation date beside the name, search, filter, sort and page.
8. **Announce in the inbox** (`info`, 3 days): once per new playlist, once per post that adds to a theme.
9. **The library already there** is handled by a script that is a **preview by default** (`--apply` only with Michele's OK), oldest entry first, `added_at` = the date of the post.
10. **Everything local;** kill switch `AUTO_PLAYLISTS=0`.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| A playlist for every post with songs | 626 of 719 are a background track: a playlist per reel with a trending song would bury the real ones |
| One playlist per theme only | «Le 5 musiche di Natale» is a list the user wants as it is; Michele distinguished the two cases |
| One playlist per post only | Michele wants **one** «Jazz da ascoltare» that grows |
| A new kind of playlist (rule or smart list) for the themes | The playlists he already has, shares and downloads work; a flag is enough |
| Newest-first by sorting at read time | The read order is `position, added_at` for every playlist and the user can reorder; putting the new songs at lower positions keeps one rule |
| Filtering and paging in the client | Against rule P, and the app would have to download every playlist first |
| Creating them at once for the whole library on deploy | A flood of playlists nobody saw; a preview and Michele's OK first |

## 4. Consequences
- ✅ Posts that list music become playlists by themselves, and a generic theme grows in one place with the newest songs first.
- ✅ Additive: new columns, two small tables, new optional parameters; installed apps keep working.
- ⚠️ The border between precise and generic is drawn by a local model and will sometimes be wrong; renaming, merging by hand or deleting fixes it.
- ⚠️ A post that names its songs only in the images depends on the OCR and the analysis.
- ⚠️ Many playlists may appear when the backfill is applied: hence the preview and the list tools (search, filter, sort, paging) that ship in the same release.
- ⚠️ Searching by playlist name only (not by song) in the first version.

## 5. Open questions
Confirm the defaults of spec §5 (P1–P11) when reading; the preview of the script on the real library will show how many playlists and themes the 94 posts make before anything is written.
