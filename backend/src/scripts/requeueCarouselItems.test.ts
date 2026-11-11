import { describe, expect, it, vi } from 'vitest';
import type { EntrySlide } from '../types';
import type { SlideItem } from '../services/slideItems';
import { fetchCandidates, parseArgs, requeueCarouselItems, type Candidate, type Deps } from './requeueCarouselItems';

// The carousels analysed before 11 November read «itemsFound: 0» whatever they listed (the model's answer was one object, the code wanted a list): on the real library only
// ONE of 883 carousels with OCR text ever gave an item. This script reads their stored slides again with the mended extraction (only our own Ollama: no download, no OCR),
// shows what it finds, and with --apply puts the second pass of the entries that gain songs in the serial lane.

const slide = (index: number, ocrText: string | null): EntrySlide => ({ index, imageUrl: null, ocrText, visualDescription: null, summary: null, links: [] });
const candidate = (id: string, ocrs: Array<string | null> = ['Drake\nNothing Was The Same', 'Portishead\nDummy', 'x']): Candidate => ({
  id, source_url: `https://www.instagram.com/p/${id}`, source_platform: 'instagram', input_user: 'mike', caption: 'album da ascoltare #musica', slides: ocrs.map((t, i) => slide(i, t)),
});
const song = (title: string, type: SlideItem['type'] = 'album'): SlideItem => ({ type, title, artist: null, director: null, year: null, notes: null, sourceSlide: 0 });

function deps(over: Partial<Deps> & { rows?: Candidate[]; items?: Record<string, SlideItem[]> } = {}): Deps & { lines: string[]; enqueued: Array<Record<string, unknown>>; recorded: Array<[string, number]> } {
  const lines: string[] = [];
  const enqueued: Array<Record<string, unknown>> = [];
  const recorded: Array<[string, number]> = [];
  const items = over.items ?? {};
  const rows = over.rows ?? [];
  return {
    db: { query: vi.fn(async (sql: string) => ({ rows: /FROM entries/.test(sql) ? rows : [{ chat_id: '42' }] })) } as never,
    aboutMusic: over.aboutMusic ?? (async () => true),
    extract: over.extract ?? (async (texts) => items[texts.map((t) => t.text).join('|')] ?? []),
    enqueue: over.enqueue ?? (async (job) => { enqueued.push(job as never); }),
    record: over.record ?? (async (id, songs) => { recorded.push([id, songs]); }),
    say: over.say ?? ((l) => { lines.push(l); }),
    lines, enqueued, recorded,
  };
}

describe('parseArgs', () => {
  it('is a preview by default: at least 3 slides with text, at least 2 songs, silent', () => {
    expect(parseArgs([])).toEqual({ apply: false, notify: false, since: null, limit: null, minSlides: 3, minItems: 2 });
  });
  it('reads the flags', () => {
    expect(parseArgs(['--apply', '--notify', '--since', '2026-11-01', '--limit', '30', '--min-slides', '5', '--min-items', '3'])).toEqual({ apply: true, notify: true, since: '2026-11-01', limit: 30, minSlides: 5, minItems: 3 });
  });
  it('refuses a value that is not what the flag wants', () => {
    expect(() => parseArgs(['--since', 'ieri'])).toThrow(/YYYY-MM-DD/);
    expect(() => parseArgs(['--limit', '0'])).toThrow(/intero positivo/);
    expect(() => parseArgs(['--min-slides', 'x'])).toThrow(/min-slides/);
    expect(() => parseArgs(['--min-items', '0'])).toThrow(/min-items/);
  });
});

describe('fetchCandidates: the carousels whose slides were never read', () => {
  it('asks for the entries with enough slides with OCR text whose last extraction found nothing (or never ran), not already queued, newest first, with the three parameters', async () => {
    const d = deps({ rows: [candidate('a')] });
    const rows = await fetchCandidates(d.db, { since: '2026-11-01', limit: 10, minSlides: 4 });
    expect(rows.map((r) => r.id)).toEqual(['a']);
    const [sql, params] = (d.db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(sql)).toMatch(/results->'slides'/);
    expect(String(sql)).toMatch(/e\.caption/);
    expect(String(sql)).toMatch(/ocrText/);
    expect(String(sql)).toMatch(/carousel_extraction/);
    expect(String(sql)).toMatch(/itemsFound/);
    expect(String(sql)).toMatch(/job_queue/);
    expect(String(sql)).toMatch(/ORDER BY e\.created_at DESC/);
    expect(params).toEqual([4, '2026-11-01', 10]);
  });
});

describe('requeueCarouselItems', () => {
  const a = candidate('a');
  const b = candidate('b', ['Un solo disco\nTitolo', null, null, 'altro']);
  const items = (c: Candidate): string => c.slides.filter((s) => s.ocrText).map((s) => s.ocrText).join('|');

  it('a PREVIEW reads the slides, says what it finds and queues nothing', async () => {
    const d = deps({ rows: [a, b], items: { [items(a)]: [song('Nothing Was The Same'), song('Dummy'), song('Taxi Driver', 'film')], [items(b)]: [song('Titolo')] } });
    const out = await requeueCarouselItems(d, { apply: false, notify: false, since: null, limit: null, minSlides: 3, minItems: 2 });
    expect(out).toEqual({ candidates: 2, notMusic: 0, unsure: 0, withItems: 2, enough: 1, songs: 3, queued: 0, failed: 0 });
    expect(d.enqueued).toEqual([]);
    expect(d.recorded).toEqual([]);
    expect(d.lines.join('\n')).toMatch(/PREVIEW|ANTEPRIMA/i);
    // a preview asks the database ONE thing (the carousels): it does not even look for the chat the jobs would answer to
    expect((d.db.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('--apply queues the second pass of the entries that gain at least min-items songs or albums, silent, in the serial lane, and writes a line in the log of each', async () => {
    const d = deps({ rows: [a, b], items: { [items(a)]: [song('Nothing Was The Same'), song('Dummy', 'song'), song('Taxi Driver', 'film')], [items(b)]: [song('Titolo')] } });
    const out = await requeueCarouselItems(d, { apply: true, notify: false, since: null, limit: null, minSlides: 3, minItems: 2 });
    expect(out).toMatchObject({ queued: 1, enough: 1 });
    expect(d.enqueued).toEqual([{ entryId: 'a', sourceUrl: 'https://www.instagram.com/p/a', platform: 'instagram', chatId: 42, inputUser: 'mike', notify: false, reanalyze: true }]);
    expect(d.recorded).toEqual([['a', 2]]);
  });

  it('counts only songs and albums (a film or a book is not what makes a list of music)', async () => {
    const d = deps({ rows: [a], items: { [items(a)]: [song('A', 'film'), song('B', 'book'), song('C', 'text'), song('D')] } });
    const out = await requeueCarouselItems(d, { apply: true, notify: false, since: null, limit: null, minSlides: 3, minItems: 2 });
    expect(out).toMatchObject({ songs: 1, enough: 0, queued: 0 });
  });

  it('an entry whose reading fails is counted and the others go on', async () => {
    let n = 0;
    const d = deps({ rows: [a, candidate('c')], extract: async () => { if (n++ === 0) throw new Error('router asleep'); return [song('X'), song('Y')]; } });
    const out = await requeueCarouselItems(d, { apply: true, notify: false, since: null, limit: null, minSlides: 3, minItems: 2 });
    expect(out).toMatchObject({ failed: 1, queued: 1 });
    expect(d.enqueued.map((j) => j.entryId)).toEqual(['c']);
  });

  it('with no candidate it says so and does nothing', async () => {
    const d = deps({ rows: [] });
    expect(await requeueCarouselItems(d, { apply: true, notify: false, since: null, limit: null, minSlides: 3, minItems: 2 })).toEqual({ candidates: 0, notMusic: 0, unsure: 0, withItems: 0, enough: 0, songs: 0, queued: 0, failed: 0 });
  });

  // 11 November: the first preview of the 403 old carousels read «songs» in 164 and about nine in ten were not music (a roadmap, a stack of tools, tinnitus, finance). The question
  // «is it about music?» is asked FIRST, with the caption: a carousel that is not about music is not read slide by slide (one question of half a second instead of fifteen seconds).
  it('asks «is it about music?» BEFORE reading the slides, with the caption and the slides: a carousel that is not about music is not read at all and is counted', async () => {
    const asked: Array<[string, string | null]> = [];
    const extract = vi.fn(async () => [song('X'), song('Y')]);
    const d = deps({ rows: [a, candidate('c')], extract, aboutMusic: async (slides, caption) => { asked.push([slides.map((s) => s.text).join('|'), caption]); return asked.length === 1; } });
    const out = await requeueCarouselItems(d, { apply: true, notify: false, since: null, limit: null, minSlides: 3, minItems: 2 });
    expect(asked).toEqual([[items(a), 'album da ascoltare #musica'], [items(candidate('c')), 'album da ascoltare #musica']]);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ candidates: 2, notMusic: 1, unsure: 0, queued: 1 });
    expect(d.enqueued.map((j) => j.entryId)).toEqual(['a']);
  });

  it('a verdict that could not be read is not a yes: the carousel is not read, not queued, and counted as «unsure» (a later run asks again)', async () => {
    const extract = vi.fn(async () => [song('X'), song('Y')]);
    const d = deps({ rows: [a], extract, aboutMusic: async () => null });
    const out = await requeueCarouselItems(d, { apply: true, notify: false, since: null, limit: null, minSlides: 3, minItems: 2 });
    expect(extract).not.toHaveBeenCalled();
    expect(out).toMatchObject({ notMusic: 0, unsure: 1, queued: 0 });
    expect(d.enqueued).toEqual([]);
  });

  it('gives the caption of the entry to the extraction too, and the final line says how many were not music', async () => {
    const contexts: unknown[] = [];
    const d = deps({ rows: [a, candidate('c', ['Phase 1 - Stabilize', 'Step 2 - Automate', 'x'])], aboutMusic: async (slides) => slides[0].text === a.slides[0].ocrText, extract: async (_t, context) => { contexts.push(context); return [song('X'), song('Y')]; } });
    await requeueCarouselItems(d, { apply: false, notify: false, since: null, limit: null, minSlides: 3, minItems: 2 });
    expect(contexts).toEqual([{ caption: 'album da ascoltare #musica' }]);
    expect(d.lines[d.lines.length - 1]).toMatch(/non musica 1/);
  });

  it('--notify makes the jobs speak (Telegram); a platform that is not instagram is «other»', async () => {
    const yt = { ...candidate('y'), source_platform: 'tiktok' };
    const d = deps({ rows: [yt], items: { [items(yt)]: [song('X'), song('Y')] } });
    await requeueCarouselItems(d, { apply: true, notify: true, since: null, limit: null, minSlides: 3, minItems: 2 });
    expect(d.enqueued[0]).toMatchObject({ notify: true, platform: 'other' });
  });
});
