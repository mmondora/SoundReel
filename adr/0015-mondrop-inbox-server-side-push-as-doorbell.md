# ADR-0015: The Mondrop inbox lives on the server; push is only the doorbell

## Status
**Accepted** — implemented in SoundReel 2.10.0 (backend) with Mondrop 1.6.0 (app). The push (option A) is built and **dormant**: it turns on when the APNs key exists. The defaults for the spec's open questions are adopted (see §7) and stay open to correction.

## Date
2026-11-08

## Owners
Michele Mondora

## Related
- spec `2026-11-08-mondrop-share-inbox-design.md` (SH1–SH7, IN1–IN7)
- multi-user spec `2026-11-07-multi-user-authelia-design.md` (`entry_shares`, `FAMILY_USERS`), ADR-0009 (activity trail)
- `services/jobQueueWorker.ts` (`sendResultToTelegram`), `routes/share.ts`, `services/linkIngest.ts`

---

## 1. Context
Michele wants three things from the Mondrop share sheet: a notification back "just like Telegram"; the ability to share an entry with `archi`, `sara` or both **on the server**; and, in the app, the list of received shares plus a list of notifications that vanish after a few days **except errors**.
- Today `POST /api/share` answers at once (`queued`) and the analysis runs with `notify: false`: nothing comes back. Telegram, for the links sent there, gets a message at the end of the analysis (summary, counts, link).
- Entry sharing already exists on the server (`entry_shares`, `POST /api/entries/:id/share`, web UI); the three family users are fixed (`mike`, `archi`, `sara`).
- A share extension is killed seconds after it finishes; the analysis takes up to two minutes. So the result cannot come back through the extension.
- The app has no push entitlement. Server push (APNs) needs the paid Apple Developer Program; team `5NZADC9YQ2` **is** one (Michele, 2026-11-08).

## 2. Decision (proposed)
1. **The inbox is stored on the server and is the source of truth.** A table of items per recipient (`inbox_items`: user, kind, level `info|error`, title, body, optional entry, payload, created / read / expires). The app reads it (`GET /api/mondrop/inbox`) when opened, in the foreground and at every sync, so it works **with no push at all**.
2. **Push is only a doorbell.** When an item is created the backend may ring the user's registered devices (APNs). The payload says "something arrived" and carries the item id; the app fetches the content from the inbox. A failed or missing push loses nothing.
3. **Retention, as Michele asked:** informational items expire **3 days** after creation (`expires_at`), read or not; **errors never expire**: they stay until the user dismisses them or the same link later succeeds (the error item is then closed automatically). A cap (100 errors per user, oldest out first) bounds growth. A daily sweep deletes the expired rows.
4. **Received shares are not notifications.** "Condivisioni ricevute" is read from `entry_shares` (the source of truth for visibility) plus a per-recipient `seen_at`; it does not expire while the share exists. Only the *notification* about a new share expires.
5. **Share options travel with the share.** `POST /api/share` accepts `playlistId` and `shareWith`; a small `share_intents` row (entry, user, playlist, recipients, status, result) makes the work that depends on the analysis (adding the songs to the playlist, ringing the sender and the recipients) idempotent and restart-safe. A song known at once (Spotify, Shazam) is handled at share time; the rest when the analysis completes.
6. **Delivery goes through one sink interface** next to the existing Telegram one: the worker creates the inbox item first, then asks each channel (push, Telegram) to announce it. Telegram-originated jobs keep their Telegram reply unchanged.
7. **Authorisation:** the inbox endpoints use the Mondrop key and only ever touch the key owner's items; `shareWith` accepts only `FAMILY_USERS`, never the sender, and only for entries the sender owns.

## 3. Push options
**Update 2026-11-08:** Michele confirmed the Apple team is a **paid** Developer Program ("si account apple è a pagamento"), so option A is available. What is still missing is an APNs auth key (`.p8`) created by Michele in the Apple Developer portal (Keys); its Key ID goes in the configuration, the file stays in `~/.config/soundreel/apns/` (0600) and never in the repository, a log or the chat. Until it exists the push stays off and the inbox works without it.
| Option | What it needs | Verdict |
|---|---|---|
| **A. APNs push from the backend** | Paid Apple Developer Program; an APNs auth key (`.p8`) kept outside the repository (0600, like the FRITZ credentials) with its Key ID and Team ID; the Push Notifications capability and `aps-environment`; a device token registered by the app; Node's built-in `http2` and `crypto` (no new dependency). Development builds use the sandbox environment | The real "like Telegram": works with the app closed or force-quit. **Recommended once the account is confirmed paid** |
| B. Background `URLSession` long-poll | No paid account. The extension starts a background session with a shared container; the system relaunches the containing app when it completes; the app posts a *local* notification | Works only while the system chooses to relaunch the app (not after a force-quit); the server's wait is capped by Cloudflare's ~100 s. A fallback, not a plan |
| C. Telegram as the channel | Nothing on iOS: `notify: true` with the user's linked Telegram chat | Immediate and trivial, but the message arrives in Telegram, not in Mondrop. A possible interim, not what was asked |
| D. The app polls only | Nothing | The inbox without any doorbell: still useful, the minimum |

Because of decisions 1–2 the inbox, the lists and the badge ship first and work with D; A (or B) is added on top without changing the data model.

## 4. Alternatives considered
| Option | Why not |
|---|---|
| Notifications only as push, no stored list | Lost if push fails or is off; no list of errors to come back to; no expiry rule to apply |
| Store notifications on the phone only | A second phone, or a reinstall, loses them; the server cannot clear an error when the link later succeeds |
| Make received shares expire like notifications | Michele separated the two: the list of received shares stays, the notices about them go |
| A new "friends" model | The three family users and `entry_shares` are enough |

## 5. Consequences
- ✅ One source of truth; every channel (app, push, Telegram) is a view of it; an outage of any channel loses nothing.
- ✅ The work Michele asked for can start without waiting for the Apple answer.
- ✅ `entry_shares` is reused as is; the web's sharing UI and the app's list agree by construction.
- ⚠️ Two new tables (`inbox_items`, `share_intents`), and a sweep job to maintain.
- ⚠️ Push adds a secret (the `.p8` key) and a device-token table; neither may ever reach the repository or a log (names only, never values).
- ⚠️ Sandbox and production APNs tokens differ: a build installed from Xcode registers a development token.
- ⚠️ The extension has no network time to spare: the playlist list must come from a cache shared through the App Group.

## 6. Open questions
See spec section 6: what else about the sheet is disliked; playlists for film links; whether recipients can reply; whether 3 days is right; whether re-sending a known link notifies again. (The Apple account is paid: answered.) Defaults adopted in §7.

## 7. What was built (2.10.0)
- **Tables** (migration 019, mirrored in `init.sql`): `inbox_items` (per user; soft delete through `removed_at`), `share_intents`, `push_devices`, `usage_counters`, and `entry_shares.seen_at` (everything shared before this release is backfilled as already seen, so the first launch does not show the history as new).
- **Soft delete and `removedIds`.** A removal (user delete, an error closed because the same link succeeded, expiry, the 100-error cap) sets `removed_at`; `GET /api/mondrop/inbox?since=` returns the ids removed since, so a second device drops them without rereading everything. The hourly sweep removes expired information, forgets removals older than a week and drops finished intents (14 days; 30 if never finished). Errors are never swept. `since` is read 2 s early and the server takes `serverTime` before reading, so a row written during an answer is never skipped.
- **One badge.** A received share counts once: an unread `share_received` notice stands for its share, and a share whose notice is read, deleted or expired counts only while unseen. Seen and read are one act in both directions (opening the share reads the notice, reading or deleting the notice sees the share).
- **Share intents.** `POST /api/share` always records an intent (entry, sender, playlist, recipients, comment); one open intent per entry and sender. It completes when the entry is ready — at once for Spotify (songs known) and Shazam, when the analysis ends for everything else, when Spooty writes the tracks for a Spotify link that had none. The row gate (`status = 'pending'`) means a share is announced exactly once even if the worker and the watcher finish together; a crash before the gate leaves it pending, never half-announced. A safety net runs every 10 minutes (`resolveStuckIntents`): an open intent older than 10 minutes whose entry has no job left in the queue (the analysis ended before the intent was recorded, or the process stopped in between) is completed from the entry as it is now, or failed when the entry ended in error; an entry still being worked on is left alone.
- **What rings.** Only what arrives *after* the sheet is closed: an outcome that completes at share time is stored as already read and never pushed (the sheet showed it); a playlist problem is stored read too (the answer carried it). The recipients' notice always rings, only for people never told about that entry (a `share_received` notice in any state counts as told): a share that failed the first time and works the second tells them the second time, and sharing again changes nothing for the ones already told.
- **Errors.** One per link: a new one replaces the old, and a successful share of the same link (same stored `source_url`) closes the ones waiting. A failure with no retry left, an AI that never gave a readable answer, an unreadable Shazam page and an unusable playlist each leave an error carrying `reason`, `sourceUrl` and the `options` the share started with, so «Riprova» works from any device. The first expired-Instagram-session failure leaves a `retrying` error (the queue keeps trying for days) that closes by itself when the link finally goes through.
- **Playlist rules.** Only a static playlist the sender owns takes songs; the check runs at share time (for the answer) and again at completion (it may have changed), and the error is raised after the link's errors were closed — an error raised before would be closed by the very completion that follows.
- **Authorisation.** Every inbox route is bound to the owner of the key; another user's id is `404`. `shareWith` accepts only family members, never the sender; a key not bound to a user (`anonymous`) shares with nobody (`sender_unknown`). A recipient's device token can only be removed by its owner. A **legacy key** (not bound to a user by `/mondrop/connect`) is trusted to name its user, exactly as on every other Mondrop route: whoever holds Michele's old key can read any family member's inbox or register a phone for their notices; the per-user keys of `/mondrop/connect` close that, and the legacy key is meant to be retired once every device has one.
- **Push, dormant.** `services/apnsClient.ts` (Node `crypto` + `http2`, no dependency): ES256 provider token refreshed every 50 min, sandbox host for development tokens, dead tokens (`410`, `BadDeviceToken`) removed. Off unless `APNS_KEY_ID`, `APNS_TEAM_ID` and a readable `APNS_KEY_FILE` exist; the key lives in `~/.config/soundreel/apns/` (0600), mounted read-only at `/run/secrets/apns`, and neither it nor a device token is ever logged. The payload carries the alert text, so the title and body of a notification transit Apple's APNs servers, as with any push; the app still reads the content from the inbox.
- **Never mail:** Telegram jobs, the web and the repair runs (`requeueEmptyAnalysis`) create no inbox items: an intent exists only for a share made through `POST /api/share`.
- **Usage counters** (spec web-mobile-ux M8) ride in the same release: aggregated per day, user, kind of device, network and route group; nothing that identifies a person or a page is stored; admin report `GET /api/admin/usage`.
- **Defaults for the open questions**: re-sending a known link notifies again (a job always runs for it); a recipient cannot reply (sees it, opens it); information lasts 3 days; the sheet's other complaints stay open for Michele.
