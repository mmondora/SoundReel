# Fritz media archive — design

Date: 2026-08-02
Status: approved (design), not implemented

## Goal

Make the media SoundReel already knows about playable on the TV and other
DLNA devices at home, using the FRITZ!Box's own media server as the serving
layer. Three payloads reach the Fritz USB storage:

1. the downloaded songs already sitting in `/home/mike/Music` (~500 MP3, 2.3 GB)
2. public-domain films fetched on demand from Internet Archive
3. a static HTML catalogue of every film in the journal, with links to the
   streaming platform that carries it

The GEEKOM stays the source of truth; the Fritz is a replica plus a DLNA
front-end. No new long-running service is introduced.

## Scope boundary

DRM-protected downloads (Netflix, Prime Video offline files) are explicitly
out of scope and will not be implemented. Those files are encrypted and
device-bound; extracting them means circumventing a technological protection
measure, which the platforms' terms forbid and EU law prohibits even for
personally purchased content. Netflix/Prime titles are represented in the
archive only as catalogue entries linking to the platform (section 5).

Legitimate additions to the film library remain possible outside this design:
personal rips of discs you own, DRM-free purchases, Creative Commons material.
They just land in the films directory by hand and get synced like anything else.

## 1. Architecture

```
GEEKOM (source of truth)                 FRITZ!Box 7530 — 192.168.178.10
┌───────────────────────────┐            ┌────────────────────────────────┐
│ /home/mike/Music    (ro)  │            │ //…/FRITZ.NAS                  │
│ /home/mike/Films    (rw)  │ rsync 04:00│  └── TESLA_MEDIA/  (USB, ~100GB│
│ SoundReel Postgres        │ ──────────►│       ├── Music/    free)      │
│   → watchlist.html        │ CIFS SMB3  │       │    └── SoundReel/ ←     │
└───────────────────────────┘            │       ├── Movies/              │
                                         │       │    └── SoundReel/ ←    │
                                         │       └── watchlist.html   ←   │
                                         │              ↓                 │
                                         │       DLNA media server        │
                                         │              ↓                 │
                                         │       TV / VLC / phones        │
                                         └────────────────────────────────┘
```

Outside the house the Fritz's own MyFRITZ!/VPN handles access — that is the
Fritz's job and this design does not touch it.

### Verified environment (probed 2026-08-02)

- The Fritz is **192.168.178.10**, not the default gateway: `192.168.178.1`
  is a MikroTik router, and the name `fritz.box` resolves to an unreachable
  public IPv6 address. The sync job must use the IP, never the hostname.
- Firmware FRITZ!OS 8.02 on a FRITZ!Box 7530.
- SMB exposes exactly one share, **`FRITZ.NAS`**, whose root holds both
  volumes: `TESLA_MEDIA/` (the USB stick) and `FRITZ/` (small internal
  storage — not a sync target). Dialect **SMB3**; SMB1 is disabled, so
  `vers=3.0` is required on the mount.
- Write access verified with user `geekom`: created a directory and a file
  under `TESLA_MEDIA/` and removed both. ~100 GB free.
- The stick is the car's Tesla media drive and already holds a `Music/` tree
  of 737 artist folders plus `Movies/`, `Boombox/`, `LicensePlate/`.
  **Consequence: never rsync onto `Music/` or `Movies/` directly** — with
  `--delete` that would wipe the existing library. Everything this design
  writes goes under a dedicated `SoundReel/` subdirectory of each, so the two
  collections coexist and `--delete` only ever prunes our own files.

### Fritz-side prerequisites (manual, one-off — done)

- USB storage attached with free space
- Media server enabled: Rete domestica → Mediaserver, with the USB volume
  selected
- SMB enabled: Rete domestica → Memoria (NAS) → *Accesso ai dati nella rete
  domestica tramite SMB* (off by default on FRITZ!OS 8, and required in
  addition to the per-user permission below)
- A FRITZ!Box user with a password and *Accesso ai contenuti NAS* granted,
  with write permission on the USB volume

## 2. Sync job

`scripts/fritz-sync.sh` — plain bash, committed to the repo, driven by a
systemd timer at 04:00 daily.

Steps, in order, each failing loudly and leaving the previous state intact:

1. read credentials from `/etc/soundreel/fritz-sync.env` (root-owned, mode
   0600, **never committed**: `FRITZ_HOST=192.168.178.10`,
   `FRITZ_SHARE=FRITZ.NAS`, `FRITZ_USER`, `FRITZ_PASSWORD`)
2. mount `//$FRITZ_HOST/$FRITZ_SHARE` on a temp mountpoint via CIFS with
   `vers=3.0`
3. `rsync -a --delete --partial`
   `/home/mike/Music/` → `TESLA_MEDIA/Music/SoundReel/` and
   `/home/mike/Films/` → `TESLA_MEDIA/Movies/SoundReel/`
4. regenerate and copy `watchlist.html` into `TESLA_MEDIA/` (section 5)
5. unmount, always, including on failure (trap)
6. append a one-line summary to `/var/log/soundreel/fritz-sync.log`

Properties that matter: idempotent (a re-run after a failure just resumes),
one-directional (the Fritz copy is disposable; nothing flows back), and
`--delete` scoped to the `SoundReel/` subdirectories so it prunes our own
removed files without ever touching the existing Tesla library.

Before syncing, the script asserts that the mountpoint really contains
`TESLA_MEDIA/` and aborts otherwise. Without that check, a stick swapped or
unplugged would leave the mount pointing somewhere unexpected and `--delete`
would act on the wrong tree.

Failure handling: any step failing aborts the run with a non-zero exit and a
log line. No retry loop — the timer fires again the next night. A partial
transfer is safe because `--partial` plus `-a` resumes cleanly.

## 3. Public-domain film enrichment

Follows the enrichment blueprint already used for books, places and Wikipedia:
a provider module, a `*_meta` column group, a hook, and mocked tests.

**Service** `backend/src/services/archiveEnrichment.ts`
- queries the Internet Archive advanced search API, `mediatype:movies`,
  matching on title plus year
- reuses the conservative matching helpers shared by the existing enrichment
  services (normalise, cleanQuery, isAcceptedMatch) rather than inventing new
  acceptance rules
- returns identifier, title, year, a details page URL, and the best available
  MP4 file reference — or nothing when there is no confident match
- TTL and throttling mirror the other providers

**Schema** migration `008_film_archive.sql` (008, not 007: the in-flight
wiki-enrichment branch already claims 007), adding to `film_meta`:
`ia_identifier`, `ia_title`, `ia_year`, `ia_page_url`, `ia_file_url`,
`ia_checked_at`, `ia_downloaded_path`. `init.sql` is updated in the same
change so a fresh database matches a migrated one.

**Download** `POST /api/films/:filmKey/archive-download` starts an async job
that streams the MP4 into `/home/mike/Films/<Title> (<Year>).mp4` and records
`ia_downloaded_path`. The container gets `/home/mike/Films` mounted rw. A
size ceiling and a duration guard keep a mis-matched 6-hour upload from
filling the disk. The file reaches the TV at the next nightly sync.

**UI** in `FilmCard`: when `ia_identifier` is set, an "Archive" badge-link to
the Internet Archive page (watchable there directly, free and legal) plus a
download button. Both are absent when there is no match.

Public-domain status stays a human judgement: the download is always manual
and the badge links to the source page so the licence can be checked before
committing anything to the archive.

## 4. What we are not building

No Jellyfin, no Navidrome, no transcoding, no bulk auto-download of every
matched film, no film player inside SoundReel. Music already has in-app
playback via the existing mini-player; the Fritz covers the television.

## 5. Catalogue export

`backend/src/services/watchlistExport.ts` renders a single self-contained
`watchlist.html` from the films already in Postgres: poster, title, year,
director, and the platform badge-links that `FilmCard` already computes
(`streamingUrls` plus API-reported `streamingOptions`). Netflix, Prime,
Disney+ and the rest appear here as links — the archive's answer to "where do
I watch this", with no file involved.

Rendering reuses the existing link-building logic rather than duplicating the
service list, so a platform added to `SERVICES` shows up in the export too.

The file is regenerated by the sync job (step 4) and lands next to the media
on the Fritz storage, reachable from any device in the LAN through FRITZ!NAS
and from outside through MyFRITZ!. The DLNA media server itself indexes media
files only and will not show the catalogue in the TV's media menu — that is
expected; the catalogue is for phones and browsers.

## Testing

- `archiveEnrichment`: mocked Internet Archive responses covering confident
  match, near-miss rejection, no results, malformed payload, and throttling.
  No live calls to Internet Archive, per project convention.
- `watchlistExport`: snapshot of the rendered HTML for a small fixture set,
  plus a check that a film with no streaming data still renders.
- Download endpoint: mocked stream, asserting path construction, the size
  ceiling, and that a failure leaves no partial file recorded in the database.
- `fritz-sync.sh`: verified by hand on the first run; not unit-tested.
