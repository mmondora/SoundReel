# Telegram Job Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Telegram-sourced URL durably queued (nothing lost across crashes/restarts), with Instagram scrapes serialized one-at-a-time with a randomized 30-90s delay (ban avoidance), and all other platforms capped at 3 concurrent.

**Architecture:** A new Postgres `job_queue` table is the durable intake buffer. The Telegram webhook becomes intake-only (two DB writes + a fast `200 OK`) — it no longer calls `/api/analyze` itself. A new in-process worker (`setInterval` poller in the existing Fastify process) claims jobs with `FOR UPDATE SKIP LOCKED`, dispatches Instagram jobs one at a time with jitter, dispatches other-platform jobs up to 3 concurrent, and sends the Telegram result message once the (existing, unchanged) `/api/analyze` pipeline responds.

**Tech Stack:** TypeScript (Fastify backend), `pg` direct SQL (no ORM), Vitest for tests. No new npm dependencies.

## Global Constraints

- TypeScript strict mode, no `any` (CLAUDE.md).
- No ORM — direct SQL via `pg` (CLAUDE.md).
- Every pipeline step is independent; if one fails, others continue (CLAUDE.md resilience rules).
- Every action gets logged to the entry's `actionLog` (CLAUDE.md).
- Secrets read from env vars only, never hardcoded (CLAUDE.md).
- `analyzeUrl` (`POST /api/analyze`) is the single shared implementation for web + Telegram — this plan does not change its internals, only how/when it's called from Telegram (CLAUDE.md).
- Tests never call real external services (Instagram, Telegram, etc.) — always mock/stub. Stack: Vitest (CLAUDE.md).
- No heavy new dependencies (CLAUDE.md) — this plan adds zero new npm packages.

---

### Task 1: `job_queue` schema

**Files:**
- Modify: `backend/src/db/init.sql` (append at end of file)

**Interfaces:**
- Produces: table `job_queue` with columns `id, entry_id, source_url, platform, chat_id, input_user, status, attempts, next_attempt_at, created_at, updated_at`, consumed by Task 2's `jobQueue.ts`.

No automated test at this layer — the repo has no test-Postgres harness and `init.sql` itself is never unit tested (verified: no existing test touches it). Verification is a local `psql` check against the dev Postgres container, matching the project's `docker compose logs -f soundreel` style manual-check convention.

- [ ] **Step 1: Append the table to `init.sql`**

Add this at the very end of `backend/src/db/init.sql`:

```sql

-- Job queue: durable intake queue for Telegram-sourced URLs.
-- Instagram jobs are serialized one-at-a-time with jitter (ban avoidance);
-- other-platform jobs are capped at N concurrent by the worker.
CREATE TABLE IF NOT EXISTS job_queue (
  id SERIAL PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  source_url TEXT NOT NULL,
  platform TEXT NOT NULL,
  chat_id BIGINT NOT NULL,
  input_user TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_queue_dispatch ON job_queue (status, platform, next_attempt_at);
```

- [ ] **Step 2: Apply it to the local dev Postgres and verify**

Run:
```bash
docker compose up -d soundreel-db
docker exec -i soundreel-db psql -U soundreel -d soundreel < backend/src/db/init.sql
docker exec -i soundreel-db psql -U soundreel -d soundreel -c "\d job_queue"
```
Expected: `\d job_queue` prints the table with all 11 columns and the `idx_job_queue_dispatch` index, no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/db/init.sql
git commit -m "feat(db): add job_queue table for Telegram intake queue"
```

---

### Task 2: `job_queue` data layer

**Files:**
- Create: `backend/src/utils/jobQueue.ts`

**Interfaces:**
- Consumes: `query`, `withClient` from `backend/src/utils/db.ts` (existing, signatures: `query<T>(text: string, params?: unknown[]): Promise<T[]>`, `withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>`).
- Produces (consumed by Task 3 and Task 4):
  - `type JobPlatform = 'instagram' | 'other'`
  - `type JobStatus = 'queued' | 'processing' | 'done' | 'failed'`
  - `interface JobQueueRow { id: number; entryId: string; sourceUrl: string; platform: JobPlatform; chatId: number; inputUser: string | null; status: JobStatus; attempts: number; nextAttemptAt: string; createdAt: string; updatedAt: string; }`
  - `enqueueJob(job: { entryId: string; sourceUrl: string; platform: JobPlatform; chatId: number; inputUser: string | null }): Promise<number>`
  - `claimNextInstagramJob(): Promise<JobQueueRow | null>`
  - `claimNextOtherJob(): Promise<JobQueueRow | null>`
  - `markJobDone(jobId: number): Promise<void>`
  - `markJobFailed(jobId: number): Promise<void>`
  - `scheduleJobRetry(jobId: number, attempts: number, nextAttemptAt: Date): Promise<void>`
  - `requeueStuckJobs(): Promise<number>`

No automated test at this layer, matching the existing convention: `backend/src/utils/db.ts` (same kind of raw-SQL data-access file) has zero unit tests in this repo — every route test mocks it wholesale instead (e.g. `vi.mock('../utils/db', ...)` in `telegram.test.ts`, `musicList.test.ts`). Verification is `npm run typecheck`.

- [ ] **Step 1: Write `jobQueue.ts`**

```typescript
import { query, withClient } from './db';

export type JobPlatform = 'instagram' | 'other';
export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface JobQueueRow {
  id: number;
  entryId: string;
  sourceUrl: string;
  platform: JobPlatform;
  chatId: number;
  inputUser: string | null;
  status: JobStatus;
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

interface JobQueueDbRow {
  id: number;
  entry_id: string;
  source_url: string;
  platform: string;
  chat_id: string;
  input_user: string | null;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  created_at: Date;
  updated_at: Date;
}

function rowToJob(row: JobQueueDbRow): JobQueueRow {
  return {
    id: row.id,
    entryId: row.entry_id,
    sourceUrl: row.source_url,
    platform: row.platform as JobPlatform,
    chatId: Number(row.chat_id),
    inputUser: row.input_user,
    status: row.status as JobStatus,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function enqueueJob(job: {
  entryId: string;
  sourceUrl: string;
  platform: JobPlatform;
  chatId: number;
  inputUser: string | null;
}): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO job_queue (entry_id, source_url, platform, chat_id, input_user)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [job.entryId, job.sourceUrl, job.platform, job.chatId, job.inputUser]
  );
  return rows[0].id;
}

async function claimNext(platformClause: string): Promise<JobQueueRow | null> {
  return withClient(async (client) => {
    // withClient does not open a transaction — without an explicit BEGIN,
    // Postgres autocommits the SELECT, releasing the SKIP LOCKED row lock
    // before the UPDATE runs, letting two callers claim the same row.
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<JobQueueDbRow>(
        `SELECT * FROM job_queue
         WHERE status = 'queued' AND ${platformClause} AND next_attempt_at <= NOW()
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
      );
      const row = rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      await client.query(
        `UPDATE job_queue SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [row.id]
      );
      await client.query('COMMIT');
      return rowToJob(row);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

export function claimNextInstagramJob(): Promise<JobQueueRow | null> {
  return claimNext(`platform = 'instagram'`);
}

export function claimNextOtherJob(): Promise<JobQueueRow | null> {
  return claimNext(`platform <> 'instagram'`);
}

export async function markJobDone(jobId: number): Promise<void> {
  await query(`UPDATE job_queue SET status = 'done', updated_at = NOW() WHERE id = $1`, [jobId]);
}

export async function markJobFailed(jobId: number): Promise<void> {
  await query(`UPDATE job_queue SET status = 'failed', updated_at = NOW() WHERE id = $1`, [jobId]);
}

export async function scheduleJobRetry(jobId: number, attempts: number, nextAttemptAt: Date): Promise<void> {
  await query(
    `UPDATE job_queue SET status = 'queued', attempts = $2, next_attempt_at = $3, updated_at = NOW() WHERE id = $1`,
    [jobId, attempts, nextAttemptAt.toISOString()]
  );
}

export async function requeueStuckJobs(): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE job_queue SET status = 'queued', updated_at = NOW() WHERE status = 'processing' RETURNING id`
  );
  return rows.length;
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd backend && npm run typecheck`
Expected: no errors referencing `jobQueue.ts`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/utils/jobQueue.ts
git commit -m "feat(backend): add job_queue data access layer"
```

---

### Task 3: Telegram webhook enqueues instead of fire-and-forget

**Files:**
- Modify: `backend/src/routes/telegram.ts:51` (`sendTelegramMessage` → add `export`)
- Modify: `backend/src/routes/telegram.ts:108` (`formatAnalysisError` → add `export`)
- Modify: `backend/src/routes/telegram.ts:129` (`formatTelegramResponse` → add `export`)
- Modify: `backend/src/routes/telegram.ts:300-352` (stub-entry + fire-and-forget block → stub-entry + enqueue)
- Modify: `backend/src/routes/telegram.test.ts` (add webhook-level tests)

**Interfaces:**
- Consumes: `enqueueJob`, `JobPlatform` from `backend/src/utils/jobQueue.ts` (Task 2).
- Produces (consumed by Task 4): exported `sendTelegramMessage(chatId: number, text: string, token: string): Promise<void>`, `formatAnalysisError(result: AnalyzeResult): string`, `formatTelegramResponse(result: AnalyzeResult, entryId: string): Promise<string>`, and the existing exported `AnalyzeResult` type.

- [ ] **Step 1: Export the three functions the worker will need**

In `backend/src/routes/telegram.ts`, change:
```typescript
async function sendTelegramMessage(chatId: number, text: string, token: string): Promise<void> {
```
to:
```typescript
export async function sendTelegramMessage(chatId: number, text: string, token: string): Promise<void> {
```

Change:
```typescript
function formatAnalysisError(result: AnalyzeResult): string {
```
to:
```typescript
export function formatAnalysisError(result: AnalyzeResult): string {
```

Change:
```typescript
async function formatTelegramResponse(result: AnalyzeResult, entryId: string): Promise<string> {
```
to:
```typescript
export async function formatTelegramResponse(result: AnalyzeResult, entryId: string): Promise<string> {
```

- [ ] **Step 2: Write the failing tests for the new enqueue behavior**

Add to the top of `backend/src/routes/telegram.test.ts`, extending the existing `vi.mock('../utils/db', ...)` call to include the extra functions the webhook path uses, and adding a new mock for `../utils/jobQueue`:

Replace:
```typescript
vi.mock('../utils/db', () => ({
  countEntries: vi.fn().mockResolvedValue(0),
  listEntries: vi.fn().mockResolvedValue([]),
}));
```
with:
```typescript
vi.mock('../utils/db', () => ({
  countEntries: vi.fn().mockResolvedValue(0),
  listEntries: vi.fn().mockResolvedValue([]),
  findEntryByUrl: vi.fn().mockResolvedValue(null),
  createEntry: vi.fn().mockResolvedValue('new-entry-id'),
  createActionLog: vi.fn().mockReturnValue({ action: 'test', details: {}, timestamp: '2026-01-01T00:00:00.000Z' }),
}));

vi.mock('../utils/jobQueue', () => ({
  enqueueJob: vi.fn().mockResolvedValue(1),
}));

vi.mock('../services/urlNormalize', () => ({
  normalizeUrl: (url: string) => url,
}));
```

Then add this new import and describe block at the end of `backend/src/routes/telegram.test.ts`:

```typescript
import Fastify from 'fastify';
import { registerTelegramRoute } from './telegram';
import { findEntryByUrl, createEntry } from '../utils/db';
import { enqueueJob } from '../utils/jobQueue';

function buildApp() {
  const app = Fastify();
  registerTelegramRoute(app);
  return app;
}

function urlMessage(url: string, chatId = 555) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: chatId },
      from: { username: 'mike' },
      text: url,
    },
  };
}

describe('POST /telegram/webhook — URL message enqueues a job', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV, TELEGRAM_BOT_TOKEN: 'test-token' };
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });

  it('Instagram URL → stub entry created + job enqueued with platform=instagram', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      payload: urlMessage('https://www.instagram.com/reel/abc123/'),
    });
    expect(res.statusCode).toBe(200);
    expect(createEntry).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePlatform: 'instagram', inputChannel: 'telegram' })
    );
    expect(enqueueJob).toHaveBeenCalledWith({
      entryId: 'new-entry-id',
      sourceUrl: 'https://www.instagram.com/reel/abc123/',
      platform: 'instagram',
      chatId: 555,
      inputUser: '@mike',
    });
  });

  it('TikTok URL → job enqueued with platform=other', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      payload: urlMessage('https://www.tiktok.com/@x/video/1'),
    });
    expect(res.statusCode).toBe(200);
    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'other' })
    );
  });

  it('URL already has an entry → reuses existing entry id, does not create a new one', async () => {
    vi.mocked(findEntryByUrl).mockResolvedValueOnce({ id: 'existing-id' } as never);
    const app = buildApp();
    await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      payload: urlMessage('https://www.instagram.com/reel/dup/'),
    });
    expect(createEntry).not.toHaveBeenCalled();
    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: 'existing-id' })
    );
  });

  it('does not call fetch — webhook no longer calls /api/analyze directly', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const app = buildApp();
    await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      payload: urlMessage('https://www.instagram.com/reel/nofetch/'),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && npx vitest run src/routes/telegram.test.ts`
Expected: FAIL — `enqueueJob` never called (webhook still does the old fire-and-forget fetch), and the "does not call fetch" test fails because the webhook currently does call `fetch`.

- [ ] **Step 4: Rewire the webhook handler**

In `backend/src/routes/telegram.ts`, replace this block (originally lines 300-352):
```typescript
      // Persist stub entry immediately so URL always appears in journal,
      // even if the background pipeline crashes or the server restarts.
      const tgUser = telegramUser(message);
      try {
        const normalizedStubUrl = normalizeUrl(url);
        const existing = await findEntryByUrl(normalizedStubUrl);
        if (!existing) {
          await createEntry({
            sourceUrl: normalizedStubUrl,
            sourcePlatform: platformFromUrl(url),
            inputChannel: 'telegram',
            inputUser: tgUser,
            caption: null,
            thumbnailUrl: null,
            mediaUrl: null,
            status: 'processing',
            results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null },
            actionLog: [createActionLog('url_received', { channel: 'telegram', user: tgUser })],
          });
        }
      } catch (stubErr) {
        log.error('Stub entry creation failed', stubErr instanceof Error ? stubErr : new Error(String(stubErr)));
      }

      // Respond webhook fast, process in background
      reply.code(200).send('OK');

      (async () => {
        try {
          const internalUrl = `http://127.0.0.1:${process.env.PORT || 8080}/api/analyze`;
          const analyzeResponse = await fetch(internalUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, channel: 'telegram', user: tgUser }),
          });
          if (!analyzeResponse.ok) {
            throw new Error(`analyze HTTP ${analyzeResponse.status}`);
          }
          const result = (await analyzeResponse.json()) as AnalyzeResult;
          if (!result.success || !result.entry) {
            await sendTelegramMessage(chatId, formatAnalysisError(result), token);
          } else {
            const response = await formatTelegramResponse(result, result.entryId || '');
            await sendTelegramMessage(chatId, response, token);
          }
        } catch (err) {
          log.error('Pipeline analyze via telegram fallita', err instanceof Error ? err : new Error(String(err)));
          await sendTelegramMessage(chatId, `❌ Analisi fallita.\n🌐 <a href="${process.env.FRONTEND_URL || 'https://soundreel.casamon.dev'}">Apri SoundReel</a>`, token);
        }
      })().catch(() => {});

      await countEntries().catch(() => 0);
      return;
```

with:
```typescript
      // Persist stub entry immediately so URL always appears in journal,
      // even if the worker crashes or the server restarts.
      const tgUser = telegramUser(message);
      const platform = platformFromUrl(url);
      const jobPlatform: JobPlatform = platform === 'instagram' ? 'instagram' : 'other';

      let stubEntryId: string | null = null;
      try {
        const normalizedStubUrl = normalizeUrl(url);
        const existing = await findEntryByUrl(normalizedStubUrl);
        if (existing) {
          stubEntryId = existing.id;
        } else {
          stubEntryId = await createEntry({
            sourceUrl: normalizedStubUrl,
            sourcePlatform: platform,
            inputChannel: 'telegram',
            inputUser: tgUser,
            caption: null,
            thumbnailUrl: null,
            mediaUrl: null,
            status: 'processing',
            results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null },
            actionLog: [createActionLog('url_received', { channel: 'telegram', user: tgUser })],
          });
        }
      } catch (stubErr) {
        log.error('Stub entry creation failed', stubErr instanceof Error ? stubErr : new Error(String(stubErr)));
      }

      let enqueued = false;
      if (stubEntryId) {
        try {
          await enqueueJob({
            entryId: stubEntryId,
            sourceUrl: url,
            platform: jobPlatform,
            chatId,
            inputUser: tgUser,
          });
          enqueued = true;
        } catch (queueErr) {
          log.error('Job enqueue failed', queueErr instanceof Error ? queueErr : new Error(String(queueErr)));
        }
      }

      // If the stub entry write or the enqueue itself failed (e.g. a DB
      // hiccup), the job never entered the queue — tell the user instead
      // of silently replying 200 with no entry, no job, and no feedback.
      if (!enqueued) {
        await sendTelegramMessage(
          chatId,
          `❌ Analisi fallita.\n🌐 <a href="${process.env.FRONTEND_URL || 'https://soundreel.casamon.dev'}">Apri SoundReel</a>`,
          token
        ).catch(() => {});
      }

      reply.code(200).send('OK');
      await countEntries().catch(() => 0);
      return;
```

Add the import at the top of the file:
```typescript
import { enqueueJob, type JobPlatform } from '../utils/jobQueue';
```

Note: `platformFromUrl(url)` is now called once and reused for both the stub entry's `sourcePlatform` and the job's `platform` (previously it was called twice, redundantly, inline).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && npx vitest run src/routes/telegram.test.ts`
Expected: PASS, all tests including the pre-existing pure-function tests.

- [ ] **Step 6: Run typecheck**

Run: `cd backend && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/telegram.ts backend/src/routes/telegram.test.ts
git commit -m "feat(telegram): enqueue URL jobs instead of firing analyze directly"
```

---

### Task 4: Job queue worker

**Files:**
- Create: `backend/src/services/jobQueueWorker.ts`
- Create: `backend/src/services/jobQueueWorker.test.ts`

**Interfaces:**
- Consumes: `claimNextInstagramJob`, `claimNextOtherJob`, `markJobDone`, `markJobFailed`, `scheduleJobRetry`, `type JobQueueRow`, `type JobPlatform` from `backend/src/utils/jobQueue.ts` (Task 2); `sendTelegramMessage`, `formatAnalysisError`, `formatTelegramResponse`, `type AnalyzeResult` from `backend/src/routes/telegram.ts` (Task 3).
- Produces (consumed by Task 5): `startJobQueueWorker(intervalMs?: number): NodeJS.Timeout`. Also exports `computeJitterDelayMs(rand?: () => number): number`, `computeBackoffMs(platform: JobPlatform, attempts: number): number | null`, `tick(state: WorkerState): Promise<void>`, `createInitialWorkerState(): WorkerState`, `interface WorkerState { igBusy: boolean; igNextAllowedAt: number; otherInFlight: number }` for testing.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/services/jobQueueWorker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/jobQueue', () => ({
  claimNextInstagramJob: vi.fn(),
  claimNextOtherJob: vi.fn(),
  markJobDone: vi.fn(),
  markJobFailed: vi.fn(),
  scheduleJobRetry: vi.fn(),
}));

vi.mock('../routes/telegram', () => ({
  sendTelegramMessage: vi.fn(),
  formatAnalysisError: vi.fn().mockReturnValue('error-text'),
  formatTelegramResponse: vi.fn().mockResolvedValue('ok-text'),
}));

vi.mock('./debugLogger', () => ({
  Logger: vi.fn().mockImplementation(() => ({
    startTimer: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), endTimer: vi.fn(),
  })),
}));

import {
  computeJitterDelayMs,
  computeBackoffMs,
  tick,
  createInitialWorkerState,
} from './jobQueueWorker';
import {
  claimNextInstagramJob,
  claimNextOtherJob,
  markJobDone,
  markJobFailed,
  scheduleJobRetry,
  type JobQueueRow,
} from '../utils/jobQueue';
import { sendTelegramMessage } from '../routes/telegram';

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

const IG_JOB: JobQueueRow = {
  id: 1, entryId: 'e1', sourceUrl: 'https://instagram.com/reel/x', platform: 'instagram',
  chatId: 42, inputUser: '@mike', status: 'processing', attempts: 0,
  nextAttemptAt: '', createdAt: '', updatedAt: '',
};

describe('computeJitterDelayMs', () => {
  it('rand=0 → 30000 (lower bound)', () => {
    expect(computeJitterDelayMs(() => 0)).toBe(30_000);
  });

  it('rand just under 1 → just under 90000 (upper bound)', () => {
    const v = computeJitterDelayMs(() => 0.999999);
    expect(v).toBeGreaterThanOrEqual(89_999);
    expect(v).toBeLessThan(90_000);
  });
});

describe('computeBackoffMs', () => {
  it('instagram attempt 1 → 60s', () => {
    expect(computeBackoffMs('instagram', 1)).toBe(60_000);
  });
  it('instagram attempt 3 → 420s', () => {
    expect(computeBackoffMs('instagram', 3)).toBe(420_000);
  });
  it('instagram attempt 4 → null (terminal, exhausted)', () => {
    expect(computeBackoffMs('instagram', 4)).toBeNull();
  });
  it('other attempt 1 → 60s', () => {
    expect(computeBackoffMs('other', 1)).toBe(60_000);
  });
  it('other attempt 2 → null (terminal, exhausted)', () => {
    expect(computeBackoffMs('other', 2)).toBeNull();
  });
});

describe('tick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('no jobs queued → state stays idle', async () => {
    vi.mocked(claimNextInstagramJob).mockResolvedValue(null);
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    const state = createInitialWorkerState();
    await tick(state);
    expect(state.igBusy).toBe(false);
    expect(state.otherInFlight).toBe(0);
  });

  it('IG lane already busy → does not attempt to claim another IG job', async () => {
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    const state = createInitialWorkerState();
    state.igBusy = true;
    await tick(state);
    expect(claimNextInstagramJob).not.toHaveBeenCalled();
  });

  it('IG jitter window not elapsed yet → does not attempt to claim', async () => {
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    const state = createInitialWorkerState();
    state.igNextAllowedAt = Date.now() + 60_000;
    await tick(state);
    expect(claimNextInstagramJob).not.toHaveBeenCalled();
  });

  it('IG job found + analyze succeeds → marks done, sends result, opens jitter window', async () => {
    vi.mocked(claimNextInstagramJob).mockResolvedValue(IG_JOB);
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, entryId: 'e1', entry: { results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null } } }),
    } as never);

    const state = createInitialWorkerState();
    await tick(state);
    await flush();

    expect(markJobDone).toHaveBeenCalledWith(1);
    expect(sendTelegramMessage).toHaveBeenCalledWith(42, 'ok-text', expect.any(String));
    expect(state.igBusy).toBe(false);
    expect(state.igNextAllowedAt).toBeGreaterThan(Date.now() + 29_000);
  });

  it('IG job fails, attempts=0 → schedules retry with 60s backoff, does not mark failed', async () => {
    vi.mocked(claimNextInstagramJob).mockResolvedValue(IG_JOB);
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const state = createInitialWorkerState();
    await tick(state);
    await flush();

    expect(scheduleJobRetry).toHaveBeenCalledWith(1, 1, expect.any(Date));
    expect(markJobFailed).not.toHaveBeenCalled();
  });

  it('IG job fails at attempts=3 (exhausted) → marks failed, sends error message, no more retry', async () => {
    vi.mocked(claimNextInstagramJob).mockResolvedValue({ ...IG_JOB, attempts: 3 });
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const state = createInitialWorkerState();
    await tick(state);
    await flush();

    expect(markJobFailed).toHaveBeenCalledWith(1);
    expect(scheduleJobRetry).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalled();
  });

  it('other-platform jobs dispatch up to the concurrency cap of 3, then stop', async () => {
    vi.mocked(claimNextInstagramJob).mockResolvedValue(null);
    let claims = 0;
    vi.mocked(claimNextOtherJob).mockImplementation(async () => {
      claims++;
      return claims <= 3 ? { ...IG_JOB, id: claims, platform: 'other' } : null;
    });
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {})); // never resolves — keeps jobs in flight

    const state = createInitialWorkerState();
    await tick(state);

    expect(state.otherInFlight).toBe(3);
    // The while condition is checked BEFORE each claim, so once otherInFlight
    // reaches the cap the loop exits without an extra trailing claim call —
    // it does not need to observe a null to know it's full.
    expect(claimNextOtherJob).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run src/services/jobQueueWorker.test.ts`
Expected: FAIL — `Cannot find module './jobQueueWorker'` (file doesn't exist yet).

- [ ] **Step 3: Write `jobQueueWorker.ts`**

```typescript
import {
  claimNextInstagramJob,
  claimNextOtherJob,
  markJobDone,
  markJobFailed,
  scheduleJobRetry,
  type JobQueueRow,
  type JobPlatform,
} from '../utils/jobQueue';
import { sendTelegramMessage, formatAnalysisError, formatTelegramResponse, type AnalyzeResult } from '../routes/telegram';
import { Logger } from './debugLogger';

const OTHER_CONCURRENCY_CAP = 3;
const IG_BACKOFF_MS = [60_000, 180_000, 420_000];
const OTHER_BACKOFF_MS = [60_000];

export interface WorkerState {
  igBusy: boolean;
  igNextAllowedAt: number; // epoch ms
  otherInFlight: number;
}

export function createInitialWorkerState(): WorkerState {
  return { igBusy: false, igNextAllowedAt: 0, otherInFlight: 0 };
}

export function computeJitterDelayMs(rand: () => number = Math.random): number {
  return Math.floor(30_000 + rand() * 60_000);
}

export function computeBackoffMs(platform: JobPlatform, attempts: number): number | null {
  const table = platform === 'instagram' ? IG_BACKOFF_MS : OTHER_BACKOFF_MS;
  if (attempts > table.length) return null;
  return table[attempts - 1];
}

async function sendResultToTelegram(job: JobQueueRow, result: AnalyzeResult): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  if (!result.success || !result.entry) {
    await sendTelegramMessage(job.chatId, formatAnalysisError(result), token);
  } else {
    const text = await formatTelegramResponse(result, result.entryId || '');
    await sendTelegramMessage(job.chatId, text, token);
  }
}

async function handleFailure(job: JobQueueRow, err: unknown, log: Logger): Promise<void> {
  log.error(`Job ${job.id} (${job.platform}) failed`, err instanceof Error ? err : new Error(String(err)));
  const attempts = job.attempts + 1;
  const backoff = computeBackoffMs(job.platform, attempts);
  if (backoff === null) {
    await markJobFailed(job.id);
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (token) {
      await sendTelegramMessage(
        job.chatId,
        `❌ Analisi fallita dopo ${attempts} tentativi.\n🌐 <a href="${process.env.FRONTEND_URL || 'https://soundreel.casamon.dev'}">Apri SoundReel</a>`,
        token
      );
    }
    return;
  }
  await scheduleJobRetry(job.id, attempts, new Date(Date.now() + backoff));
}

async function dispatch(job: JobQueueRow, onSettle: () => void): Promise<void> {
  const log = new Logger('jobQueueWorker');
  try {
    const internalUrl = `http://127.0.0.1:${process.env.PORT || 8080}/api/analyze`;
    const res = await fetch(internalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: job.sourceUrl, channel: 'telegram', user: job.inputUser }),
    });
    if (!res.ok) throw new Error(`analyze HTTP ${res.status}`);
    const result = (await res.json()) as AnalyzeResult;
    await markJobDone(job.id);
    // Isolated from the try/catch above it: a Telegram delivery failure here
    // must not re-trigger handleFailure and undo an already-successful job.
    try {
      await sendResultToTelegram(job, result);
    } catch (notifyErr) {
      log.error(
        `Job ${job.id} succeeded but Telegram notification failed`,
        notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr))
      );
    }
  } catch (err) {
    // dispatch() is invoked fire-and-forget (`void dispatch(...)`), so if
    // handleFailure itself throws (e.g. DB unreachable while recording the
    // failure), that must not become an unhandled promise rejection.
    try {
      await handleFailure(job, err, log);
    } catch (failureErr) {
      log.error(
        `Job ${job.id} failure handling itself failed`,
        failureErr instanceof Error ? failureErr : new Error(String(failureErr))
      );
    }
  } finally {
    onSettle();
  }
}

export async function tick(state: WorkerState): Promise<void> {
  const now = Date.now();

  if (!state.igBusy && now >= state.igNextAllowedAt) {
    // Set busy before awaiting the claim — otherwise an overlapping tick
    // (setInterval doesn't wait for this one to finish) could also see
    // igBusy===false and claim a second Instagram job concurrently.
    state.igBusy = true;
    const job = await claimNextInstagramJob();
    if (job) {
      void dispatch(job, () => {
        state.igBusy = false;
        state.igNextAllowedAt = Date.now() + computeJitterDelayMs();
      });
    } else {
      state.igBusy = false;
    }
  }

  while (state.otherInFlight < OTHER_CONCURRENCY_CAP) {
    // Same race guard as above: reserve the slot before awaiting the claim.
    state.otherInFlight++;
    const job = await claimNextOtherJob();
    if (!job) {
      state.otherInFlight--;
      break;
    }
    void dispatch(job, () => {
      state.otherInFlight--;
    });
  }
}

let workerState: WorkerState | null = null;

export function startJobQueueWorker(intervalMs = 2000): NodeJS.Timeout {
  workerState = createInitialWorkerState();
  return setInterval(() => void tick(workerState!), intervalMs);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run src/services/jobQueueWorker.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Run typecheck**

Run: `cd backend && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/jobQueueWorker.ts backend/src/services/jobQueueWorker.test.ts
git commit -m "feat(backend): add job queue worker with IG serialization+jitter and other-platform concurrency cap"
```

---

### Task 5: Wire crash recovery + worker startup into `server.ts`

**Files:**
- Modify: `backend/src/server.ts`

**Interfaces:**
- Consumes: `requeueStuckJobs` from `backend/src/utils/jobQueue.ts` (Task 2), `startJobQueueWorker` from `backend/src/services/jobQueueWorker.ts` (Task 4).

No test file exists for `server.ts` in this repo (it's the bootstrap entrypoint, exercised by running the app, not unit tested) — verification is `npm run typecheck` plus a manual boot check.

- [ ] **Step 1: Add the imports**

In `backend/src/server.ts`, add near the other imports:
```typescript
import { requeueStuckJobs } from './utils/jobQueue';
import { startJobQueueWorker } from './services/jobQueueWorker';
```

- [ ] **Step 2: Call crash recovery + start the worker after the DB check**

Replace:
```typescript
  await query('SELECT 1');
  app.log.info('Postgres connection verified');

  // Startup cleanup + daily schedule (orphan + retention purge)
```
with:
```typescript
  await query('SELECT 1');
  app.log.info('Postgres connection verified');

  const requeuedCount = await requeueStuckJobs();
  if (requeuedCount > 0) {
    app.log.warn(`Requeued ${requeuedCount} job(s) stuck in 'processing' from a previous crash/restart`);
  }
  startJobQueueWorker();
  app.log.info('Job queue worker started');

  // Startup cleanup + daily schedule (orphan + retention purge)
```

- [ ] **Step 3: Run typecheck**

Run: `cd backend && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual boot check**

Run: `cd backend && npm run dev`
Expected log lines (in order): `Postgres connection verified`, then either `Requeued N job(s)...` (if any were stuck) or nothing, then `Job queue worker started`, then the Fastify listening line. No thrown exceptions, process stays up.

- [ ] **Step 5: Commit**

```bash
git add backend/src/server.ts
git commit -m "feat(backend): run crash recovery and start job queue worker on boot"
```

---

### Task 6: End-to-end manual verification (local)

Not a code task — this confirms the whole chain works together before it's considered done. Requires the local Docker stack (`soundreel-db`, `soundreel-instaloader`, the backend itself) running.

- [ ] **Step 1: Boot the local stack**

```bash
docker compose up -d soundreel-db instaloader
cd backend && npm run dev
```

- [ ] **Step 2: Simulate a Telegram webhook call for an Instagram URL**

```bash
curl -X POST http://localhost:8080/telegram/webhook \
  -H 'Content-Type: application/json' \
  -d '{"update_id":1,"message":{"message_id":1,"chat":{"id":123456},"from":{"username":"tester"},"text":"https://www.instagram.com/reel/CxTestExample/"}}'
```
Expected: `OK` response within milliseconds (no multi-second wait — confirms the webhook is intake-only now).

- [ ] **Step 3: Verify the job landed in the queue and gets claimed**

```bash
docker exec -i soundreel-db psql -U soundreel -d soundreel -c \
  "SELECT id, platform, status, attempts, chat_id FROM job_queue ORDER BY created_at DESC LIMIT 5;"
```
Expected: a row with `platform='instagram'`. Re-run a couple seconds later — `status` should move from `queued` → `processing` → `done` (or `queued` again with `attempts=1` if Instaloader isn't reachable locally, which is fine for this check).

- [ ] **Step 4: Verify IG serialization + jitter**

Send two Instagram URLs back-to-back (same curl as Step 2, different URLs). Confirm via the same `psql` query and the backend's console logs that the second job's `status` stays `queued` until the first reaches a terminal state (`done`/`failed`) or is retried, and that there's a visible ~30-90s gap between the two dispatch attempts in the logs.

- [ ] **Step 5: Verify crash recovery**

While a job is `processing`, kill the backend process (`Ctrl+C`) and restart it (`npm run dev`). Expected: the boot log shows `Requeued 1 job(s) stuck in 'processing'...`, and the `psql` query shows that job back to `status='queued'`, subsequently picked up again.

This task has no commit — it's verification only. Once it passes, the feature is ready; production deploy (`touch .rebuild`) is a separate, explicit step for the user to trigger, not part of this plan.

---

## Post-implementation notes (final whole-branch review)

**Task 6 was only partially run.** The local `soundreel-db` container's actual Postgres password has drifted from `backend/.env`'s `DB_PASSWORD` (pre-existing, unrelated to this feature — the container predates this work). The user didn't have the current password on hand, so the live boot → webhook → queue → worker → crash-recovery round trip was not executed. What was verified instead: the `job_queue` schema is intact via `docker exec` (bypasses app-level auth), and the full backend test suite (124/124) passes at the final commit. Recommended follow-up once the password drift is resolved: one boot smoke test covering the boot log's requeue line and one real webhook round trip.

**Accepted limitation — IG retry does not engage for pipeline-level scrape failures.** `POST /api/analyze` returns HTTP 200 with `{ success: false, error }` for its own failures (`instaloader_download_failed`, `challenge_required`, etc. — see `backend/src/routes/analyze.ts`). Since `dispatch()` in `jobQueueWorker.ts` only treats a thrown `fetch`/non-2xx response as a failure, a `success:false` response is currently treated as a completed dispatch: the job is marked `done` and the user gets `formatAnalysisError`'s message immediately, with **no retry**. The 3-attempt `[60s,180s,420s]` backoff therefore only ever fires for transport-level failures (network errors, non-2xx `/api/analyze` responses), not for Instagram-specific scrape failures reported via `success:false` — which are the dominant real-world failure mode this feature was built to survive. This was raised explicitly during the final review and the user chose to keep the current behavior as-is rather than change `dispatch()` to also retry on `success:false`. Recorded here so it reads as a deliberate scope decision, not an oversight, if revisited later.

**Other minor findings, accepted as low-risk / pre-existing-pattern, not changed:**
- `markJobDone` itself throwing after a successful analyze isn't isolated the way the Telegram-notify failure now is — it still falls into `handleFailure` and could retry/fail an already-succeeded job. Low-risk because `/api/analyze` is idempotent by `sourceUrl` when `allowDuplicateUrls` is off (returns the cached completed entry); if that feature flag is enabled, a retry after this would trigger a full re-scrape. Not fixed — documented.
- `igNextAllowedAt` resets to 0 on process restart, so a requeued IG job (via `requeueStuckJobs()`) dispatches immediately on boot rather than preserving the jitter window. Negligible for a single-user app that rarely restarts.
- `enqueueJob` has no dedup against an already-queued job for the same `entry_id` — a duplicate Telegram delivery or repeated user paste could enqueue two rows for the same URL. Matches the old fire-and-forget code's existing duplication risk (not a regression); IG's serialization incidentally masks it there, other-platform jobs could still race on `findEntryByUrl` before either completes.
