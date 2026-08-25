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

- [ ] **Step 4b: Ricostruisci i percorsi locali senza scaricare nulla**

**Questo step esiste perché senza di esso il backfill riscaricherebbe 488
contenuti da Instagram.** `analyze.ts:297` chiama `extractContent()`, che alla
riga 36 di `contentExtractor.ts` invoca `downloadWithInstaloader`
**incondizionatamente**: non controlla mai se i file sono già in locale. È
esattamente ciò che il `CLAUDE.md` vieta, per non far bannare l'account.

Tutto ciò che serve è già su disco. Verificato su una directory reale:

```
audio.wav  frame-001.jpg … frame-007.jpg  thumbnail.jpg  thumbnail-source.jpg  video.mp4
```

Crea `backend/src/services/localMedia.ts`:

```ts
import { promises as fs } from 'fs';
import path from 'path';
import type { ExtractedContentLocalPaths } from '../types';

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/data/media';

/**
 * Rebuild the pipeline's local paths from what the first pass already left on
 * disk, so a re-analysis never touches the network.
 *
 * extractContent() downloads unconditionally — it has no "already have it"
 * branch — so routing a second pass through it would re-fetch hundreds of
 * posts from Instagram and risk the account. Everything needed is here.
 *
 * Returns null when the directory holds nothing usable. The caller must then
 * abandon the pass rather than fall back to downloading.
 */
export async function rebuildLocalPaths(entryId: string): Promise<ExtractedContentLocalPaths | null> {
  const dir = path.join(MEDIA_ROOT, entryId);

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }

  const pick = (name: string): string | null =>
    names.includes(name) ? path.join(dir, name) : null;

  const sortedMatching = (re: RegExp): string[] =>
    names.filter((n) => re.test(n)).sort().map((n) => path.join(dir, n));

  const paths: ExtractedContentLocalPaths = {
    videoPath: pick('video.mp4'),
    audioPath: pick('audio.wav'),
    thumbnailPath: pick('thumbnail.jpg') ?? pick('thumbnail-source.jpg'),
    slidePaths: sortedMatching(/^slide-\d+\.(jpg|jpeg|png|webp)$/i),
    framePaths: sortedMatching(/^frame-\d+\.(jpg|jpeg|png|webp)$/i),
  };

  const hasSomething =
    paths.videoPath || paths.audioPath || paths.thumbnailPath ||
    paths.slidePaths.length > 0 || paths.framePaths.length > 0;

  return hasSomething ? paths : null;
}
```

Crea `backend/src/services/localMedia.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('rebuildLocalPaths', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.MEDIA_ROOT = '/data/media';
  });

  async function withDir(names: string[]) {
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        promises: { ...actual.promises, readdir: vi.fn(async () => names) },
      };
    });
    const { rebuildLocalPaths } = await import('./localMedia');
    return rebuildLocalPaths('e1');
  }

  it('maps a full directory onto the pipeline shape', async () => {
    const out = await withDir([
      'audio.wav', 'video.mp4', 'thumbnail.jpg', 'thumbnail-source.jpg',
      'frame-001.jpg', 'frame-002.jpg',
    ]);
    expect(out?.audioPath).toBe('/data/media/e1/audio.wav');
    expect(out?.videoPath).toBe('/data/media/e1/video.mp4');
    expect(out?.thumbnailPath).toBe('/data/media/e1/thumbnail.jpg');
    expect(out?.framePaths).toHaveLength(2);
    expect(out?.slidePaths).toEqual([]);
  });

  it('orders frames numerically, not by discovery order', async () => {
    const out = await withDir(['frame-010.jpg', 'frame-002.jpg', 'frame-001.jpg']);
    expect(out?.framePaths).toEqual([
      '/data/media/e1/frame-001.jpg',
      '/data/media/e1/frame-002.jpg',
      '/data/media/e1/frame-010.jpg',
    ]);
  });

  it('falls back to the source thumbnail when the resized one is gone', async () => {
    const out = await withDir(['thumbnail-source.jpg']);
    expect(out?.thumbnailPath).toBe('/data/media/e1/thumbnail-source.jpg');
  });

  it('returns null for an empty directory rather than an empty shape', async () => {
    expect(await withDir([])).toBeNull();
  });

  it('returns null when the directory does not exist', async () => {
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        promises: { ...actual.promises, readdir: vi.fn(async () => { throw new Error('ENOENT'); }) },
      };
    });
    const { rebuildLocalPaths } = await import('./localMedia');
    expect(await rebuildLocalPaths('gone')).toBeNull();
  });

  it('ignores files that are not media', async () => {
    const out = await withDir(['audio.wav', 'notes.txt', 'frame-x.jpg']);
    expect(out?.framePaths).toEqual([]);
  });
});
```

Esegui: `cd /home/mike/works/Soundreel/backend && npx vitest run src/services/localMedia.test.ts`
Expected: prima FAIL (il modulo non esiste), poi PASS con 6 test.

- [ ] **Step 4c: Salta l'estrazione quando `reanalyze` è vero**

In `analyze.ts`, attorno alla chiamata `extractContent(normalizedUrl, extractOptions)`
alla riga ~297, inserisci il ramo alternativo:

```ts
        let content: ExtractedContent;
        if (reanalyze) {
          // Never re-download: extractContent() has no "already have it" branch,
          // so going through it would re-fetch this post from Instagram.
          const local = await rebuildLocalPaths(entryId);
          if (!local) {
            await appendActionLog(entryId, createActionLog('reanalyze', {
              status: 'skipped',
              reason: 'no local media to re-analyse',
            }));
            reply.send({ success: false, entryId, error: 'no local media' });
            return;
          }
          const prior = await getEntry(entryId);
          content = {
            caption: prior?.caption ?? null,
            thumbnailUrl: null,
            audioUrl: null,
            videoUrl: null,
            musicInfo: null,
            carouselUrls: [],
            localPaths: local,
          };
        } else {
          content = await extractContent(normalizedUrl, extractOptions);
        }
```

Adatta i nomi (`content`, `extractOptions`) a quelli realmente in scope, e
sposta la dichiarazione di `content` se era un `const` dell'assegnazione
originale.

**Verifica meccanicamente che il divieto tenga**, perché è la garanzia che il
backfill non contatti Instagram:

```bash
cd /home/mike/works/Soundreel/backend
npx vitest run src/services/localMedia.test.ts
grep -n "extractContent" src/routes/analyze.ts
```
La chiamata a `extractContent` deve comparire **solo** dentro il ramo `else`.

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

- [ ] **Step 7: Il worker passa il flag, che ha una colonna sua**

Una prima stesura ricavava `reanalyze` da `kind === 'analyze' && !job.notify`,
trattando ogni repair silenzioso come ri-analisi perché fondere è più sicuro che
sostituire. Quel ragionamento reggeva finché `reanalyze` significava solo
"fondi". Non regge più ora che significa anche "non scaricare mai":
`scripts/requeueErrors.ts:105` accoda proprio con `notify: false`, e **95 delle
96 entry in errore hanno la directory media vuota** — lo strumento di
riparazione sarebbe diventato inutile per l'intero arretrato.

Le due proprietà vanno separate.

Il merge diventa **incondizionato** al punto di scrittura: su risultati esistenti
vuoti è un'operazione nulla, che è esattamente il caso della riparazione, quindi
l'intento originale è soddisfatto senza alcun flag.

`reanalyze` diventa una colonna di `job_queue` (migration `010_job_reanalyze.sql`
più il DDL corrispondente in `init.sql`, stessa convenzione della 009), scritta
**solo** da `dispatchTranscribe`, con un unico significato: *i media sono su
disco, non scaricare niente*.

```ts
      body: JSON.stringify({
        url: job.sourceUrl,
        channel: 'telegram',
        user: job.inputUser,
        reanalyze: job.reanalyze,
      }),
```

Nessun nuovo `kind`: `kind` è portante nelle query di claim, e una corsia in più
rischierebbe job che nessuna funzione riesce a prendere.

Servono due test alle estremità della catena: che un repair silenzioso resti
`reanalyze: false` e quindi conservi il suo download, e che un job accodato da
`dispatchTranscribe` arrivi con `reanalyze: true`.

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

  it('bounds the wave when a limit is given', () => {
    const rows = [
      { id: 'audio-a', transcript: null, pendingTranscribe: false },
      { id: 'audio-b', transcript: null, pendingTranscribe: false },
      { id: 'audio-c', transcript: null, pendingTranscribe: false },
    ];
    expect(selectBackfillCandidates(rows, hasAudio, { limit: 2 })).toHaveLength(2);
  });

  it('puts the entries with the most to lose first', () => {
    const rows = [
      { id: 'audio-poor', transcript: null, pendingTranscribe: false, richness: 0 },
      { id: 'audio-rich', transcript: null, pendingTranscribe: false, richness: 9 },
    ];
    expect(selectBackfillCandidates(rows, hasAudio, { richestFirst: true, limit: 1 }))
      .toEqual(['audio-rich']);
  });

  it('keeps natural order when richestFirst is off', () => {
    const rows = [
      { id: 'audio-poor', transcript: null, pendingTranscribe: false, richness: 0 },
      { id: 'audio-rich', transcript: null, pendingTranscribe: false, richness: 9 },
    ];
    expect(selectBackfillCandidates(rows, hasAudio)).toEqual(['audio-poor', 'audio-rich']);
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
/**
 * No spacing by default. Measured: 489 clips, 0.9GB of mono 16kHz WAV — 8.4
 * hours of audio, about a minute each, which faster-whisper small clears in
 * one or two hours on the 5900X. An earlier draft spaced these two minutes
 * apart and would have spent sixteen hours waiting for ninety minutes of work,
 * guarding against a saturation that does not exist: Whisper runs on a
 * dedicated box with no rate limit, and BACKFILL_PRIORITY already keeps new
 * content in front. Kept configurable for the rare case someone wants a trickle.
 */
const STAGGER_MS = Number(process.env.BACKFILL_STAGGER_MS || 0);
/** Always behind anything the user just sent. */
const BACKFILL_PRIORITY = 10;

export interface BackfillRow {
  id: string;
  transcript: string | null;
  pendingTranscribe: boolean;
  /** How much this entry stands to lose if the merge is wrong. */
  richness?: number;
}

export interface BackfillOptions {
  /** Bound the wave. Undefined means every candidate. */
  limit?: number;
  /**
   * Put the entries with the most to lose first. The trial wave exists to catch
   * a merge that drops data, and only an entry that already carries songs,
   * films, notes or a summary can reveal that — a bare one would pass whatever
   * the merge did.
   */
  richestFirst?: boolean;
}

export function selectBackfillCandidates(
  rows: BackfillRow[],
  hasAudio: (entryId: string) => boolean,
  opts: BackfillOptions = {}
): string[] {
  const eligible = rows
    .filter((r) => !r.transcript || r.transcript.trim().length === 0)
    .filter((r) => !r.pendingTranscribe)
    .filter((r) => hasAudio(r.id));

  const ordered = opts.richestFirst
    ? [...eligible].sort((a, b) => (b.richness ?? 0) - (a.richness ?? 0))
    : eligible;

  const bounded = opts.limit === undefined ? ordered : ordered.slice(0, opts.limit);
  return bounded.map((r) => r.id);
}

async function main(): Promise<void> {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;
  const richestFirst = process.argv.includes('--richest');

  const rows = await query<{
    id: string; source_url: string; transcript: string | null;
    pending: boolean; richness: number;
  }>(
    `SELECT e.id,
            e.source_url,
            e.results->>'transcript' AS transcript,
            EXISTS (
              SELECT 1 FROM job_queue j
              WHERE j.entry_id = e.id AND j.kind = 'transcribe'
                AND j.status IN ('queued','processing')
            ) AS pending,
            -- how much this entry stands to lose if the merge is wrong
            (jsonb_array_length(COALESCE(e.results->'songs','[]'::jsonb))
             + jsonb_array_length(COALESCE(e.results->'films','[]'::jsonb))
             + jsonb_array_length(COALESCE(e.results->'notes','[]'::jsonb))
             + CASE WHEN COALESCE(e.results->>'summary','') <> '' THEN 1 ELSE 0 END) AS richness
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
    rows.map((r) => ({
      id: r.id, transcript: r.transcript, pendingTranscribe: r.pending, richness: Number(r.richness),
    })),
    (id) => present.has(id),
    { limit, richestFirst }
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

  console.log(
    `Accodate ${queued} trascrizioni storiche su ${rows.length} entry esaminate` +
    (limit !== undefined ? ` (ondata limitata a ${limit}${richestFirst ? ', le più ricche' : ''}).` : '.')
  );
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

- [ ] **Prima ondata: dieci entry, le più ricche**

Da eseguire **soltanto** dopo che il punto precedente ha confermato il merge su
contenuti nuovi.

```bash
docker exec soundreel node dist/scripts/backfillTranscripts.js --limit=10 --richest
```

Prima di lanciarlo, fotografa lo stato di quelle entry, perché è il confronto
che rende utile l'ondata di prova:

```bash
docker exec soundreel-db psql -U soundreel -d soundreel -c "
SELECT id,
       jsonb_array_length(COALESCE(results->'songs','[]'::jsonb)) AS songs,
       jsonb_array_length(COALESCE(results->'films','[]'::jsonb)) AS films,
       jsonb_array_length(COALESCE(results->'notes','[]'::jsonb)) AS notes,
       LEFT(COALESCE(results->>'summary',''), 50) AS summary
  FROM entries
 WHERE results->>'transcript' IS NULL
 ORDER BY (jsonb_array_length(COALESCE(results->'songs','[]'::jsonb))
         + jsonb_array_length(COALESCE(results->'films','[]'::jsonb))
         + jsonb_array_length(COALESCE(results->'notes','[]'::jsonb))) DESC
 LIMIT 10;" > /tmp/backfill-prima.txt
cat /tmp/backfill-prima.txt
```

- [ ] **Verifica l'ondata di prova prima di proseguire**

Attendi che i dieci job siano `done` e le rispettive seconde passate concluse,
poi rilancia la stessa query sugli stessi id e confronta con `/tmp/backfill-prima.txt`.

**Il conteggio di canzoni, film e note non deve essere diminuito su nessuna
entry, e nessun summary preesistente deve essere cambiato.** Se anche una sola
riga è peggiorata, fermati: il merge ha un difetto e le restanti 479 lo
subirebbero tutte.

```bash
docker exec soundreel-db psql -U soundreel -d soundreel -c "
SELECT id, jsonb_array_length(COALESCE(results->'songs','[]'::jsonb)) AS songs,
       jsonb_array_length(COALESCE(results->'films','[]'::jsonb)) AS films,
       jsonb_array_length(COALESCE(results->'notes','[]'::jsonb)) AS notes,
       LEFT(COALESCE(results->>'summary',''), 50) AS summary,
       LEFT(COALESCE(results->>'transcript',''), 40) AS transcript
  FROM entries WHERE results->>'transcript' IS NOT NULL
 ORDER BY created_at DESC LIMIT 10;"
```

- [ ] **Seconda ondata: tutto il resto**

Solo dopo che il confronto è pulito.

```bash
docker exec soundreel node dist/scripts/backfillTranscripts.js
```

Nessuno scaglionamento: misurato, sono 8,4 ore di audio che `faster-whisper`
`small` sul 5900X smaltisce in una o due ore. Archi-pc deve restare acceso per
quel tempo; whisper lavora a pieno carico e le seconde passate seguono a ruota
sullo stesso backend.

Controlla l'avanzamento con:

```bash
docker exec soundreel-db psql -U soundreel -d soundreel -c "
SELECT status, count(*) FROM job_queue WHERE kind='transcribe' GROUP BY status;"
```

---

### Task 7: Impalcatura e test funzionali del flusso

**Aggiunto in corso d'opera su richiesta esplicita.** I 612 test esistenti sono
tutti unitari con mock: verificano i pezzi, non l'orchestrazione. Le regressioni
che questo task previene sono quelle che nessun test unitario vede — "la
pipeline ha smesso di accodare", "un job di trascrizione è finito su
`/api/analyze`", "la seconda passata sostituisce invece di fondere".

L'impalcatura è deliberatamente riusabile: un piano successivo estenderà la
copertura funzionale alla pipeline di analisi esistente appoggiandosi a questa,
invece di costruirne un'altra.

**Files:**
- Create: `/home/mike/works/Soundreel/backend/src/test/harness.ts`
- Create: `/home/mike/works/Soundreel/backend/src/test/flows/whisperAsync.flow.test.ts`

**Interfaces:**
- Consumes: `dispatchTranscribe`, `TRANSCRIBE_RETRY_MS` (Task 3); `enqueueJob` (Task 1); `mergeEntryResults` (Task 5)
- Produces: `createHarness()`, `installHarness()`, `emptyResults()` — riusabili dal piano successivo

- [ ] **Step 1: Scrivi l'impalcatura**

Crea `backend/src/test/harness.ts`. L'archivio è in memoria; solo i confini
esterni — rete e filesystem — sono finti. Worker, coda e merge restano quelli
veri, che è tutto il punto dell'esercizio.

```ts
import { vi } from 'vitest';
import type { EntryResults } from '../types';

export interface FakeJob {
  id: number;
  entryId: string;
  sourceUrl: string;
  platform: 'instagram' | 'other';
  chatId: number;
  inputUser: string | null;
  status: 'queued' | 'processing' | 'done' | 'failed';
  attempts: number;
  notify: boolean;
  kind: 'analyze' | 'transcribe';
  priority: number;
}

export interface FakeEntry {
  id: string;
  sourceUrl: string;
  results: EntryResults;
  actionLog: Array<{ action: string; data: Record<string, unknown> }>;
}

/** Records every outbound attempt so a test can assert what the flow tried. */
export interface ExternalCalls {
  analyze: Array<Record<string, unknown>>;
  whisperProbe: number;
  whisperTranscribe: string[];
  telegram: Array<{ chatId: number; text: string }>;
}

export interface Harness {
  jobs: FakeJob[];
  entries: Map<string, FakeEntry>;
  calls: ExternalCalls;
  whisperUp: boolean;
  whisperText: string;
  /** Entry ids whose audio.wav is on disk. */
  audioPresent: Set<string>;
  nextJobId: number;
  addEntry(id: string, results?: Partial<EntryResults>): FakeEntry;
  addJob(job: Partial<FakeJob> & { entryId: string }): FakeJob;
}

export function emptyResults(): EntryResults {
  return { songs: [], films: [], notes: [], links: [], tags: [], summary: null };
}

export function createHarness(): Harness {
  const h: Harness = {
    jobs: [],
    entries: new Map(),
    calls: { analyze: [], whisperProbe: 0, whisperTranscribe: [], telegram: [] },
    whisperUp: false,
    whisperText: 'testo trascritto',
    audioPresent: new Set(),
    nextJobId: 1,
    addEntry(id, results) {
      const e: FakeEntry = {
        id,
        sourceUrl: `https://example.test/${id}`,
        results: { ...emptyResults(), ...results },
        actionLog: [],
      };
      h.entries.set(id, e);
      return e;
    },
    addJob(job) {
      const j: FakeJob = {
        id: h.nextJobId++,
        sourceUrl: `https://example.test/${job.entryId}`,
        platform: 'other',
        chatId: 1,
        inputUser: null,
        status: 'queued',
        attempts: 0,
        notify: true,
        kind: 'analyze',
        priority: 0,
        ...job,
      };
      h.jobs.push(j);
      return j;
    },
  };
  return h;
}

/**
 * Swap the db layer, the filesystem probe and the network for the harness.
 *
 * Paths are relative to the file that calls this, so they are the fragile part:
 * a path that does not match what the worker imports leaves the real module in
 * place and the test passes for the wrong reason. Step 4 of this task exists to
 * rule that out.
 */
export function installHarness(h: Harness, dbPath = '../../utils/db', logPath = '../../utils/logger'): void {
  vi.doMock(dbPath, () => ({
    updateEntry: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const e = h.entries.get(id);
      if (!e) return;
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'results.transcript') e.results.transcript = v as string;
      }
    }),
    appendActionLog: vi.fn(async (id: string, entry: { action: string; data: Record<string, unknown> }) => {
      h.entries.get(id)?.actionLog.push(entry);
    }),
    getEntry: vi.fn(async (id: string) => h.entries.get(id) ?? null),
    findEntryByUrl: vi.fn(async (url: string) =>
      [...h.entries.values()].find((e) => e.sourceUrl === url) ?? null),
  }));

  vi.doMock(logPath, () => ({
    createActionLog: (action: string, data: Record<string, unknown>) => ({ action, data }),
    logError: vi.fn(),
    logInfo: vi.fn(),
    logWarning: vi.fn(),
  }));

  vi.doMock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
      ...actual,
      promises: {
        ...actual.promises,
        access: vi.fn(async (p: string) => {
          const id = String(p).split('/').slice(-2)[0];
          if (!h.audioPresent.has(id)) throw new Error('ENOENT');
        }),
      },
    };
  });

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/analyze')) {
      h.calls.analyze.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ success: true, entryId: 'x' }), { status: 200 });
    }
    if (url.includes('api.telegram.org')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { chat_id: number; text: string };
      h.calls.telegram.push({ chatId: body.chat_id, text: body.text });
      return new Response('{"ok":true}', { status: 200 });
    }
    if (url.includes('whisper')) {
      const isProbe = /\/?$/.test(url) && !url.includes('asr');
      if (isProbe) {
        h.calls.whisperProbe++;
        return new Response('', { status: h.whisperUp ? 200 : 502 });
      }
      h.calls.whisperTranscribe.push(url);
      if (!h.whisperUp) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ text: h.whisperText, language: 'it' }), { status: 200 });
    }
    throw new Error(`harness: unexpected fetch to ${url}`);
  }));
}
```

- [ ] **Step 2: Scrivi i test di flusso che falliscono**

Crea `backend/src/test/flows/whisperAsync.flow.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHarness, installHarness, type Harness } from '../harness';

const WHISPER = 'http://whisper.test:9000';

describe('flusso whisper asincrono', () => {
  let h: Harness;

  beforeEach(() => {
    vi.resetModules();
    h = createHarness();
    process.env.WHISPER_URL = WHISPER;
    process.env.MEDIA_ROOT = '/data/media';
  });

  it('con whisper spento rimanda senza consumare tentativi', async () => {
    h.whisperUp = false;
    h.addEntry('e1');
    h.audioPresent.add('e1');
    const job = h.addJob({ entryId: 'e1', kind: 'transcribe', attempts: 2 });

    const scheduled: Array<{ attempts: number; when: Date }> = [];
    vi.doMock('../../utils/jobQueue', () => ({
      scheduleJobRetry: vi.fn(async (_id: number, attempts: number, when: Date) => {
        scheduled.push({ attempts, when });
      }),
      markJobDone: vi.fn(), markJobFailed: vi.fn(), enqueueJob: vi.fn(),
      claimNextTranscribeJob: vi.fn(), claimNextInstagramJob: vi.fn(), claimNextOtherJob: vi.fn(),
    }));
    installHarness(h);

    const { dispatchTranscribe, TRANSCRIBE_RETRY_MS } = await import('../../services/jobQueueWorker');
    await dispatchTranscribe(job as never);

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].attempts).toBe(2);
    expect(scheduled[0].when.getTime()).toBeGreaterThan(Date.now() + TRANSCRIBE_RETRY_MS - 5_000);
    expect(h.calls.whisperTranscribe).toHaveLength(0);
    expect(h.calls.analyze).toHaveLength(0);
  });

  it('con whisper acceso trascrive e accoda una seconda passata silenziosa', async () => {
    h.whisperUp = true;
    h.addEntry('e2');
    h.audioPresent.add('e2');
    const job = h.addJob({ entryId: 'e2', kind: 'transcribe' });

    const enqueued: Array<Record<string, unknown>> = [];
    vi.doMock('../../utils/jobQueue', () => ({
      scheduleJobRetry: vi.fn(), markJobDone: vi.fn(), markJobFailed: vi.fn(),
      enqueueJob: vi.fn(async (j: Record<string, unknown>) => { enqueued.push(j); return 99; }),
      claimNextTranscribeJob: vi.fn(), claimNextInstagramJob: vi.fn(), claimNextOtherJob: vi.fn(),
    }));
    installHarness(h);

    const { dispatchTranscribe } = await import('../../services/jobQueueWorker');
    await dispatchTranscribe(job as never);

    expect(h.entries.get('e2')?.results.transcript).toBe('testo trascritto');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].kind).toBe('analyze');
    expect(enqueued[0].notify).toBe(false);
  });

  it('senza audio sul disco fallisce senza riprovare', async () => {
    h.whisperUp = true;
    h.addEntry('e3');
    const job = h.addJob({ entryId: 'e3', kind: 'transcribe' });

    const failed: number[] = [];
    const retried: number[] = [];
    vi.doMock('../../utils/jobQueue', () => ({
      scheduleJobRetry: vi.fn(async (id: number) => { retried.push(id); }),
      markJobDone: vi.fn(), markJobFailed: vi.fn(async (id: number) => { failed.push(id); }),
      enqueueJob: vi.fn(),
      claimNextTranscribeJob: vi.fn(), claimNextInstagramJob: vi.fn(), claimNextOtherJob: vi.fn(),
    }));
    installHarness(h);

    const { dispatchTranscribe } = await import('../../services/jobQueueWorker');
    await dispatchTranscribe(job as never);

    expect(failed).toEqual([job.id]);
    expect(retried).toEqual([]);
    const log = h.entries.get('e3')?.actionLog ?? [];
    expect(log.some((l) => l.data.reason === 'audio file missing')).toBe(true);
  });

  it('la seconda passata fonde e non perde canzoni gia trovate', async () => {
    const { mergeEntryResults } = await import('../../services/entryMerge');
    const existing = {
      songs: [{ title: 'Roma', artist: 'Baustelle', album: null }],
      films: [], notes: [], links: [], tags: [], summary: 'riassunto originale',
    };
    const incoming = {
      songs: [], films: [], notes: [], links: [], tags: [],
      summary: 'riassunto nuovo', transcript: 'testo',
    };
    const out = mergeEntryResults(existing as never, incoming as never);

    expect(out.songs).toHaveLength(1);
    expect(out.summary).toBe('riassunto originale');
    expect(out.transcript).toBe('testo');
  });
});
```

- [ ] **Step 3: Esegui e verifica che falliscano**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/test/flows/whisperAsync.flow.test.ts`
Expected: FAIL — l'impalcatura o i percorsi dei mock non sono ancora a posto.

- [ ] **Step 4: Fai passare i test, poi dimostra che valgono qualcosa**

Aggiusta i percorsi relativi finché i mock intercettano davvero i moduli che il
worker importa. Se un percorso non combacia il mock non si applica, il test
chiama il codice vero e **può passare per il motivo sbagliato**: è la modalità
di fallimento più insidiosa di questa impalcatura.

Per escluderla, togli temporaneamente il ramo `isWhisperReachable` da
`dispatchTranscribe` e verifica che il primo test **fallisca**. Poi rimettilo.
Riporta l'output di entrambe le esecuzioni: un test di flusso che passa anche
senza il codice che dovrebbe verificare non vale niente, e questa è l'unica
prova che non sia così.

- [ ] **Step 5: Esegui typecheck e suite completa**

```bash
cd /home/mike/works/Soundreel/backend
npm run typecheck && npm test
```
Expected: PASS, con 4 test in più rispetto al conteggio precedente.

- [ ] **Step 6: Commit**

```bash
cd /home/mike/works/Soundreel
git add backend/src/test/harness.ts backend/src/test/flows/whisperAsync.flow.test.ts
git commit -m "test: cover the async transcription flow end to end

The existing tests are all mocked units: they check the pieces, not how they
fit together. These drive the real worker with only the network and the
filesystem faked, so a regression that stops the pipeline enqueuing — or lets
the second pass replace instead of merge — fails a test rather than reaching
production."
```
