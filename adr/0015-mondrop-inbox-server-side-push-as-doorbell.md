# ADR-0015: The Mondrop inbox lives on the server; push is only the doorbell

## Status
**Proposed** (nothing implemented; the decisions below are defaults to be confirmed, see the spec's open questions)

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
- The app has no push entitlement. Server push (APNs) needs the paid Apple Developer Program; whether team `5NZADC9YQ2` is one is **unknown**.

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
See spec section 6: whether the Apple account is paid; what else about the sheet is disliked; playlists for film links; whether recipients can reply; whether 3 days is right; whether re-sending a known link notifies again.
