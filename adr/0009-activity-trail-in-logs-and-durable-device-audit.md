# ADR-0009: Activity trail in the existing log, durable audit for device deletions

## Status
Accepted (implemented in v2.8.0)

## Date
2026-11-07

## Owners
Michele Mondora

## Related
- spec `2026-11-07-listening-stats-dynamic-playlists-design.md` §4; `docs/mondrop-stats.md` §2
- `backend/src/services/{activityLog,deviceEvents}.ts`, `backend/src/routes/logs.ts`, migration `017_listening_stats.sql`

---

## 1. Context
Michele wants to see in the log the download and sync requests of the devices, who created a playlist and when,
and which songs were put in it; and, because Mondrop can now delete songs from the phone, a **detailed server log**
of every block deletion.

## 2. Decision
1. **Activity lines go in the existing `logs` table**, so they appear in the Console with no new screen. The category
   is the area (`playlist`, `sync`, `download`, `device`); `data.action` and `data.actor = { user, device, channel }`
   are on every line; messages are sentences ("mike (iPhone di Michele) ha creato la playlist «Road trip»").
2. **Actor** = the user the API key is bound to plus the label of the device it was issued for (web: the Authelia
   user). Worker lines are `sistema`, with `requestedBy` in the data.
3. **Noise control**: events a device repeats on a timer (manifest polling, Range chunks, retries) are throttled to one
   line per device and object per window.
4. **`GET /api/logs?category=a,b`** filters on the server (the Console used to filter client-side after fetching the
   latest 200 rows of everything, which lets pipeline noise push activity lines out).
5. **Deletions of songs on a device are also stored durably** in `device_events` (full list: key, title, artist,
   bytes, plays, last play, reason, criteria, number of confirmations). The Console's "clear logs" cannot touch it;
   the console line carries the first 200 songs and says how many are not shown. Blocks need a double confirmation
   on the device; the event is written to the device's durable queue **before** any file is removed.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| A new audit table and screen for everything | Duplicates the console; more UI for the same reading experience. |
| Express middleware logging every request | Generic and noisy; cannot say "who put which song in which playlist". |
| Only `logs` for deletions | One click on "clear logs" would erase the audit of a destructive action. |

## 4. Consequences
- Activity lines share the retention and the "clear logs" button of `logs`; only `device_events` is durable.
- A failed log write never fails the action it describes (fire-and-forget).
- Categories are a small closed set, easy to filter in the UI ("Attività" shows all four).
