# ADR-0017: One identity per thing, and every card links back to the post it came from

## Status
**Accepted** for the entry rules, the collapse of software and films, the post links and the merge script (spec D1–D4, D6); 2.11.0 is deployed and the merge was run on 8 November (9 groups, 9 entries united, 1700 to 1691, backup kept outside the container). The treatment of song versions (D5) is **Accepted** since Michele answered on 8 November («Versione di»: separate cards that link to the original); it is built in 2.12.0 (built, not yet deployed).

## Date
2026-11-08

## Owners
Michele Mondora

## Related
- spec `2026-11-08-no-duplicates-and-post-links-design.md` (D1–D6)
- `services/urlNormalize.ts`, `utils/db.ts findEntryByUrl`, `routes/songs.ts aggregateSongs`, `routes/films.ts`, `routes/notes.ts`, `routes/software.ts`, ADR-0011 (`normKey`)

---

## 1. Context
Michele's rule of 8 November: entries, songs, software and films must not be duplicated (at most a link to the original), and the cards of the media found must link to the post they were extracted from ("5 songs were extracted from the same link").
Measured on the real journal that day (1,700 entries): 9 entries are the same Instagram post saved under different URL forms; the software page shows 7 names more than once (10 extra cards: one product with an official page, a right repo, a repo the model invented, `#readme` variants, and placeholder URLs such as `https://github.com/...`); 14 films exist under more than one spelling or year; 8 songs exist under decorated spellings. Songs, films and notes already collapse by key into one card with its mentions, but a mention is only `{ entryId, createdAt }`: no card carries the post's URL.

## 2. Decision
1. **A thing has one identity, derived from its name, and the cards are built from it at read time** (D1, D4). Software: the normalized name. Film: the normalized title with equal or missing year. **Song: unchanged** (decided while building): its identity stays `songKey(artist, title)`, which is also the key of playlists, `song_files` and `song_meta`, so merging two spellings at read time would hide an entry that a playlist or a file holds by name; the 8 decorated spellings stay separate cards until D5 is decided. No data migration: the original items stay in the entries, so the rule can be refined without rewriting history.
2. **Every mention carries its post** (D3): `{ entryId, createdAt, sourceUrl, sourcePlatform }` for songs, films, notes and software, and the card shows a link per mention (three, then "+N"). The count still opens the entry in the journal.
3. **An entry is unique per user and post, and its creation is atomic** (D2): a lock per (owner, post key) around "look up, then create" in every creation path, so two shares at the same instant make one entry. The existing lookup (clean URL, then Instagram shortcode) stays.
4. **The 9 historical duplicates are merged once**, by `scripts/mergeDuplicateEntries.ts` (dry run by default, a backup, Michele's OK to run it): the oldest entry with data is kept; songs, films, notes, software, tags, links, shares and the action log are united (the keeper's copy of the same song, film or software is completed, never overwritten); every table that points at an entry (`entry_shares`, `job_queue`, `inbox_items`, `share_intents`, `spooty_requests`, `logs`) is moved to the keeper before the duplicate is deleted (`job_queue` has no cascade). One transaction per group, rows locked and read again inside it, a group with a job running is skipped. Nothing outside the journal is touched (D6): MP3 files, playlists and the library stay as they are; the duplicate's `/media/<id>/` files are not copied and go with the orphan cleanup after 7 days. The backup is written to `/tmp` in the container, never under `/data/media` (served over HTTP, and cleaned after 7 days), and copied out by hand.
5. **Software has one main link** (D4): a verified forge repository, else the official site, else any; the others are kept as "other links"; placeholder URLs are dropped; tags merge.
6. **Versions with different audio** (instrumental, slowed, live, remix, acoustic, cover, karaoke) stay separate cards that carry "Versione di <original>" with a link to the original (D5, accepted by Michele on 8 November; the link sits next to the "×N menzioni" count, which still opens the journal entry). Built in 2.12.0 as `versionOf` on each aggregated song (`services/songVersions.ts`, read time, song key unchanged): 94 of 796 songs on the real journal, 9 of them linked to an original.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| A unique index on a stored canonical URL key | Right in principle but needs a boot-time backfill with per-platform logic that does not live in SQL, and a merge before the index exists; the lock plus the existing lookup removes the race with no schema change. Can be added later |
| Collapsing at write time (rewriting stored songs, films, software) | Loses the original spelling and cannot be undone; read-time collapse keeps history and lets the rules improve |
| Collapsing every version of a song | A slowed or instrumental version is a different audio file the playlists may want on purpose |
| Collapsing decorated song spellings at read time | The song key is also the key of playlists, files and metadata: it is an identity others depend on, not a display detail |
| Keeping the entry with the most content when merging | Everything is folded in anyway, so the choice only decides the id and the date; the oldest id is the one a Telegram reply, a share or a bookmark may already hold |

## 4. Consequences
- ✅ One card per thing, and a way back to every post it came from.
- ✅ No schema change and no loss of data; rules can be tuned without a migration.
- ⚠️ The aggregators and the cards change shape (mentions grow two fields): older clients ignore the new fields.
- ⚠️ The merge of the 9 entries deletes rows: it runs only after a backup, a dry run and an explicit OK. Dry run on the real journal (8 November): 9 groups, every keeper already has its thumbnail and as many slides as its duplicate, no job queued or running, no share, inbox item or Spooty request on any duplicate.
- ⚠️ A keeper with no thumbnail or slide images of its own would stay without them (the duplicate's folder is cleaned up after 7 days); the plan prints an `ATTENZIONE` line for each such group (none today).
- ⚠️ Read-time collapse costs a little at every read of the software and film lists (hundreds of items).

## 5. Open questions
None. Answered by Michele on 8 November (spec section 5): song versions are separate cards linked to the original ("Versione di"), the 9 duplicates are merged after the deploy, and the post link sits next to the "×N menzioni" count.
