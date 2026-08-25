# Whisper asincrono — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Togliere la trascrizione dal percorso sincrono della pipeline e farla svolgere da un job dedicato che sopravvive ad archi-pc spento, recuperando anche le 488 entry storiche con audio ma senza transcript.

**Architecture:** `job_queue` guadagna una colonna `kind` (`analyze` | `transcribe`) e una `priority`. La pipeline accoda un `transcribe` invece di attendere whisper. Il worker, prima di tentare, verifica che whisper risponda: se non risponde rimette in coda con backoff lungo senza consumare tentativi e **senza svegliare nessuno**. A trascrizione ottenuta accoda una seconda passata di analisi che fonde i risultati invece di sostituirli.

**Tech Stack:** TypeScript strict, Fastify, PostgreSQL 17 con query dirette `pg`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-25-whisper-async-design.md`

## Global Constraints

- **Nessun wake per la trascrizione.** Il job non scrive mai la sentinella `/wake/archi.wake`. La soglia del wake di Ollama è 8 richieste in 300s proprio perché un contenuto singolo non deve accendere un PC.
- Whisper irraggiungibile **non** è un fallimento: il job torna in coda con backoff lungo e `attempts` **invariato**.
- Il merge della seconda passata è **additivo**: nulla viene mai rimosso, nemmeno se la nuova analisi non lo ritrova.
- Il `summary` si scrive **solo se era vuoto**.
- Un job `reanalyze` non accoda mai un `transcribe`.
- Nessuna notifica Telegram sulla seconda passata né sul backfill (`notify = false`).
- Il percorso audio è deterministico: `/data/media/<entryId>/audio.wav`.
- TypeScript strict, nessun `any` (regola di progetto in `CLAUDE.md`).
- Nessuna chiamata reale a whisper, Ollama, Telegram o Instagram nei test — sempre mock.
- Test: `cd /home/mike/works/Soundreel/backend && npm test` (606 verdi oggi). Typecheck: `npm run typecheck`.

## File Structure

| File | Responsabilità |
|---|---|
| `backend/src/db/migrations/009_job_kind_priority.sql` | **nuovo** — colonne `kind`, `priority`, indice |
| `backend/src/db/init.sql` | stesse colonne, per un database creato da zero |
| `backend/src/utils/jobQueue.ts` | `kind` e `priority` nei tipi, in `enqueueJob` e nell'ordinamento del claim |
| `backend/src/services/whisperClient.ts` | `isWhisperReachable()` |
| `backend/src/services/jobQueueWorker.ts` | ramo `transcribe` nel dispatch |
| `backend/src/routes/analyze.ts` | accoda invece di attendere; flag `reanalyze`; merge additivo |
| `backend/src/services/entryMerge.ts` | **nuovo** — la fusione additiva, isolata e testabile da sola |
| `backend/src/scripts/backfillTranscripts.ts` | **nuovo** — accoda lo storico |

---

### Task 1: Colonne `kind` e `priority`

**Files:**
- Create: `/home/mike/works/Soundreel/backend/src/db/migrations/009_job_kind_priority.sql`
- Modify: `/home/mike/works/Soundreel/backend/src/db/init.sql` (blocco `job_queue`, intorno a riga 130)
- Modify: `/home/mike/works/Soundreel/backend/src/utils/jobQueue.ts`
- Test: `/home/mike/works/Soundreel/backend/src/utils/jobQueue.test.ts` (**nuovo**)

**Interfaces:**
- Produces: `JobKind = 'analyze' | 'transcribe'`; `JobQueueRow.kind`, `JobQueueRow.priority`; `enqueueJob({..., kind?, priority?})`; `claimNextTranscribeJob()`

- [ ] **Step 1: Scrivi la migration**

Crea `009_job_kind_priority.sql`:

```sql
-- Async transcription: a job is either the analysis pass or the deferred
-- Whisper run that feeds it. Existing rows are analysis jobs.
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'analyze';

-- Backfilled history yields to anything the user just sent: claim orders by
-- priority first, so 10 always waits behind 0.
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_job_queue_kind
  ON job_queue (kind, status, priority, next_attempt_at);
```

Aggiungi le stesse tre istruzioni in `init.sql`, subito dopo il blocco che
crea `job_queue`, accanto agli altri `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
già presenti lì.

- [ ] **Step 2: Scrivi il test che fallisce**

Crea `backend/src/utils/jobQueue.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
const withClientMock = vi.fn();

vi.mock('./db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  withClient: (...args: unknown[]) => withClientMock(...args),
}));

describe('enqueueJob', () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    queryMock.mockResolvedValue([{ id: 1 }]);
  });

  it('defaults to an analyze job at priority 0', async () => {
    const { enqueueJob } = await import('./jobQueue');
    await enqueueJob({
      entryId: 'e1', sourceUrl: 'https://x/1', platform: 'other',
      chatId: 42, inputUser: null,
    });
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params).toContain('analyze');
    expect(params).toContain(0);
  });

  it('carries an explicit kind and priority', async () => {
    const { enqueueJob } = await import('./jobQueue');
    await enqueueJob({
      entryId: 'e2', sourceUrl: 'https://x/2', platform: 'other',
      chatId: 42, inputUser: null, kind: 'transcribe', priority: 10,
    });
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params).toContain('transcribe');
    expect(params).toContain(10);
  });
});
```

- [ ] **Step 3: Esegui il test e verifica che fallisca**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/utils/jobQueue.test.ts`
Expected: FAIL — `kind` non è una proprietà accettata da `enqueueJob`

- [ ] **Step 4: Estendi `jobQueue.ts`**

Aggiungi il tipo accanto agli altri in cima al file:

```ts
export type JobKind = 'analyze' | 'transcribe';
```

In `JobQueueRow` aggiungi:

```ts
  kind: JobKind;
  /** Lower runs first. Backfilled history uses 10 so it yields to new content. */
  priority: number;
```

In `JobQueueDbRow` aggiungi `kind: string;` e `priority: number;`, e in
`rowToJob`:

```ts
    kind: (row.kind as JobKind) ?? 'analyze',
    priority: row.priority ?? 0,
```

In `enqueueJob` aggiungi i due parametri opzionali alla firma:

```ts
  /** Defaults to the analysis pass. */
  kind?: JobKind;
  /** Lower runs first; defaults to 0. */
  priority?: number;
```

e la query diventa:

```ts
  const rows = await query<{ id: number }>(
    `INSERT INTO job_queue (entry_id, source_url, platform, chat_id, input_user, notify, next_attempt_at, kind, priority)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, NOW()),$8,$9)
     RETURNING id`,
    [job.entryId, job.sourceUrl, job.platform, job.chatId, job.inputUser,
     job.notify ?? true, job.nextAttemptAt ?? null,
     job.kind ?? 'analyze', job.priority ?? 0]
  );
```

- [ ] **Step 5: Esegui il test e verifica che passi**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/utils/jobQueue.test.ts`
Expected: PASS, 2 test

- [ ] **Step 6: Separa i claim per `kind`**

I due claim esistenti devono servire solo i job di analisi, altrimenti
prenderebbero anche i `transcribe` e li manderebbero a `/api/analyze`.

Modifica le due funzioni e aggiungine una terza:

```ts
export function claimNextInstagramJob(): Promise<JobQueueRow | null> {
  return claimNext(`kind = 'analyze' AND platform = 'instagram'`);
}

export function claimNextOtherJob(): Promise<JobQueueRow | null> {
  return claimNext(`kind = 'analyze' AND platform <> 'instagram'`);
}

export function claimNextTranscribeJob(): Promise<JobQueueRow | null> {
  return claimNext(`kind = 'transcribe'`);
}
```

- [ ] **Step 7: Ordina il claim per priorità**

Dentro `claimNext`, la `SELECT` deve ordinare per `priority ASC` **prima** di
`next_attempt_at ASC`. Apri la funzione, trova la `ORDER BY` esistente e
anteponi `priority ASC,`. Se non c'è un `ORDER BY`, aggiungilo prima di
`FOR UPDATE SKIP LOCKED`:

```sql
       ORDER BY priority ASC, next_attempt_at ASC
```

- [ ] **Step 8: Esegui typecheck e suite completa**

```bash
cd /home/mike/works/Soundreel/backend
npm run typecheck
npm test
```
Expected: entrambi PASS, nessuna regressione sui 606 test esistenti

- [ ] **Step 9: Commit**

```bash
cd /home/mike/works/Soundreel
git add backend/src/db/migrations/009_job_kind_priority.sql backend/src/db/init.sql backend/src/utils/jobQueue.ts backend/src/utils/jobQueue.test.ts
git commit -m "feat(queue): add job kind and priority

Transcription becomes its own kind of job, and backfilled history gets a
priority that always yields to whatever the user just sent."
```

---

### Task 2: `isWhisperReachable`

**Files:**
- Modify: `/home/mike/works/Soundreel/backend/src/services/whisperClient.ts`
- Test: `/home/mike/works/Soundreel/backend/src/services/whisperClient.test.ts` (**nuovo**)

**Interfaces:**
- Produces: `isWhisperReachable(): Promise<boolean>`

**Perché una funzione a parte.** Il worker deve distinguere "whisper non c'è"
da "whisper ha sbagliato". Il primo caso non consuma tentativi; il secondo sì.
`transcribeLocal` non può fare quella distinzione perché a quel punto ha già
caricato in memoria un file audio da diversi megabyte.

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `backend/src/services/whisperClient.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('isWhisperReachable', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.WHISPER_URL = 'http://whisper.test:9000';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is true when whisper answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    const { isWhisperReachable } = await import('./whisperClient');
    await expect(isWhisperReachable()).resolves.toBe(true);
  });

  it('is false when the connection is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const { isWhisperReachable } = await import('./whisperClient');
    await expect(isWhisperReachable()).resolves.toBe(false);
  });

  it('is false when WHISPER_URL is not configured', async () => {
    delete process.env.WHISPER_URL;
    vi.stubGlobal('fetch', vi.fn());
    const { isWhisperReachable } = await import('./whisperClient');
    await expect(isWhisperReachable()).resolves.toBe(false);
  });

  it('is false on a server error rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
    const { isWhisperReachable } = await import('./whisperClient');
    await expect(isWhisperReachable()).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/services/whisperClient.test.ts`
Expected: FAIL — `isWhisperReachable` non è esportata

- [ ] **Step 3: Implementa**

Aggiungi in fondo a `whisperClient.ts`:

```ts
/**
 * Cheap liveness probe. The transcription job uses it to tell "whisper is not
 * there" from "whisper failed": the first costs no attempt, the second does.
 * Kept separate from transcribeLocal, which by the time it can tell has
 * already read a multi-megabyte audio file into memory.
 */
export async function isWhisperReachable(): Promise<boolean> {
  const base = process.env.WHISPER_URL;
  if (!base) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/services/whisperClient.test.ts`
Expected: PASS, 4 test

- [ ] **Step 5: Commit**

```bash
cd /home/mike/works/Soundreel
git add backend/src/services/whisperClient.ts backend/src/services/whisperClient.test.ts
git commit -m "feat(whisper): add a cheap reachability probe

The deferred job needs to tell an absent service from a failing one: only
the second should burn a retry."
```

---

### Task 3: Il ramo `transcribe` nel worker

**Files:**
- Modify: `/home/mike/works/Soundreel/backend/src/services/jobQueueWorker.ts`
- Test: `/home/mike/works/Soundreel/backend/src/services/jobQueueWorker.test.ts` (esiste)

**Interfaces:**
- Consumes: `claimNextTranscribeJob`, `JobQueueRow.kind` (Task 1); `isWhisperReachable` (Task 2)
- Produces: `dispatchTranscribe(job: JobQueueRow): Promise<void>`; costante `TRANSCRIBE_RETRY_MS = 30 * 60 * 1000`

- [ ] **Step 1: Scrivi i test che falliscono**

Aggiungi in `jobQueueWorker.test.ts`:

```ts
describe('dispatchTranscribe', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reschedules without burning an attempt when whisper is unreachable', async () => {
    const scheduleJobRetry = vi.fn();
    const transcribeLocal = vi.fn();
    vi.doMock('../utils/jobQueue', () => ({
      scheduleJobRetry, markJobDone: vi.fn(), markJobFailed: vi.fn(),
      enqueueJob: vi.fn(), claimNextTranscribeJob: vi.fn(),
      claimNextInstagramJob: vi.fn(), claimNextOtherJob: vi.fn(),
    }));
    vi.doMock('./whisperClient', () => ({
      isWhisperReachable: vi.fn(async () => false),
      transcribeLocal,
    }));

    const { dispatchTranscribe, TRANSCRIBE_RETRY_MS } = await import('./jobQueueWorker');
    const job = { id: 7, entryId: 'e1', attempts: 2 } as never;
    await dispatchTranscribe(job);

    expect(transcribeLocal).not.toHaveBeenCalled();
    expect(scheduleJobRetry).toHaveBeenCalledTimes(1);
    // attempts unchanged — an absent service is not a failure
    expect(scheduleJobRetry.mock.calls[0][1]).toBe(2);
    const when = scheduleJobRetry.mock.calls[0][2] as Date;
    expect(when.getTime()).toBeGreaterThan(Date.now() + TRANSCRIBE_RETRY_MS - 5_000);
  });

  it('fails without retrying when the audio file is gone', async () => {
    const markJobFailed = vi.fn();
    const scheduleJobRetry = vi.fn();
    vi.doMock('../utils/jobQueue', () => ({
      scheduleJobRetry, markJobDone: vi.fn(), markJobFailed,
      enqueueJob: vi.fn(), claimNextTranscribeJob: vi.fn(),
      claimNextInstagramJob: vi.fn(), claimNextOtherJob: vi.fn(),
    }));
    vi.doMock('./whisperClient', () => ({
      isWhisperReachable: vi.fn(async () => true),
      transcribeLocal: vi.fn(),
    }));
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return { ...actual, promises: { ...actual.promises, access: vi.fn(async () => { throw new Error('ENOENT'); }) } };
    });

    const { dispatchTranscribe } = await import('./jobQueueWorker');
    await dispatchTranscribe({ id: 8, entryId: 'gone', attempts: 0 } as never);

    expect(markJobFailed).toHaveBeenCalledWith(8);
    expect(scheduleJobRetry).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/services/jobQueueWorker.test.ts -t dispatchTranscribe`
Expected: FAIL — `dispatchTranscribe` non è esportata

- [ ] **Step 3: Implementa il ramo**

In cima a `jobQueueWorker.ts` aggiungi agli import esistenti:

```ts
import { promises as fs } from 'fs';
import path from 'path';
import { isWhisperReachable, transcribeLocal } from './whisperClient';
import { updateEntry, appendActionLog, createActionLog } from '../utils/entries';
```

Adatta i percorsi di `updateEntry`/`appendActionLog`/`createActionLog` a quelli
realmente usati da `analyze.ts` — verificali lì prima di scrivere l'import.

Poi aggiungi:

```ts
/**
 * Whisper lives on a machine that is powered off most of the time, and we
 * deliberately do not wake it for transcription — that is what the Ollama wake
 * threshold exists to prevent. So an unreachable service is not a failure: the
 * job simply waits half an hour and asks again.
 */
export const TRANSCRIBE_RETRY_MS = 30 * 60 * 1000;

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/data/media';

export async function dispatchTranscribe(job: JobQueueRow): Promise<void> {
  const log = new Logger('jobQueueWorker');

  if (!(await isWhisperReachable())) {
    await scheduleJobRetry(job.id, job.attempts, new Date(Date.now() + TRANSCRIBE_RETRY_MS));
    log.info(`Job ${job.id}: whisper non raggiungibile, riprovo fra 30 minuti`);
    return;
  }

  const audioPath = path.join(MEDIA_ROOT, job.entryId, 'audio.wav');
  try {
    await fs.access(audioPath);
  } catch {
    await markJobFailed(job.id);
    await appendActionLog(job.entryId, createActionLog('whisper_asr', {
      status: 'error',
      reason: 'audio file missing',
      path: audioPath,
    }));
    return;
  }

  const asr = await transcribeLocal(audioPath);
  await appendActionLog(job.entryId, createActionLog('whisper_asr', {
    status: asr.status,
    reason: asr.reason || null,
    language: asr.language,
    chars: asr.text?.length || 0,
    durationMs: asr.durationMs,
  }));

  if (asr.status === 'error') {
    // A service that answered and then failed is a real failure: let the
    // existing backoff table count this attempt.
    await handleFailure(job, new Error(asr.reason || 'whisper error'), log);
    return;
  }

  if (asr.text) {
    await updateEntry(job.entryId, { 'results.transcript': asr.text });
    await enqueueJob({
      entryId: job.entryId,
      sourceUrl: job.sourceUrl,
      platform: job.platform,
      chatId: job.chatId,
      inputUser: job.inputUser,
      notify: false,
      kind: 'analyze',
      priority: job.priority,
    });
  }

  await markJobDone(job.id);
}
```

- [ ] **Step 4: Collega il claim nel `tick`**

In `tick`, dopo il ciclo `while (state.otherInFlight < OTHER_CONCURRENCY_CAP)`,
aggiungi un claim per la trascrizione che riusa lo stesso contatore di
concorrenza:

```ts
  while (state.otherInFlight < OTHER_CONCURRENCY_CAP) {
    state.otherInFlight++;
    const job = await claimNextTranscribeJob();
    if (!job) {
      state.otherInFlight--;
      break;
    }
    void dispatchTranscribe(job).finally(() => {
      state.otherInFlight--;
    });
  }
```

- [ ] **Step 5: Esegui i test e verifica che passino**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/services/jobQueueWorker.test.ts`
Expected: PASS, compresi i test preesistenti del worker

- [ ] **Step 6: Verifica che nessuna sentinella venga scritta**

```bash
cd /home/mike/works/Soundreel/backend
grep -rn "archi.wake\|WAKE_SENTINEL" src/ || echo "nessun riferimento alla sentinella — corretto"
```
Expected: `nessun riferimento alla sentinella — corretto`. Il vincolo globale
dice che la trascrizione non sveglia archi-pc: questo lo verifica meccanicamente.

- [ ] **Step 7: Typecheck e suite completa**

```bash
cd /home/mike/works/Soundreel/backend
npm run typecheck && npm test
```

- [ ] **Step 8: Commit**

```bash
cd /home/mike/works/Soundreel
git add backend/src/services/jobQueueWorker.ts backend/src/services/jobQueueWorker.test.ts
git commit -m "feat(queue): run transcription as its own job

An unreachable Whisper reschedules without burning an attempt — the machine
it runs on is off most of the time, and we do not wake it to transcribe."
```

---

### Task 4: La pipeline accoda invece di attendere

**Files:**
- Modify: `/home/mike/works/Soundreel/backend/src/routes/analyze.ts:384-405`
- Test: `/home/mike/works/Soundreel/backend/src/routes/analyze.transcribe.test.ts` (**nuovo**)

**Interfaces:**
- Consumes: `enqueueJob` con `kind: 'transcribe'` (Task 1)

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `backend/src/routes/analyze.transcribe.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * A structural test: the pipeline must not call transcribeLocal any more.
 * The full analyze route is too tangled to exercise end to end here, and the
 * property that matters — transcription left the synchronous path — is
 * exactly what a source-level assertion pins.
 */
describe('analyze route transcription', () => {
  const source = readFileSync(
    path.join(__dirname, 'analyze.ts'),
    'utf8'
  );

  it('does not call transcribeLocal inline', () => {
    expect(source).not.toMatch(/await\s+transcribeLocal\(/);
  });

  it('enqueues a transcribe job instead', () => {
    expect(source).toMatch(/kind:\s*'transcribe'/);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/routes/analyze.transcribe.test.ts`
Expected: FAIL sul primo test — `await transcribeLocal(` è ancora presente

- [ ] **Step 3: Sostituisci il blocco**

In `analyze.ts`, il blocco che inizia con
`if (featuresConfig.transcriptionEnabled && localPaths?.audioPath) {` diventa:

```ts
          // Transcription no longer blocks the pipeline. Whisper runs on a
          // machine that is powered off most of the time, so waiting bought
          // nothing; the entry completes now and the transcript arrives later
          // through a job, which then triggers a second analysis pass.
          if (featuresConfig.transcriptionEnabled && localPaths?.audioPath) {
            await enqueueJob({
              entryId,
              sourceUrl: normalizedUrl,
              platform: isInstagram ? 'instagram' : 'other',
              chatId: 0,
              inputUser: user ?? null,
              notify: false,
              kind: 'transcribe',
            });
            await appendActionLog(entryId, createActionLog('whisper_asr', {
              status: 'queued',
              reason: null,
            }));
          } else {
            await appendActionLog(entryId, createActionLog('whisper_asr', {
              status: 'skipped',
              reason: !featuresConfig.transcriptionEnabled ? 'disabled in settings' : 'no audio path',
            }));
          }
```

Rimuovi l'import ora inutilizzato di `transcribeLocal` in cima al file.
`transcript` e `transcriptLanguage` restano dichiarate e valgono `null` per
questa passata: l'analisi AI le riceve così e degrada come già fa oggi quando
whisper non risponde.

Verifica i nomi esatti delle variabili in scope (`normalizedUrl`, `isInstagram`,
`user`) leggendo il contesto circostante prima di scrivere.

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/routes/analyze.transcribe.test.ts`
Expected: PASS, 2 test

- [ ] **Step 5: Typecheck e suite completa**

```bash
cd /home/mike/works/Soundreel/backend
npm run typecheck && npm test
```
Expected: PASS. Se qualche test esistente si aspettava un transcript sincrono,
è una scoperta legittima: riportala invece di adattare il test in silenzio.

- [ ] **Step 6: Commit**

```bash
cd /home/mike/works/Soundreel
git add backend/src/routes/analyze.ts backend/src/routes/analyze.transcribe.test.ts
git commit -m "feat(analyze): queue transcription instead of waiting for it

Whisper answers on a machine that is off most of the time, so the wait cost
the pipeline minutes and returned nothing."
```

---

### Task 5: Seconda passata con merge additivo

**Files:**
- Create: `/home/mike/works/Soundreel/backend/src/services/entryMerge.ts`
- Create: `/home/mike/works/Soundreel/backend/src/services/entryMerge.test.ts`
- Modify: `/home/mike/works/Soundreel/backend/src/routes/analyze.ts` (idempotenza, riga ~145; scrittura dei risultati)

**Interfaces:**
- Consumes: `normalizeSongKey`, `normalizeFilmKey` da `resultMerger.ts`; `noteKey` da `noteMeta.ts`
- Produces: `mergeEntryResults(existing: EntryResults, incoming: EntryResults): EntryResults`

**Il cuore del rischio.** 488 entry storiche già arricchite passeranno di qui.

- [ ] **Step 1: Scrivi i test che falliscono**

Crea `backend/src/services/entryMerge.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mergeEntryResults } from './entryMerge';
import type { EntryResults } from '../types';

const empty = (): EntryResults => ({
  songs: [], films: [], notes: [], links: [], tags: [], summary: null,
});

describe('mergeEntryResults', () => {
  it('keeps a song the second pass no longer finds', () => {
    const existing = { ...empty(), songs: [{ title: 'Roma', artist: 'Baustelle', album: null }] };
    const incoming = { ...empty(), songs: [] };
    expect(mergeEntryResults(existing, incoming).songs).toHaveLength(1);
  });

  it('adds a song the second pass discovered', () => {
    const existing = { ...empty(), songs: [{ title: 'Roma', artist: 'Baustelle', album: null }] };
    const incoming = { ...empty(), songs: [{ title: 'Charlie', artist: 'Baustelle', album: null }] };
    expect(mergeEntryResults(existing, incoming).songs).toHaveLength(2);
  });

  it('does not duplicate the same song across casing and spacing', () => {
    const existing = { ...empty(), songs: [{ title: 'Roma', artist: 'Baustelle', album: null }] };
    const incoming = { ...empty(), songs: [{ title: '  roma ', artist: 'BAUSTELLE', album: null }] };
    expect(mergeEntryResults(existing, incoming).songs).toHaveLength(1);
  });

  it('keeps an existing summary untouched', () => {
    const existing = { ...empty(), summary: 'Riassunto scritto al primo giro' };
    const incoming = { ...empty(), summary: 'Riassunto nuovo con transcript' };
    expect(mergeEntryResults(existing, incoming).summary).toBe('Riassunto scritto al primo giro');
  });

  it('fills a summary that was missing', () => {
    const existing = { ...empty(), summary: null };
    const incoming = { ...empty(), summary: 'Riassunto nuovo con transcript' };
    expect(mergeEntryResults(existing, incoming).summary).toBe('Riassunto nuovo con transcript');
  });

  it('treats an empty-string summary as missing', () => {
    const existing = { ...empty(), summary: '   ' };
    const incoming = { ...empty(), summary: 'Riassunto nuovo' };
    expect(mergeEntryResults(existing, incoming).summary).toBe('Riassunto nuovo');
  });

  it('merges notes by key without losing existing ones', () => {
    const existing = { ...empty(), notes: [{ text: 'Trattoria da Elio', category: 'place' as const }] };
    const incoming = { ...empty(), notes: [{ text: 'Libro consigliato', category: 'book' as const }] };
    const out = mergeEntryResults(existing, incoming);
    expect(out.notes).toHaveLength(2);
  });

  it('unions tags without duplicates', () => {
    const existing = { ...empty(), tags: ['#roma', '@baustelle'] };
    const incoming = { ...empty(), tags: ['#roma', '#musica'] };
    expect(mergeEntryResults(existing, incoming).tags.sort()).toEqual(['#musica', '#roma', '@baustelle']);
  });

  it('keeps the incoming transcript', () => {
    const existing = { ...empty(), transcript: null };
    const incoming = { ...empty(), transcript: 'testo trascritto' };
    expect(mergeEntryResults(existing, incoming).transcript).toBe('testo trascritto');
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/services/entryMerge.test.ts`
Expected: FAIL — il modulo `entryMerge` non esiste

- [ ] **Step 3: Implementa**

Crea `backend/src/services/entryMerge.ts`:

```ts
import type { EntryResults } from '../types';
import { noteKey } from './noteMeta';

function songKey(title: string, artist: string): string {
  return `${title.toLowerCase().trim()}::${artist.toLowerCase().trim()}`;
}

function filmKey(title: string): string {
  return title.toLowerCase().trim();
}

function isBlank(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0;
}

/**
 * Fold a second analysis pass into an entry that already has results.
 *
 * Additive by design: this runs over hundreds of archived entries whose songs,
 * films and notes already carry enrichment keyed off their original text. A
 * pass that dropped anything the model failed to find the second time would
 * quietly destroy work that cannot be recovered.
 *
 * The summary is the exception that proves the rule — it is one string, so it
 * cannot be merged. An existing one is kept: it may well be better than what a
 * second pass produces, and there is no way to compare hundreds of them.
 */
export function mergeEntryResults(existing: EntryResults, incoming: EntryResults): EntryResults {
  const songs = [...existing.songs];
  const seenSongs = new Set(songs.map((s) => songKey(s.title, s.artist)));
  for (const s of incoming.songs) {
    const k = songKey(s.title, s.artist);
    if (!seenSongs.has(k)) {
      seenSongs.add(k);
      songs.push(s);
    }
  }

  const films = [...existing.films];
  const seenFilms = new Set(films.map((f) => filmKey(f.title)));
  for (const f of incoming.films) {
    const k = filmKey(f.title);
    if (!seenFilms.has(k)) {
      seenFilms.add(k);
      films.push(f);
    }
  }

  const notes = [...existing.notes];
  const seenNotes = new Set(notes.map((n) => noteKey(n.category, n.text)));
  for (const n of incoming.notes) {
    const k = noteKey(n.category, n.text);
    if (!seenNotes.has(k)) {
      seenNotes.add(k);
      notes.push(n);
    }
  }

  const links = [...existing.links];
  const seenLinks = new Set(links.map((l) => l.url));
  for (const l of incoming.links) {
    if (!seenLinks.has(l.url)) {
      seenLinks.add(l.url);
      links.push(l);
    }
  }

  return {
    ...existing,
    songs,
    films,
    notes,
    links,
    tags: [...new Set([...existing.tags, ...incoming.tags])],
    summary: isBlank(existing.summary) ? incoming.summary : existing.summary,
    transcript: incoming.transcript ?? existing.transcript ?? null,
  };
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/services/entryMerge.test.ts`
Expected: PASS, 9 test

- [ ] **Step 5: Aggiungi il flag `reanalyze` alla rotta**

In `analyze.ts`, il corpo della richiesta accetta un campo opzionale
`reanalyze?: boolean`. Il controllo di idempotenza alla riga ~145 diventa:

```ts
      if (!featuresConfig.allowDuplicateUrls && !reanalyze) {
        const existingEntry = await findEntryByUrl(normalizedUrl);
        ...
      }
```

e quando `reanalyze` è vero, l'`entryId` va risolto dall'entry esistente invece
di generarne uno nuovo:

```ts
      if (reanalyze) {
        const existingEntry = await findEntryByUrl(normalizedUrl);
        if (!existingEntry) {
          reply.code(404).send({ success: false, error: 'reanalyze: entry non trovata' });
          return;
        }
        entryId = existingEntry.id;
      }
```

Senza questo, `analyze.ts:148` restituirebbe la entry già `completed` e la
seconda passata non farebbe nulla.

- [ ] **Step 6: Applica il merge in scrittura**

Trova il punto in cui `analyze.ts` scrive `results` sulla entry al termine
dell'analisi. Quando `reanalyze` è vero, prima di scrivere:

```ts
      if (reanalyze) {
        const before = await getEntry(entryId);
        if (before) {
          finalResults = mergeEntryResults(before.results, finalResults);
        }
      }
```

Adatta il nome della variabile dei risultati a quello realmente usato nel file.

- [ ] **Step 7: Il worker passa il flag**

In `jobQueueWorker.ts`, `dispatch` invia al body anche `reanalyze` quando il job
lo richiede. Poiché il job di seconda passata è distinguibile solo dal fatto che
`notify` è falso — che vale anche per i repair — aggiungi un campo esplicito al
body:

```ts
      body: JSON.stringify({
        url: job.sourceUrl,
        channel: 'telegram',
        user: job.inputUser,
        reanalyze: job.kind === 'analyze' && !job.notify,
      }),
```

Questo è volutamente conservativo: un repair silenzioso viene trattato come una
ri-analisi, cioè fonde invece di sostituire. È il comportamento più sicuro dei
due.

- [ ] **Step 8: Typecheck e suite completa**

```bash
cd /home/mike/works/Soundreel/backend
npm run typecheck && npm test
```

- [ ] **Step 9: Commit**

```bash
cd /home/mike/works/Soundreel
git add backend/src/services/entryMerge.ts backend/src/services/entryMerge.test.ts backend/src/routes/analyze.ts backend/src/services/jobQueueWorker.ts
git commit -m "feat(analyze): merge the second pass instead of replacing it

Hundreds of archived entries carry enrichment keyed off their original text.
A pass that dropped what the model missed the second time would destroy work
that cannot be recovered, so the merge only ever adds."
```

---

### Task 6: Script di backfill

**Files:**
- Create: `/home/mike/works/Soundreel/backend/src/scripts/backfillTranscripts.ts`
- Test: `/home/mike/works/Soundreel/backend/src/scripts/backfillTranscripts.test.ts`

**Interfaces:**
- Consumes: `enqueueJob` con `kind: 'transcribe'` e `priority: 10` (Task 1)
- Produces: `selectBackfillCandidates(entries, hasAudio): string[]`

**Non eseguire lo script.** Questo task lo scrive e lo testa. L'esecuzione
avviene solo dopo che i Task 1-5 sono verdi **in produzione** sui contenuti
nuovi: accodare 488 job su un merge non ancora provato sul campo è il modo più
rapido di rovinare lo storico, e non è reversibile.

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `backend/src/scripts/backfillTranscripts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { selectBackfillCandidates } from './backfillTranscripts';

describe('selectBackfillCandidates', () => {
  const hasAudio = (id: string) => id.startsWith('audio');

  it('selects entries with audio and no transcript', () => {
    const rows = [
      { id: 'audio-1', transcript: null, pendingTranscribe: false },
      { id: 'audio-2', transcript: '', pendingTranscribe: false },
    ];
    expect(selectBackfillCandidates(rows, hasAudio)).toEqual(['audio-1', 'audio-2']);
  });

  it('skips entries that already have a transcript', () => {
    const rows = [{ id: 'audio-3', transcript: 'già trascritto', pendingTranscribe: false }];
    expect(selectBackfillCandidates(rows, hasAudio)).toEqual([]);
  });

  it('skips entries with no audio on disk', () => {
    const rows = [{ id: 'noaudio-1', transcript: null, pendingTranscribe: false }];
    expect(selectBackfillCandidates(rows, hasAudio)).toEqual([]);
  });

  it('is idempotent: skips entries already queued', () => {
    const rows = [{ id: 'audio-4', transcript: null, pendingTranscribe: true }];
    expect(selectBackfillCandidates(rows, hasAudio)).toEqual([]);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/scripts/backfillTranscripts.test.ts`
Expected: FAIL — il modulo non esiste

- [ ] **Step 3: Implementa**

Crea `backend/src/scripts/backfillTranscripts.ts`:

```ts
import { promises as fs } from 'fs';
import path from 'path';
import { query } from '../utils/db';
import { enqueueJob } from '../utils/jobQueue';

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/data/media';
/** Two minutes apart, so Whisper is never saturated by history. */
const STAGGER_MS = 2 * 60 * 1000;
/** Always behind anything the user just sent. */
const BACKFILL_PRIORITY = 10;

export interface BackfillRow {
  id: string;
  transcript: string | null;
  pendingTranscribe: boolean;
}

export function selectBackfillCandidates(
  rows: BackfillRow[],
  hasAudio: (entryId: string) => boolean
): string[] {
  return rows
    .filter((r) => !r.transcript || r.transcript.trim().length === 0)
    .filter((r) => !r.pendingTranscribe)
    .filter((r) => hasAudio(r.id))
    .map((r) => r.id);
}

async function main(): Promise<void> {
  const rows = await query<{ id: string; source_url: string; transcript: string | null; pending: boolean }>(
    `SELECT e.id,
            e.source_url,
            e.results->>'transcript' AS transcript,
            EXISTS (
              SELECT 1 FROM job_queue j
              WHERE j.entry_id = e.id AND j.kind = 'transcribe'
                AND j.status IN ('queued','processing')
            ) AS pending
       FROM entries e
      ORDER BY e.created_at DESC`
  );

  const byId = new Map(rows.map((r) => [r.id, r]));
  const present = new Set<string>();
  for (const r of rows) {
    try {
      await fs.access(path.join(MEDIA_ROOT, r.id, 'audio.wav'));
      present.add(r.id);
    } catch {
      // no audio on disk — nothing to transcribe
    }
  }

  const candidates = selectBackfillCandidates(
    rows.map((r) => ({ id: r.id, transcript: r.transcript, pendingTranscribe: r.pending })),
    (id) => present.has(id)
  );

  let queued = 0;
  for (const id of candidates) {
    const row = byId.get(id);
    if (!row) continue;
    await enqueueJob({
      entryId: id,
      sourceUrl: row.source_url,
      platform: 'other',
      chatId: 0,
      inputUser: null,
      notify: false,
      kind: 'transcribe',
      priority: BACKFILL_PRIORITY,
      nextAttemptAt: new Date(Date.now() + queued * STAGGER_MS),
    });
    queued++;
  }

  console.log(`Accodate ${queued} trascrizioni storiche su ${rows.length} entry esaminate.`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/scripts/backfillTranscripts.test.ts`
Expected: PASS, 4 test

- [ ] **Step 5: Registra il comando in package.json**

Aggiungi agli `scripts` di `backend/package.json`, accanto agli altri:

```json
    "backfill:transcripts": "node dist/scripts/backfillTranscripts.js",
```

- [ ] **Step 6: Typecheck e suite completa**

```bash
cd /home/mike/works/Soundreel/backend
npm run typecheck && npm test
```

- [ ] **Step 7: Commit — senza eseguire lo script**

```bash
cd /home/mike/works/Soundreel
git add backend/src/scripts/backfillTranscripts.ts backend/src/scripts/backfillTranscripts.test.ts backend/package.json
git commit -m "feat(scripts): queue transcription for archived entries

Not run yet: 488 second passes over already-enriched entries wait until the
merge has proven itself in production on new content."
```

---

## Verifica finale

- [ ] **Suite verde e typecheck pulito**

```bash
cd /home/mike/works/Soundreel/backend && npm run typecheck && npm test
```

- [ ] **La trascrizione ha lasciato il percorso sincrono**

```bash
grep -n "transcribeLocal" /home/mike/works/Soundreel/backend/src/routes/analyze.ts || echo "analyze.ts non chiama piu transcribeLocal — corretto"
```

- [ ] **Nessuna sentinella di wake nel backend**

```bash
grep -rn "archi.wake\|WAKE_SENTINEL" /home/mike/works/Soundreel/backend/src/ || echo "nessun wake dalla trascrizione — corretto"
```

- [ ] **Deploy e migration**

```bash
touch /home/mike/works/Soundreel/.rebuild
sleep 90 && head -3 /home/mike/works/Soundreel/.rebuild-log
docker exec soundreel-db psql -U soundreel -d soundreel -c "\d job_queue" | grep -E "kind|priority"
```
Expected: `status: ok`, e le due colonne presenti.

- [ ] **Un reel con audio accoda invece di attendere**

Manda un reel con video al bot. La risposta deve arrivare **senza** attendere la
trascrizione. Poi:

```bash
docker exec soundreel-db psql -U soundreel -d soundreel -c "SELECT id, kind, status, priority, next_attempt_at FROM job_queue WHERE kind='transcribe' ORDER BY id DESC LIMIT 3;"
```
Expected: un job `transcribe` in stato `queued`.

- [ ] **Con whisper giù, il job aspetta senza consumare tentativi**

Con archi-pc spento, controlla lo stesso job dopo qualche minuto:

```bash
docker exec soundreel-db psql -U soundreel -d soundreel -c "SELECT id, attempts, next_attempt_at FROM job_queue WHERE kind='transcribe' ORDER BY id DESC LIMIT 1;"
docker logs soundreel --since 10m 2>&1 | grep -i "whisper non raggiungibile"
```
Expected: `attempts` resta a 0 e `next_attempt_at` è spostato di circa 30 minuti.

- [ ] **Con whisper su, la trascrizione arriva e scatta la seconda passata**

Con archi-pc acceso e whisper attivo, attendi il ciclo e verifica:

```bash
docker exec soundreel-db psql -U soundreel -d soundreel -c "SELECT id, status FROM job_queue WHERE kind='transcribe' ORDER BY id DESC LIMIT 1;"
docker logs soundreel --since 30m 2>&1 | grep -iE "whisper_asr|reanalyze"
```
Expected: job `done`, transcript salvato, e un job `analyze` silenzioso accodato.

- [ ] **Il merge non ha rimosso nulla**

Prendi una entry che aveva canzoni prima della seconda passata e confronta:

```bash
docker exec soundreel-db psql -U soundreel -d soundreel -c "SELECT id, jsonb_array_length(results->'songs') AS songs, LEFT(results->>'summary', 60) AS summary FROM entries WHERE results->>'transcript' IS NOT NULL ORDER BY created_at DESC LIMIT 5;"
```
Expected: il numero di canzoni non è mai diminuito e i summary preesistenti sono
invariati.

- [ ] **Solo allora, il backfill**

```bash
docker exec soundreel node dist/scripts/backfillTranscripts.js
```
Expected: stampa quante ne accoda. Da eseguire **soltanto** dopo che il punto
precedente ha confermato il merge sul campo.
