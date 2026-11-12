# ADR-0032: After a song of the SoundReel store is published, the box is its origin; geekom's copy is only the way in

## Status
Proposed (12 November 2026). The principle is Michele's («la fonte di verità diventa il media server e possono essere eliminate da geekom»); everything else here is Claude's call until he confirms. Nothing is built or changed yet. If accepted it amends ADR-0006 (decisions 1 and 2, and the scoped `--delete` of §3) for the files of the store folder; ADR-0010 and ADR-0012 stand.

## Date
2026-11-12

## Owners
Michele Mondora

## Related
- spec `2026-11-12-fritz-delta-publish-and-box-as-origin-design.md` (the request, the measurements D1–D7, the plan)
- ADR-0006 (origin on geekom, replica on the box), ADR-0010 (a song can be a file of the box; the unplugged drive), ADR-0012 (Mac import)
- `scripts/fritz-sync.sh`, `scripts/fritz-sync-request.path`, `services/{retireCopies,mediaServer,mediaPublish,songFiles,offlineManifest}.ts`

---

## 1. Context
Michele (12 November): «perché il sync è sempre complessivo e tutta music ? io vorrei solo il delta ( tipicamente nuove cose scaricate da Soundreel ) - inoltre dopo che da soundreel sono state scaricate su geekom e poi syncate con il media server, la fonte di verità diventa il media server e possono essere eliminate da geekom. Cosa non funziona ?»

What was measured (spec §3):

| Finding | Consequence |
|---|---|
| One script does everything: `rsync --delete` of all of `~/Music` (664 files, 3.2 GB), films, the watchlist export (~60 s) and two SMB `find`s; the path unit that fires after every download starts that same script | A single new song costs a ~1 min 50 s full run |
| 39 files retagged on geekom on 8 November (same bytes on the stick, but the stick keeps the old modification date of a replaced file) are «different» to rsync on every run | 158 MB of identical data is sent every run, also when nothing is new |
| All 138 `ytdlp` songs are `published` (the replica answers a HEAD with the same bytes) and all still have their local file (861 MB); `retireCopies` only handles the legacy `existing` rows | The condition Michele describes already holds for every song, and nothing acts on it |
| The mirror deletes: removing a store file on geekom would remove its replica at the next run (ADR-0006 §3) | Today the stick is a derived copy; `findBoxOriginal` refuses the replica of our own store as an «original» for that reason |
| A client's `version` is `<bytes>-<mtimeMs>`; for a row without a local file both come from the row, and `markMediaOnly` overwrites `mtime_ms` with the box's `Last-Modified` | Retiring a song the usual way would change its version and every phone would download it again |

## 2. Decision
1. The store folder on geekom is the **way in**, not the origin: a YouTube download lands there (`placeIntoStore`), as today.
2. **Publishing sends only the delta**: the rows the registry says are not yet published (`published_at IS NULL`), by name (`<store>/.publish-list`, written by the backend next to the existing sentinel), with no tree walk and no `--delete`. The on-demand run does nothing else: no films, no watchlist, no counts.
3. The mirror of the rest of `~/Music` becomes **additive** (`--ignore-existing`, never `--delete`): the box is never told to forget something geekom no longer has.
4. **Retirement.** When, in the same round, the row is `ytdlp`/`ready`/`published`, the file is inside the store folder, the replica answers a HEAD with the same number of bytes and the volume is present (a control file answers), the backend updates the row to a box-only song (`source = 'mediaserver'`, `rel_path` null, `media_rel_path`, `media_url`) **keeping the `bytes` and `mtime_ms` of the local file** (the `version` clients compare does not change), and only then removes the local file.
5. Everything ADR-0010 already does for box-only songs applies from then on: served from the box (proxy with `Range`), re-checked every 6 hours, turned back into a job only when the volume is there and the file is not, never because the drive is unplugged.
6. The backend still never writes to the box (ADR-0006 §2, ADR-0010 §4): the scripts and the Mac do.
7. Retirement is off by default (`RETIRE_PUBLISHED=1`) and the one-off for the songs of today is a preview-first script. The script change goes **first**: with the mirror still deleting, a retirement would make the replica disappear.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| `rsync --remove-source-files` in the publish script | It removes the file the moment it is sent, before the backend has seen the box serve it: the row would still name a missing file and turn into a YouTube download (`vanished`). The backend owns the store folder and the registry, so the backend removes |
| Keep the mirror with `--delete` and never remove locally | The status quo: 861 MB and growing on geekom, a full job per download, the 158 MB loop |
| `--size-only` or `--checksum` for the whole library | `--size-only` stops the loop but still walks everything and still deletes; `--checksum` reads 3 GB over SMB on every run |
| Delete the local copy after N days | Not what was asked, and time proves nothing: the condition is that the box serves the same bytes |
| Let the backend write to the box | Forbidden by ADR-0006 (a sleeping box would stall the API) |

## 4. Consequences
- ✅ A new song reaches the box in seconds and costs ~5 s of work; the nightly run stops re-sending 158 MB and stops deleting.
- ✅ geekom stops growing with every song (861 MB freed for the 138 songs of today).
- ⚠️ The stick becomes the **only copy** of a retired song. If it is lost the song comes back as a job, and YouTube may not have it or may give another version (24 of 170 registry rows are `no_source` today).
- ⚠️ While the stick is out of the box (it is also the car's drive, ADR-0010 §9) the server cannot serve the retired songs: Mondrop cannot download them (the ones already on the phone play), the web player falls back to YouTube.
- ⚠️ A file already on the box and then **changed** on geekom (a tag rewrite such as the one of 8 November) no longer reaches the box by itself; it is pushed by name.
- The `version` of a song never changes by retirement: no phone downloads anything again.
