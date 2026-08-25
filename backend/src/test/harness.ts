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
  /** Set only by dispatchTranscribe. Means: the media is on disk, fetch nothing. */
  reanalyze: boolean;
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
        reanalyze: false,
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
export function installHarness(h: Harness, dbPath = '../utils/db', logPath = '../utils/logger'): void {
  vi.doMock(dbPath, () => ({
    query: vi.fn(async () => []),
    updateEntry: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const e = h.entries.get(id);
      if (!e) return;
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'results.transcript') e.results.transcript = v as string;
        if (k === 'results.transcriptLanguage') e.results.transcriptLanguage = v as string;
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
    const idFromPath = (p: string) => String(p).split('/').slice(-2)[0];
    return {
      ...actual,
      promises: {
        ...actual.promises,
        access: vi.fn(async (p: string) => {
          if (!h.audioPresent.has(idFromPath(p))) throw new Error('ENOENT');
        }),
        // transcribeLocal (whisperClient.ts) stats and reads the file itself,
        // after dispatchTranscribe's own existence check — both must respect
        // the same fake "what's on disk" set or a present-audio test would
        // still hit the real filesystem and throw ENOENT for the wrong reason.
        stat: vi.fn(async (p: string) => {
          if (!h.audioPresent.has(idFromPath(p))) throw new Error('ENOENT');
          return { isFile: () => true, size: 1234 } as import('fs').Stats;
        }),
        readFile: vi.fn(async (p: string) => {
          if (!h.audioPresent.has(idFromPath(p))) throw new Error('ENOENT');
          return Buffer.from('fake-audio-bytes');
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
