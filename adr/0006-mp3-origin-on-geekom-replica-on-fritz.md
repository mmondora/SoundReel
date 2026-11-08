# ADR-0006: MP3 origin on geekom, replica and media server on the FRITZ!Box

## Status
Accepted (implemented in v2.7.0; supersedes the "backend writes straight to a mounted Fritz share" design of
`docs/superpowers/specs/2026-11-07-mp3-store-media-server-design.md` §2.3).

## Date
2026-11-07

## Owners
Michele Mondora

## Related
- ADR-0005 (reference architecture), `docs/mondrop-sync.md` (client contract)
- `backend/src/services/{songFiles,musicStore,songDownloader,fileResolver,mediaServer,mediaIndex}.ts`, `scripts/fritz-sync.sh`

---

## 1. Context
Playlist Sync must leave an MP3 for every song, produced on the server (not on the phone), without Spotify
credentials in SoundReel, and the home FRITZ!Box (USB stick, DLNA) is the media server for the LAN (and later for
the TV and the car). The first design had the backend container write the files straight onto the Fritz over SMB,
through a persistent mount.

What was found while building it:

| Finding | Consequence |
|---|---|
| A persistent CIFS mount needs a one-off `sudo` change to `/etc/fstab` (`user`-mounts are `hard` and `noauto`); with the default `hard` option a sleeping box leaves processes stuck in uninterruptible I/O. | The Node process would share that fate: one dead box can stall file I/O of the whole API. |
| The box serves a file over HTTP (`206`, `Range`) the moment it is written, from a URL derived from its path. It does **not** list it in its DLNA index for minutes to hours. | Delivery cannot depend on the box's own index. |
| `scripts/fritz-sync.sh` already mirrors `~/Music` to `Music/SoundReel/` on the stick every night, as an unprivileged user, with a bounded mount. | The replication mechanism exists and works; it only needed fixing (a `Stale file handle` on the watchlist copy failed it every night since August). |
| `/music` (host `~/Music`) is what the library scan, the web player and the "downloaded" flags already read. | Anything written under it is seen by all of them for free. |

## 2. Decision
1. **Origin on geekom.** Songs fetched from YouTube are written under the library (`~/Music/SoundReel/`, mounted
   read-write at `/music/SoundReel`; everything else in `/music` stays read-only). Spooty's files and ours are
   one library.
2. **The Fritz holds a replica**, written only by the nightly mirror (`scripts/fritz-sync.sh`: rsync to
   `Music/SoundReel/`, scoped `--delete`, `*.part` and `._*` excluded). The backend never mounts the share and
   never writes to the box.
3. **The backend talks to the box over HTTP only**: DLNA `Search` to keep a copy of its catalogue (`media_index`,
   used by "reuse first"), and a `HEAD` on the direct URL to verify a replica before any client is pointed at it
   (`song_files.media_url`). A song missing locally but present on the box is **copied over HTTP**.
4. **Clients get two addresses per song**: `downloadPath` (the SoundReel proxy, always valid, works through
   Cloudflare) and `mediaUrl` (the box, LAN only, only once verified). iOS prefers `mediaUrl` at home and falls
   back to `downloadPath`.
5. **One row per song** (`song_files`) is both the record of where the file is and the download queue; the queue
   is drained by an in-process worker (two at a time, priority first), reuse before YouTube.

### 2.1 Addendum (2026-11-07): files copied FROM the media server — SUPERSEDED by ADR-0010 (no copy, no mirror-exclude list)
A song that already exists on the box is **copied** to geekom when it is first played or synced (reuse before
YouTube; Michele's rule: «SoundReel la copia dal Fritz»). That copy must not travel back and become a duplicate on the
stick, and clients should keep using the original. So: `song_files.media_rel_path` records the **original's** path on
the volume and `media_url` is published at once (verified at that path by the usual HEAD); the backend keeps
`SoundReel/.mirror-exclude` (an rsync `--exclude-from` list of every `source = existing` file) and the mirror skips
them. The web UI says so: `FS+MS` for that song, not just "downloaded".

## 3. Consequences
- No sudo step, no hung container; a sleeping box costs a timeout. Everything is testable with temp directories.
- A new song reaches the box at the next mirror run (nightly), so its `mediaUrl` appears the next morning; until
  then every client uses the proxy path. A shorter mirror cadence is a timer change, not a design change.
- `--delete` stays, scoped to `Music/SoundReel/` and guarded against an empty source; deleting a song locally
  removes its replica, and the verification drops the stale `media_url`.
- If a persistent mount is ever wanted (e.g. the stick moves to geekom as the media server, see ROADMAP), only
  `MUSIC_STORE_DIR` and the replica root change; the data model does not.

---

## Addendum 2026-11-07 (v2.8.0)

- **Reuse is no longer a copy.** The 2.7.0 worker copied a box file onto geekom's disk; since 2.8.0 the song simply
  *is* the box's file and the web plays it through a proxy — see ADR-0010. The "published at once, mirror-exclude list"
  mechanism of the first 2.8.0 drafts was dropped with it.
- **Second writer, one folder.** The Mac may write `Music/SoundReel/_MacMusic/` on the box (ADR-0012); the nightly
  mirror excludes it. The backend still never writes to the box.
- **On-demand publish.** After a download, the backend touches `<store>/.publish-request`; a user path unit starts
  `fritz-sync.service` (ADR-0010). Still no SMB mount in the container.

