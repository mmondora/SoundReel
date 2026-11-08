import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/ollamaClient', () => ({ generateText: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { backfillSoftware, fetchCandidates, parseArgs, type Deps } from './backfillSoftware';
import type { SoftwareExtraction } from '../services/softwareExtraction';

const row = (id: string, caption: string | null, extra: Record<string, unknown> = {}) => ({
  id, source_platform: 'instagram', caption, transcript: null, overlay: null, ...extra,
});
const CLOUDFLARE = 'Security Audit Skill è la skill open source di Cloudflare che trova le falle: su GitHub 65.000 stelle.';
const WINE = 'Cena al mare con Franco, che vino! Questo lo voglio riassaggiare, davvero buonissimo #estate';

const found = (...titles: string[]): SoftwareExtraction => ({ items: titles.map((title) => ({ title, url: null, tag: 'product' as const, description: null })), usage: null, outcome: 'found' });

function deps(rows: unknown[], over: Partial<Deps> = {}) {
  const say: string[] = [];
  const saved: Array<[string, string[]]> = [];
  const recorded: Array<[string, string, number]> = [];
  const d: Deps = {
    db: { query: vi.fn(async () => ({ rows })) } as never,
    extract: vi.fn(async () => found('Security Audit Skill')),
    save: vi.fn(async (id: string, items) => { saved.push([id, items.map((i) => i.title)]); return true; }),
    record: vi.fn(async (id: string, outcome: string, n: number) => { recorded.push([id, outcome, n]); }),
    say: (line) => say.push(line),
    ...over,
  };
  return { d, say, saved, recorded };
}

describe('parseArgs', () => {
  it('reads the flags', () => {
    expect(parseArgs(['--dry-run', '--limit', '5', '--since', '2026-10-01'])).toEqual({ dryRun: true, since: '2026-10-01', limit: 5 });
    expect(parseArgs([])).toEqual({ dryRun: false, since: null, limit: null });
  });
  it('refuses nonsense', () => {
    expect(() => parseArgs(['--since', 'ieri'])).toThrow(/YYYY-MM-DD/);
    expect(() => parseArgs(['--limit', '0'])).toThrow(/intero positivo/);
    expect(() => parseArgs(['--limit', 'x'])).toThrow(/intero positivo/);
  });
});

describe('fetchCandidates', () => {
  it('asks for completed entries with text, no software and no earlier pass, never the library entries', async () => {
    const { d } = deps([]);
    await fetchCandidates(d.db, { since: '2026-10-01', limit: null });
    const [text, params] = vi.mocked(d.db.query).mock.calls[0] as unknown as [string, unknown[]];
    expect(text).toMatch(/e\.status = 'completed'/);
    expect(text).toMatch(/source_platform NOT IN \('shazam', 'spotify'\)/);
    expect(text).toMatch(/jsonb_array_length\(e\.results->'software'\), 0\) = 0/);
    expect(text).toMatch(/a->>'action' = 'backfill_software'/);
    expect(params).toEqual([40, '2026-10-01', null]);
  });

  it('keeps only the texts that hint at software (the extractor\'s own gate)', async () => {
    const { d } = deps([row('a', CLOUDFLARE), row('b', WINE), row('c', null, { transcript: 'Ho provato Cursor con il plugin per Claude Code, davvero comodo per lavorare.' })]);
    const list = await fetchCandidates(d.db, { since: null, limit: null });
    expect(list.map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('a limit asks the database for more (the gate drops some) and then cuts to the limit', async () => {
    const { d } = deps([row('a', CLOUDFLARE), row('b', CLOUDFLARE), row('c', CLOUDFLARE)]);
    const list = await fetchCandidates(d.db, { since: null, limit: 2 });
    expect(vi.mocked(d.db.query).mock.calls[0][1]).toEqual([40, null, 8]);
    expect(list.map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('backfillSoftware', () => {
  it('a dry run lists the candidates and calls nothing', async () => {
    const m = deps([row('a', CLOUDFLARE), row('b', WINE)]);
    const s = await backfillSoftware(m.d, { dryRun: true, since: null, limit: null });
    expect(s).toEqual({ candidates: 1, withSoftware: 0, items: 0, failed: 0 });
    expect(m.d.extract).not.toHaveBeenCalled();
    expect(m.d.save).not.toHaveBeenCalled();
    expect(m.say.join('\n')).toMatch(/DRY RUN/);
    expect(m.say.join('\n')).toMatch(/a {2}instagram/);
  });

  it('writes what it finds, records the pass, and says which tools', async () => {
    const m = deps([row('a', CLOUDFLARE)], { extract: vi.fn(async () => found('Security Audit Skill', 'Claude Code')) });
    const s = await backfillSoftware(m.d, { dryRun: false, since: null, limit: null });
    expect(s).toEqual({ candidates: 1, withSoftware: 1, items: 2, failed: 0 });
    expect(m.saved).toEqual([['a', ['Security Audit Skill', 'Claude Code']]]);
    expect(m.recorded).toEqual([['a', 'found', 2]]);
    expect(m.say.join('\n')).toMatch(/Security Audit Skill, Claude Code/);
  });

  it('records an entry where the model found nothing, so the next run does not ask again', async () => {
    const m = deps([row('a', CLOUDFLARE)], { extract: vi.fn(async () => ({ items: [], usage: null, outcome: 'none' as const })) });
    await backfillSoftware(m.d, { dryRun: false, since: null, limit: null });
    expect(m.d.save).not.toHaveBeenCalled();
    expect(m.recorded).toEqual([['a', 'none', 0]]);
  });

  it('does NOT record a failed call: a busy router is not an answer, the next run asks again', async () => {
    const m = deps([row('a', CLOUDFLARE), row('b', CLOUDFLARE)], {
      extract: vi.fn().mockResolvedValueOnce({ items: [], usage: null, outcome: 'failed' }).mockResolvedValueOnce(found('Cursor')),
    });
    const s = await backfillSoftware(m.d, { dryRun: false, since: null, limit: null });
    expect(s).toMatchObject({ failed: 1, withSoftware: 1 });
    expect(m.recorded.map((r) => r[0])).toEqual(['b']);
  });

  it('when a concurrent analysis already stored software, it writes nothing and counts nothing', async () => {
    const m = deps([row('a', CLOUDFLARE)], { save: vi.fn(async () => false) });
    const s = await backfillSoftware(m.d, { dryRun: false, since: null, limit: null });
    expect(s.withSoftware).toBe(0);
    expect(m.recorded).toEqual([['a', 'found', 0]]);
  });
});
