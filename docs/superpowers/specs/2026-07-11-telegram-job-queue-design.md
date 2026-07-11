# Telegram Job Queue Design

**Date:** 2026-07-11
**Status:** Approved
**Scope:** Durable, crash-safe intake queue for Telegram-sourced URLs; serialized, jittered dispatch for Instagram scraping specifically (ban/rate-limit avoidance); bounded concurrency for all other platforms.

---

## Problem

Every incoming Telegram URL currently spawns an independent, fully concurrent `/api/analyze` pipeline via a fire-and-forget self-HTTP call (`routes/telegram.ts`). There is no queue, no concurrency limiter, and no durability: if the process crashes between the fire-and-forget call and pipeline completion, that request is silently lost (the DB stub entry survives, but nothing will ever finish it).

The bigger operational risk is Instagram: `instaloader/app.py` holds a single shared, unlocked, module-global `instaloader.Instaloader` session, served by gunicorn with 2 workers × 4 threads — so up to 8 concurrent Instagram requests can race on the same IG login. This is a known trigger for `challenge_required` / rate-limit errors (already anticipated as an error path in `telegram.ts`), and repeated triggering risks an IP or account ban.

## Goal

1. **Nothing lost**: every Telegram message that names a URL is durably recorded and will eventually be processed, even across backend restarts/crashes.
2. **Instagram serialized + delayed**: at most one Instagram scrape in flight at a time, with a randomized delay between dispatches, to avoid looking like automated serial scraping.
3. **Everything else unaffected in spirit**: TikTok/cobalt, Reddit RSS, YouTube, and generic page scraping are not ban-sensitive the way Instagram is; they get a small concurrency cap for overall load control, not a ban-avoidance delay.

---

## Approach

**DB-backed job queue table + in-process poller** (hand-rolled, no new dependency).

Rejected alternative: `pg-boss` (Postgres-native job queue library) — would give retry/backoff/locking out of the box, but adds a new backend dependency plus its own internal schema, and works against its own API instead of the specific IG-jitter behavior needed here. For a single-user, low-volume app, a plain table + `setInterval` poller (in the spirit of the project's existing "no ORM, direct SQL" convention) is simpler to reason about and sufficient.

Rejected alternative: external broker (Redis/BullMQ) — no such infra exists in this stack; would violate the project's "no heavy new infra" ethos for a problem Postgres already solves.

---

## Data Layer

### Schema change (`backend/src/db/init.sql`)

```sql
CREATE TABLE job_queue (
  id SERIAL PRIMARY KEY,
  entry_id UUID NOT NULL REFERENCES entries(id),
  source_url TEXT NOT NULL,
  platform TEXT NOT NULL,                    -- 'instagram' | 'other'
  status TEXT NOT NULL DEFAULT 'queued',     -- queued | processing | done | failed
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_job_queue_dispatch ON job_queue (status, platform, next_attempt_at);
```

`platform` is set at enqueue time via a cheap URL host-pattern check (`instagram.com`) — the same detection logic `analyze.ts` already uses internally for `source_platform`, just performed earlier, at intake. `entries.status` continues to track user-facing entry state (`processing` / `completed` / `error`); `job_queue.status` tracks queue-internal dispatch state. These are kept as separate fields — no overloading one column for two concerns.

---

## Intake: Telegram webhook changes (`routes/telegram.ts`)

Current flow: create stub `entries` row (`status: 'processing'`) → reply `200 OK` → fire-and-forget self-HTTP call to `/api/analyze` → send Telegram result message when that call resolves.

New flow:

1. Extract URL, detect platform (`instagram` vs `other`) via host match.
2. Insert `entries` stub row (`status: 'processing'`) — unchanged.
3. Insert `job_queue` row (`status: 'queued'`, `platform`, `next_attempt_at: now()`).
4. Reply `200 OK` to Telegram immediately — unchanged.
5. **Removed**: the fire-and-forget `/api/analyze` call. The worker now owns dispatch.
6. The Telegram result message (song/film list) is sent from the worker's post-dispatch callback instead of the webhook handler — same message-formatting code, relocated, using the `chat_id`/`input_user` stored on the entry.

Net effect: the webhook handler becomes intake-only (two DB writes + one HTTP reply), with no blocking network calls and no unbounded fire-and-forget pileup. No interim "queued" message is sent to the user — the flow stays silent until the final result, same as today's perceived behavior, just potentially delayed under an Instagram backlog.

---

## Worker (`backend/src/services/jobQueueWorker.ts`)

Started alongside the existing daily-cleanup interval in `server.ts`. In-process state:

```
igLane = { busy: false, nextAllowedAt: Date.now() }
otherInFlight = 0   // counter, cap 3
```

```
setInterval(tick, 2000)

tick():
  if !igLane.busy && now >= igLane.nextAllowedAt:
    job = SELECT ... FROM job_queue
          WHERE status='queued' AND platform='instagram' AND next_attempt_at <= now
          ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    if job: dispatch(job, igLane)

  while otherInFlight < 3:
    job = SELECT ... FROM job_queue
          WHERE status='queued' AND platform='other' AND next_attempt_at <= now
          ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    if !job: break
    dispatch(job, otherLane)

dispatch(job, lane):
  UPDATE job_queue SET status='processing' WHERE id=job.id
  if lane === igLane: igLane.busy = true
  else: otherInFlight++
  call /api/analyze internally (existing self-HTTP call, relocated here)
  on settle:
    if lane === igLane:
      igLane.busy = false
      igLane.nextAllowedAt = now + random(30_000, 90_000)   // jitter, avoids fixed-interval fingerprint
    else:
      otherInFlight--
    handle result — see Retry/backoff/fallback
    send Telegram message to entry's chat
```

`FOR UPDATE SKIP LOCKED` guards against double-dispatch if the worker ever runs on more than one instance; harmless with a single instance too.

---

## Retry / backoff / fallback

- **Instagram jobs**: max 3 attempts. On failure, `attempts++`, `next_attempt_at = now + backoff[attempts]` with `backoff = [60s, 180s, 420s]`, `status` reset to `queued` (job stays in the IG lane, still gated by `igLane.nextAllowedAt`). After the 3rd failure: `job_queue.status='failed'`, pipeline falls back per CLAUDE.md resilience rule #1 (OG meta scraping — caption + thumbnail only), `entries.status='completed'` (degraded result), `action_log` appended with the failure detail and the fallback note.
- **Other-platform jobs**: 1 retry (60s), then `job_queue.status='failed'`, `entries.status='error'`, `action_log` appended. No extended backoff — there's no ban-avoidance reason to delay these further; existing per-source fallback rules (CLAUDE.md resilience rules 2-5) still apply inside the pipeline itself.

---

## Crash recovery

On `server.ts` boot, before starting the worker interval:

```sql
UPDATE job_queue SET status='queued' WHERE status='processing';
```

Any job stuck mid-flight from a crash gets requeued. Safe to reprocess because `/api/analyze` is already idempotent via the existing `source_url` dedupe check (`findEntryByUrl`).

---

## Testing

Per CLAUDE.md: no real external calls (Instagram, TikTok, YouTube, Spotify, Ollama, cobalt, instaloader) in tests — always mock/stub.

- **Unit**: worker dispatch logic — `igLane` jitter math, concurrency cap counter, backoff calculation — with mocked `/api/analyze` calls and a fake/injected clock.
- **Integration**: against a real (test-container) Postgres, verifying `FOR UPDATE SKIP LOCKED` job claiming under concurrent tick calls, and crash-recovery requeue behavior (`processing` → `queued` on simulated restart) — `/api/analyze` still mocked.

---

## Out of scope

- No interim "queued" Telegram message (decided against — silent until done).
- No concurrency change for Instagram beyond serialization to 1 (no partial parallelism ever considered safe here).
- No new queue/broker infrastructure (Redis, RabbitMQ, pg-boss) — Postgres + in-process poller only.
