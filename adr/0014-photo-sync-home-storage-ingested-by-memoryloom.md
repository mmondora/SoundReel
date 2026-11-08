# ADR-0014: Phone photos go to home storage and are ingested by MemoryLoom; SoundReel only receives them

## Status
**Proposed** (nothing implemented; the decisions below are defaults to be confirmed, see the spec's open questions)

## Date
2026-11-08

## Owners
Michele Mondora

## Related
- spec `2026-11-08-mondrop-photo-sync-design.md` (P1–P9)
- ADR-0006 (origin on geekom, replica on the FRITZ!Box; the backend never mounts the SMB share), ADR-0009 (activity trail, durable device audit), ADR-0012 (a writer confined to its own folder)
- MemoryLoom (`~/works/memoryloom`): the photo archive already running on geekom

---

## 1. Context
Michele: Mondrop should sync photos too, like Flickr does, because Flickr has to be retired next year (2027).
- The phone's photos are uploaded to Flickr today. MemoryLoom already indexes the Flickr account (83,895 photos, 1,065 albums in September) with SHA-256 / EXIF / GPS, perceptual hashes, CLIP, faces, events and **cross-source duplicate detection**, and it can read local folders as extra sources. It does **not** hold the Flickr originals (only metadata, thumbnails and face crops).
- Mondrop already has per-user and per-device API keys, background transfers, a home / internet distinction and a deletion flow with double confirmation and a durable audit.
- geekom's disk has 199 GB free of 937 GB; the FRITZ!Box stick is 120 GB and doubles as the car's media drive. The Cloudflare tunnel caps a single request body (100 MB on the free plans).

## 2. Decision (proposed)
1. **SoundReel builds no photo gallery.** MemoryLoom is the archive (indexing, albums, duplicates, browsing). SoundReel's job is to *receive* photos from Mondrop, using the device authentication that already exists, and put them in a folder.
2. **One destination folder**, `<PHOTOS_ROOT>/<user>/<YYYY>/<MM>/<file>`, on home storage (not the FRITZ!Box stick). SoundReel's container gets it read-write, confined to that subtree with the same containment rules as the music store; MemoryLoom mounts it **read-only** as a local source. Where `PHOTOS_ROOT` lives is open (spec P1) and is decided after measuring the real size of the Flickr archive and of the camera roll.
3. **Resumable, content-addressed upload**, idempotent per user and SHA-256:
   `POST /api/mondrop/photos/uploads {sha256, bytes, filename, takenAt, kind}` answers `exists` (no transfer) or `new` with an upload id and offset; `PUT …/uploads/:id?offset=` appends a chunk (≤ ~50 MB); `POST …/uploads/:id/complete` checks the SHA-256, moves the `.part` file into place atomically and writes an activity line.
4. **Home only by default**, deciding with `/api/mondrop/net`; from the internet only if the user switches it on (chunks stay under the tunnel's cap).
5. **The phone's copy is never deleted automatically.** Freeing space works like the music "Spazio": only after the server confirmed the same hash on its own disk, with double confirmation and a durable audit line.
6. **Getting out of Flickr is a separate job, in MemoryLoom** (it already has the OAuth client and the metadata): download the originals and the album structure, verify, and delete nothing on Flickr until the copy is verified.

## 3. Alternatives considered
| Option | Why not (as the default) |
|---|---|
| A gallery inside SoundReel | Duplicates what MemoryLoom already does (and does better: faces, events, CLIP search) |
| Upload straight to a new MemoryLoom endpoint | A second device-authentication system; MemoryLoom sits behind Authelia only, with no API-key route for a phone |
| The phone writes to an SMB / WebDAV share (Files app) | No background sync, no dedupe, no verification, no audit |
| Keep a cloud service | The request is to leave one |
| **Immich** (self-hosted photo backup with an iOS app that backs up in the background) | A mature way to get most of this without writing a PhotoKit uploader. Not the default because the request is for Mondrop to do it and MemoryLoom already exists as the archive; **worth re-checking in phase F1** if the cost of a reliable background uploader on iOS turns out high |

## 4. Consequences
- ✅ One archive (MemoryLoom), one device-auth system (Mondrop's), no new gallery to maintain; cross-source duplicates with the Flickr photos are MemoryLoom's existing job.
- ✅ The upload is safe to interrupt: resumable, verified, idempotent.
- ⚠️ **Space decides everything.** The Flickr archive alone is probably hundreds of GB against 199 GB free: a disk has to be chosen (P1) before any of this is built.
- ⚠️ A folder of originals has no second copy today: a backup policy is part of the work, not an afterthought.
- ⚠️ iOS may keep an original only in iCloud ("Optimize Storage"): it has to be downloaded before it can be uploaded. Background execution does not guarantee a single session: the uploader must resume wherever it stopped.
- ⚠️ Photos are sensitive personal data (EXIF, GPS, faces): they stay inside the house, one folder per family member, private by default.

## 5. Open questions
See spec section 8: when exactly Flickr goes away, whether the old archive is in scope (F2), videos, where the storage comes from, and who else uploads.
