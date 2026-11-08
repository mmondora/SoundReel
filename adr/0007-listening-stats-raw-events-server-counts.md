# ADR-0007: Listening statistics — clients send raw sessions, the server decides what counts

## Status
Accepted (implemented in v2.8.0)

## Date
2026-11-07

## Owners
Michele Mondora

## Related
- `docs/mondrop-stats.md` §1, §5; `docs/superpowers/specs/2026-11-07-listening-stats-dynamic-playlists-design.md` (D1–D5)
- ADR-0008 (dynamic playlists consume these events), ADR-0009 (audit of device actions)
- `backend/src/services/{playEvents,listeningStats}.ts`, migration `017_listening_stats.sql`

---

## 1. Context
Michele wants the plays done on Mondrop (and the web player) stored in SoundReel "every now and then", a global
listening dashboard on the web, and playlists such as "most played at night" or "7 to 8 in the morning". The phone
is often offline, the family spans devices, and the rule for "what is a play" is a taste question that will change.

## 2. Decision
1. **Clients report raw sessions, not counters.** Each event: client-generated UUID, song key, start instant (UTC),
   the device's UTC offset **at that moment**, milliseconds really listened, duration if known, completed, origin
   (`local` | `stream` | `web`), playlist. No "play count" is ever computed on a device.
2. **The server decides `counted`**: `listened ≥ min(30 s, 50 % of the duration)`; shorter sessions are kept as
   skips. The flag is stored at insert so queries stay cheap.
3. **Local time is stored explicitly**: `local_started_at` (a zone-less timestamp = start + offset) is derived at
   ingest. Hour-of-day and weekday questions read it, so "7 in the morning" is 7 on the person's wall clock whatever
   the server's timezone, DST or trip. It is read back as text, never through a JS `Date`.
4. **Idempotent batches**: primary key `(user_id, id)`; resending is a no-op, ids of different users never collide;
   ≤ 500 events per request; a bad event is rejected alone and reported.
5. **Delivery is lazy and lossless**: devices queue events on disk and flush at 20 events, in background, at launch
   and every 15 minutes; an event leaves the queue only after a `200`.
6. **Visibility**: users see their own numbers; only the admin sees all users and devices.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| Count on the device and send totals | The threshold could never change without an app update; two devices disagree; no time-of-day. |
| Store only UTC and convert with the server's timezone | Wrong for a phone abroad, for DST edges and for family members elsewhere. |
| Per-song counters | Loses time-of-day, per-device and per-origin questions that the dashboard and dynamic playlists need. |
| Third-party scrobbling (Last.fm) | Data leaves the house; no control of the rule; extra account. |

## 4. Consequences
- The rule can change server-side; `counted` is stored, so a rule change needs a one-line backfill
  (`UPDATE play_events SET counted = …` from `listened_ms` / `duration_ms`).
- ~thousands of rows a year: no partitioning, three indexes (user+time, song, counted+local time).
- The offset is the device's at play time, so DST and travel are right by construction.
