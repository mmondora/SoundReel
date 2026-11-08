# ADR-0010: A song can BE a file of the media server; the web plays it from there and never copies it

## Status
Accepted (implemented in v2.8.0)

## Date
2026-11-07

## Owners
Michele Mondora

## Related
- spec `2026-11-07-web-player-ux-design.md` (requests 5–8, S1–S8, W5–W8); `2026-11-07-mp3-store-media-server-design.md` §2.9
- ADR-0006 (origin on geekom, replica on the FRITZ!Box), ADR-0012 (Mac import)
- `services/{fileResolver,songStream,songLocation,mediaPublish,retireCopies}.ts`, `routes/{net,songs,mondrop}.ts`,
  `scripts/fritz-sync.sh`, `scripts/fritz-sync-request.path`

---

## 1. Context
2.7.0 "reused" a file of the media server by **copying** it onto geekom's disk the first time the song was played
(Nightcall by Kavinsky: a 6 MB duplicate in `~/Music/SoundReel/`). Michele: the web player must not copy it; it must
play it **from the media server, also from the internet**; a song that is not on the media server is downloaded by the
web and **put on the media server**; Mondrop on iOS keeps downloading and playing locally. Then: the web player has a
**source switch**, default "Internet" when used from outside, media server when used from the home network, switching
by itself according to the network. And: the Playlist manager must show the URL / file location of every song, and a
green dot must mean "on the file system or on the media server".

## 2. Decision
1. **The file of a song may be a file of the media server.** `song_files.source = 'mediaserver'`, `rel_path = NULL`,
   `media_rel_path` = path on the volume, `media_url` = direct URL, `published_at` set. Nothing is copied; the worker's
   "reuse" step adopts the box's file after a HEAD (size and date become the file's version). `existing` (the 2.7.0
   copy) is legacy.
2. **Serving**: `GET /api/songs/:key/file` and `GET /api/mondrop/songs/:key/file` pick an ordered list of origins and
   stream the first that answers. Web: media server first, then geekom's disk (`?from=media|fs` forces one). Mondrop:
   the disk first, then the media server. The media origin is a **proxy over HTTPS with `Range`** (the box is plain
   HTTP on the LAN and answers `206`), so seeking and resuming work from the internet; the browser never talks to the
   box. No origin → as before (302 to the Spooty UI).
3. **The source switch is the client's, the network is the server's**: `GET /api/net` says `internal` or `external`
   (Cloudflare headers, the same rule `/api/mondrop/net` used). The web player's `Auto` maps internal → media server,
   external → Internet (YouTube fallback); the user can force either; a manual choice is remembered per browser.
4. **The web puts downloads on the media server** without the backend ever writing to the box (ADR-0006): the
   YouTube download lands in geekom's store (origin and fallback), then the backend touches
   `<store>/.publish-request`; a systemd **user path unit** (`fritz-sync-request.path`) starts the existing
   `fritz-sync.service`, which pushes it within minutes instead of at 04:00; `reconcilePublished` then polls the box
   (HEAD) until it serves the file, and from then on the web plays it from there. Requests are debounced (20 s) and
   rate-limited (90 s).
5. **Mondrop on iOS is unchanged**: it downloads to the phone and plays locally (iOS only, for now).
6. **Where a song is** is explicit data: per song `fs`, `mediaServer`, `fsPath`, `mediaUrl` (and `streamUrl` in the
   state); the legacy flag `inLibrary` (the green dot) is exactly `fs || mediaServer`.
7. **The 2.7.0 copies are retired**: a ready `existing` row whose original on the box answers a HEAD with the same
   number of bytes loses its local file (inside the store folder only) and becomes a `mediaserver` row; one activity
   line says so. Anything unverifiable is left alone.
8. The mirror-exclude list of the first 2.8.0 drafts is gone: nothing is copied from the box any more.
9. **An unplugged USB drive is not "every file is gone".** The box's drive is also the car's: when it is out, the box
   keeps answering (DLNA catalogue of 1 entry instead of ~6 450, `404` for every file). Observed 2026-11-08. So:
   the media index is **not replaced** by a catalogue that collapsed below half of what is known (and flags
   `volumeMissing`, visible in `GET /api/admin/store`); a published file or a box-only song is dropped on a `404`
   only if a control file (one that verified in the same run, or a catalogue sample) answers; adopting a file
   whose `404` cannot be explained **waits** (`deferJob`, 10 min, no failed attempt) instead of downloading a
   duplicate from YouTube. Without these, an unplugged drive would turn every box-only song into a download job.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| Keep copying, hide the duplicate | Disk grows for nothing, "FS" lies, the nightly mirror sends it back as a duplicate |
| Browser plays the box's URL directly | HTTP on the LAN: blocked as mixed content from the HTTPS app and unreachable from the internet |
| Backend writes to the box over SMB | Forbidden by ADR-0006 |
| Decide the source in the backend | The user's intent (and the network of that one device) is per browser; the server only reports facts |
| Detect the network in the browser | It cannot reach the box and has no reliable signal |

## 4. Consequences
- ✅ No duplicates on geekom; the web plays a box file straight from the box, also remotely; one fewer thing for the
  mirror to undo.
- ✅ Every green dot is explained by a visible path or URL.
- ⚠️ Playing from the internet through the proxy uses the home upload bandwidth (hence "Internet" is the default there).
- ⚠️ The on-demand push needs the user-level path unit to be installed once (deploy step); without it the nightly
  run still publishes.
- ⚠️ A song that is only a file of the box turns back into a job if the box stops serving it (the periodic check
  resets it); its version for clients is `bytes-<box modification time>`.
