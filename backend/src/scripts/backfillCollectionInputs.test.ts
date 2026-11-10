import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/db', () => ({ getEntry: vi.fn(), pool: { end: vi.fn() }, query: vi.fn(), withClient: vi.fn() }));
vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

import { backfillCollectionInputs, parseArgs, type ScriptDeps } from './backfillCollectionInputs';
import { MemoryCollectionsStore } from '../services/collectionsStore';
import type { ParsedPlacesAndVenues, PlacesSource } from '../services/entryPlaces';
import type { Entry } from '../types';

// The one-off run that gives a vector and the places and venues to every entry already in the library (Raccolte, task 4; ADR-0022). The preview is the
// default; `--apply` is for Michele's OK, in the container, once. The rule of what is missing is the pipeline's own (`planInputs`): here only the
// arguments, the report and the wiring to the one-entry-at-a-time loop are checked, with the memory store and spies instead of the models.

const SUMMARY = 'Tre trattorie a Milano che non conosci: Trattoria Da Gigi, Bar Luce e Osteria del Borgo.';
const entry = (id: string, summary: string | null = `${SUMMARY} ${id}`, owner = 'mike'): Entry =>
  ({
    id, sourceUrl: `https://x/${id}`, sourcePlatform: 'instagram', inputChannel: 'web', inputUser: null, ownerUser: owner, caption: null, thumbnailUrl: null,
    mediaUrl: null, status: 'completed', results: { songs: [], films: [], notes: [], links: [], tags: [], summary }, actionLog: [], createdAt: '2026-11-01T10:00:00.000Z',
  }) as unknown as Entry;

function script(entries: Entry[]) {
  const store = new MemoryCollectionsStore();
  const lines: string[] = [];
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0.5]));
  const places = vi.fn<(source: PlacesSource) => Promise<ParsedPlacesAndVenues | null>>(async () => ({ place: { name: 'Milano', kind: 'city' }, venues: [] }));
  const sleep = vi.fn(async () => undefined);
  const deps: ScriptDeps = {
    store,
    getEntry: async (id) => entries.find((e) => e.id === id) ?? null,
    embed,
    places,
    listEntryIds: vi.fn(async (owner: string | null) => entries.filter((e) => owner === null || e.ownerUser === owner).map((e) => e.id)),
    sleep,
    say: (line) => lines.push(line),
  };
  return { deps, store, lines, embed, places, sleep };
}

describe('parseArgs', () => {
  it('is a preview by default: nothing is written without --apply', () => {
    expect(parseArgs([])).toEqual({ apply: false, limit: null, owner: null, delayMs: 300 });
    expect(parseArgs(['--dry-run'])).toEqual({ apply: false, limit: null, owner: null, delayMs: 300 });
  });

  it('reads --apply, --limit, --owner and --delay-ms', () => {
    expect(parseArgs(['--apply', '--limit', '25', '--owner', 'mike', '--delay-ms', '1000'])).toEqual({ apply: true, limit: 25, owner: 'mike', delayMs: 1000 });
    expect(parseArgs(['--delay-ms', '0']).delayMs).toBe(0);
  });

  it('refuses to be told to do and not to do (--apply with --dry-run)', () => {
    expect(() => parseArgs(['--apply', '--dry-run'])).toThrow(/--apply/);
  });

  it('refuses nonsense instead of going on with the wrong run: a typo must not become a full run', () => {
    expect(() => parseArgs(['--limit', '0'])).toThrow(/--limit/);
    expect(() => parseArgs(['--limit', 'x'])).toThrow(/--limit/);
    expect(() => parseArgs(['--limit'])).toThrow(/--limit/);
    expect(() => parseArgs(['--limit', '2.5'])).toThrow(/--limit/);
    expect(() => parseArgs(['--owner'])).toThrow(/--owner/);
    expect(() => parseArgs(['--owner', '--apply'])).toThrow(/--owner/);
    expect(() => parseArgs(['--delay-ms', '-1'])).toThrow(/--delay-ms/);
    expect(() => parseArgs(['--delay-ms', 'soon'])).toThrow(/--delay-ms/);
    expect(() => parseArgs(['--apply', '--limt', '5'])).toThrow(/--limt/);
    expect(() => parseArgs(['--limit', '5', 'stray'])).toThrow(/stray/);
  });
});

describe('the preview (the default)', () => {
  it('says what is missing and calls no model, writes nothing, waits for nobody', async () => {
    const { deps, store, lines, embed, places, sleep } = script([entry('e1'), entry('e2'), entry('short', 'poco')]);
    const summary = await backfillCollectionInputs(deps, parseArgs([]));
    expect(summary).toMatchObject({ scanned: 3, needAny: 2, needVector: 2, needPlaces: 2, noText: 1, done: 0, pending: 0 });
    expect(embed).not.toHaveBeenCalled();
    expect(places).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect((await store.inputHashes(['e1', 'e2'])).size).toBe(0);
    expect(lines[0]).toMatch(/ANTEPRIMA/);
    expect(lines[0]).not.toMatch(/SCRIVE/);
    expect(lines[lines.length - 1]).toMatch(/da fare/);
    expect(lines[lines.length - 1]).toMatch(/2 voci/);
    expect(lines[lines.length - 1]).toMatch(/vettore: 2/);
    expect(lines[lines.length - 1]).toMatch(/luoghi: 2/);
    expect(lines[lines.length - 1]).toMatch(/senza testo: 1/);
  });
});

describe('the totals of the preview', () => {
  it('count the ENTRIES to work on once each (one that needs both is one entry), and say how many need each thing', async () => {
    const { deps, lines } = script([entry('e1'), entry('e2'), entry('e3')]);
    await backfillCollectionInputs(deps, parseArgs(['--apply', '--delay-ms', '0', '--limit', '1']));            // e1 is complete
    const text = `${SUMMARY} e2`;
    await deps.store.saveVector('e2', 'nomic-embed-text', [1, 1], (await import('../services/embeddings')).embeddingTextHash(text));   // e2 has its vector only
    lines.length = 0;
    const summary = await backfillCollectionInputs(deps, parseArgs([]));
    expect(summary).toMatchObject({ needAny: 2, needVector: 1, needPlaces: 2, upToDate: 1 });
    expect(lines[lines.length - 1]).toMatch(/da fare: 2 voci \(vettore: 1, luoghi: 2\)/);
    expect(lines[lines.length - 1]).toMatch(/già a posto: 1/);
  });

  it('say «1 voce», not «1 voci»', async () => {
    const { deps, lines } = script([entry('e1')]);
    await backfillCollectionInputs(deps, parseArgs([]));
    expect(lines[lines.length - 1]).toMatch(/da fare: 1 voce \(/);
  });
});

describe('--apply', () => {
  it('gives every entry its vector and its places, one at a time, and says it is writing', async () => {
    const { deps, store, lines, embed, places } = script([entry('e1'), entry('e2'), entry('e3')]);
    const summary = await backfillCollectionInputs(deps, parseArgs(['--apply', '--delay-ms', '0']));
    expect(summary).toMatchObject({ scanned: 3, done: 3, pending: 0 });
    expect(embed).toHaveBeenCalledTimes(3);
    expect(places).toHaveBeenCalledTimes(3);
    expect([...(await store.inputHashes(['e1', 'e2', 'e3'])).keys()]).toEqual(['e1', 'e2', 'e3']);
    expect(lines[0]).toMatch(/SCRIVE/);
    expect(lines[lines.length - 1]).toMatch(/fatto/);
    expect(lines[lines.length - 1]).toMatch(/3 voci/);
  });

  it('can be run again: the second run has nothing left to do and asks nobody', async () => {
    const { deps, embed, places, lines } = script([entry('e1'), entry('e2')]);
    await backfillCollectionInputs(deps, parseArgs(['--apply', '--delay-ms', '0']));
    embed.mockClear();
    places.mockClear();
    const again = await backfillCollectionInputs(deps, parseArgs(['--apply', '--delay-ms', '0']));
    expect(again).toMatchObject({ scanned: 2, upToDate: 2, done: 0 });
    expect(embed).not.toHaveBeenCalled();
    expect(places).not.toHaveBeenCalled();
    expect(lines[lines.length - 1]).toMatch(/già a posto: 2/);
  });

  it('passes the limit, the owner and the pause on to the loop', async () => {
    const { deps, sleep, embed } = script([entry('m1'), entry('m2'), entry('m3'), entry('a1', undefined, 'archi')]);
    const summary = await backfillCollectionInputs(deps, parseArgs(['--apply', '--owner', 'mike', '--limit', '2', '--delay-ms', '40']));
    expect(summary.scanned).toBe(2);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(40);
    expect(deps.listEntryIds).toHaveBeenCalledWith('mike');
  });

  it('counts the entries that failed as «da riprovare», and goes on with the others', async () => {
    const { deps, lines, embed } = script([entry('e1'), entry('e2'), entry('e3')]);
    embed.mockImplementation(async (texts: string[]) => {
      if (texts[0].includes('e2')) throw new Error('router asleep');
      return texts.map(() => [1, 1]);
    });
    const summary = await backfillCollectionInputs(deps, parseArgs(['--apply', '--delay-ms', '0']));
    expect(summary).toMatchObject({ done: 2, pending: 1 });
    expect(lines[lines.length - 1]).toMatch(/da riprovare: 1/);
  });
});
