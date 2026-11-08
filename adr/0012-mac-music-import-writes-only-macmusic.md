# ADR-0012: The Mac imports its music straight onto the box, into `Music/SoundReel/_MacMusic/` only

## Status
Accepted (the folder protection is live in `scripts/fritz-sync.sh`; the import itself is run from the Mac)

## Date
2026-11-07

## Owners
Michele Mondora

## Related
- spec `2026-11-07-mac-music-import-design.md`; prompt `docs/mac-music-import-prompt.md`
- ADR-0006 (origin on geekom, replica on the FRITZ!Box) — this ADR adds one exception to its "written only by fritz-sync.sh"

---

## 1. Context
Michele wants all the music of his Mac's external disk (`/Volumes/MacBook M1 - disk2/Music`) on the media server,
converted when needed without losing quality, without duplicates, with every tag the media server can use, and asked
for a prompt for the Claude Code on the Mac. The box's USB stick (`TESLA_MEDIA`) is also the Tesla's media drive
(`Boombox`, `LicensePlate`, `ASSChime.wav`, `Movies`, other artists in `Music/`), and the project rule is to write
only in `Music/SoundReel` and `Movies/SoundReel`. ADR-0006 made the box a replica written only by the nightly
`rsync --delete`, which would erase anything that is not in `~/Music` on geekom.

## 2. Decision
1. **The Mac writes directly** over SMB (user `geekom`, share `FRITZ.NAS`) into one folder:
   `TESLA_MEDIA/Music/SoundReel/_MacMusic/`. Nothing else on the stick may be touched; no deletions.
2. **The nightly mirror protects it**: `scripts/fritz-sync.sh` excludes `/_MacMusic/` (an excluded path is also
   protected from `--delete` on the receiving side; proven with a temp-dir rsync). The backend still never writes to
   the box and never mounts the share (ADR-0006 stands for everything it does).
3. **No second library on geekom**: the files live only on the box. They enter the DLNA catalogue, then
   `media_index` (hourly); from there the backend adopts them without copying (ADR-0010) and the library search finds
   them under "Media server".
4. **The credentials never travel**: the prompt carries the IP, share, user and folders but **not** the password,
   which Michele types into the macOS dialog.
5. **Quality, duplicates, tags** are rules of the prompt (spec M4–M6), not of the backend.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| Import into `~/Music` on geekom and let the nightly sync replicate it | Doubles the storage on geekom and puts a large foreign library into the SoundReel scan; Michele asked for the media server |
| Write to the `Music/` root of the stick | Outside the allowed area of a drive the car uses; mixes with 736 existing entries |
| Let the backend write to the box (SMB mount in the container) | Forbidden by ADR-0006 (a dead box would hang the container) |
| Skip the exclusion and re-run the import after each night | The nightly `--delete` would erase tens of GB every night |

## 4. Consequences
- ✅ A big import never touches geekom's disk or the SoundReel database; resumable from the Mac.
- ✅ The destination is one reserved folder name: a folder `~/Music/_MacMusic` on geekom must never exist.
- ⚠️ A second writer exists now (the Mac). It is a human-run, one-off job with a plan and an explicit OK gate.
- ⚠️ The box can take minutes to hours to index the new files; the import report says so and nothing is forced.
- ⚠️ Not covered: the ~3 000 macOS `._*` shadow files already on the stick (outside `Music/SoundReel`): cleaning them
  is a deletion on the Tesla drive and needs an explicit OK.
