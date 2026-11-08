# ADR-0011: Library search over the journal, the media server and configurable music folders

## Status
Accepted (implemented in v2.8.0)

## Date
2026-11-07

## Owners
Michele Mondora

## Related
- spec `2026-11-07-library-search-music-folders-design.md`; `2026-11-07-web-player-ux-design.md` (W8)
- `services/{musicSnapshot,musicFolders,librarySearch}.ts`, `routes/{library,config}.ts`

---

## 1. Context
Michele has music he downloaded in the past and cannot find ("Maestro Bassi": the folder `~/Music/Bassi Maestro/` is
on geekom's disk, in no journal entry). He wants one search over **all the library songs, all the media server and
all the local file system of Spooty plus other music folders configurable in the web configuration**.

## 2. Decision
1. **Three scopes + all**: `songs` (the journal's songs, as the app knows them), `media` (the catalogue of the box,
   `media_index`), `local` (Spooty's folder = `/music`, plus the configured extra folders).
2. **In-memory indexes with a pre-normalised search text** (artist, title, album, path): no new table. The box's
   catalogue is reloaded from `media_index` every 60 s; local folders are scanned in the background at start, every
   30 minutes and right after a configuration change. Matching is word-order independent, accent and case
   insensitive, AND across words ("Maestro Bassi" finds "Bassi Maestro").
3. **The extra folders are configuration** (a `config` row `music_folders`), editable by the admin only, and **must
   resolve inside the allowed roots**: the folders mounted read-only in the container (`/music` and
   `MUSIC_EXTRA_ROOTS`, default `/music-extra`). Paths are `realpath`-checked (so `..` and symlinks cannot escape),
   symlinks are not followed while scanning, the scan is capped (200 000 files, depth 12) and skips `._*`, hidden
   files and non-audio.
4. **The search returns the index, never files**: no endpoint serves an arbitrary path. A result carries where it is
   (path with a display root, or the box's URL); finding a file does not import it (a later, explicit step).
5. Mounting more host folders is a deploy decision (`docker-compose.yml`), not something the configuration page can do.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| A table for local files | A second thing to migrate and keep in step with the disk for a few thousand rows; memory is enough and a restart rescans |
| Let the page type any path | The backend would read anything the container can see; roots keep the blast radius to what was mounted for music |
| Mount the whole home read-only | Exposes `.env`, keys and everything else to an internet-facing service |
| Search the box by walking the SMB share | Minutes per walk (measured: over 90 s timeout); the DLNA catalogue is already in `media_index` |

## 4. Consequences
- ✅ One search finds a song wherever it is, and says where.
- ✅ The index is rebuilt from the disk: nothing to repair after a crash.
- ⚠️ Memory grows with the folders (about 200 bytes per file); the caps bound it.
- ⚠️ New top-level host folders need a compose mount and therefore a deploy.
