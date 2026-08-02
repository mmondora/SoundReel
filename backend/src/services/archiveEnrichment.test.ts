import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn() }));

import { enrichFilmFromArchive } from './archiveEnrichment';

const originalFetch = global.fetch;

function searchResponse(docs: unknown[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ response: { numFound: docs.length, docs } }),
  } as Response;
}

function metadataResponse(files: unknown[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ files }),
  } as Response;
}

describe('enrichFilmFromArchive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns a hit with page and file URLs for a confident title+year match', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(searchResponse([
        { identifier: 'night_of_the_living_dead', title: 'Night of the Living Dead', year: '1968' },
      ]))
      .mockResolvedValueOnce(metadataResponse([
        { name: 'nightlivingdead.mp4', format: 'h.264', size: '900000000' },
      ]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');

    expect(outcome.status).toBe('hit');
    if (outcome.status !== 'hit') return;
    expect(outcome.result.identifier).toBe('night_of_the_living_dead');
    expect(outcome.result.year).toBe('1968');
    expect(outcome.result.pageUrl).toBe('https://archive.org/details/night_of_the_living_dead');
    expect(outcome.result.fileUrl).toBe(
      'https://archive.org/download/night_of_the_living_dead/nightlivingdead.mp4'
    );
  });

  it('rejects a doc whose title does not match the query', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(searchResponse([
      { identifier: 'something_else', title: 'A Totally Different Film', year: '1968' },
    ]));

    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('miss');
  });

  it('rejects a title match whose year is off by more than one', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(searchResponse([
      { identifier: 'wrong_year', title: 'Night of the Living Dead', year: '1990' },
    ]));

    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('miss');
  });

  it('accepts a year off by one (Archive metadata is inconsistent about release vs upload year)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(searchResponse([
        { identifier: 'off_by_one', title: 'Night of the Living Dead', year: '1969' },
      ]))
      .mockResolvedValueOnce(metadataResponse([{ name: 'film.mp4', format: 'h.264', size: '100' }]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('hit');
  });

  it('returns a miss when the search finds nothing', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(searchResponse([]));
    const outcome = await enrichFilmFromArchive('Obscure Nonexistent Film', '1970');
    expect(outcome.status).toBe('miss');
  });

  it('returns a hit with a null fileUrl when no playable file is present', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(searchResponse([
        { identifier: 'audio_only', title: 'Night of the Living Dead', year: '1968' },
      ]))
      .mockResolvedValueOnce(metadataResponse([{ name: 'notes.txt', format: 'Text', size: '10' }]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('hit');
    if (outcome.status !== 'hit') return;
    expect(outcome.result.fileUrl).toBeNull();
  });

  it('prefers the largest mp4 when several are present', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(searchResponse([
        { identifier: 'multi', title: 'Night of the Living Dead', year: '1968' },
      ]))
      .mockResolvedValueOnce(metadataResponse([
        { name: 'small.mp4', format: 'h.264', size: '100' },
        { name: 'big.mp4', format: 'h.264', size: '900' },
      ]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('hit');
    if (outcome.status !== 'hit') return;
    expect(outcome.result.fileUrl).toContain('big.mp4');
  });

  it('returns an error status on a non-2xx search response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('error');
  });

  it('returns an error status when the response body is not valid JSON', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('bad json'); },
    } as unknown as Response);
    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('error');
  });

  it('returns an error status when fetch itself rejects', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('network down'));
    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('error');
  });

  it('falls back to a cleaned query on a first-pass miss', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(searchResponse([]))
      .mockResolvedValueOnce(searchResponse([
        { identifier: 'metropolis', title: 'Metropolis', year: '1927' },
      ]))
      .mockResolvedValueOnce(metadataResponse([{ name: 'metropolis.mp4', format: 'h.264', size: '5' }]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Metropolis - restored edition', '1927');
    expect(outcome.status).toBe('hit');
    expect(fetchMock.mock.calls.length).toBe(3);
  });

  it('searches without a year filter when the film has no year', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(searchResponse([
        { identifier: 'noyear', title: 'Nosferatu', year: '1922' },
      ]))
      .mockResolvedValueOnce(metadataResponse([{ name: 'n.mp4', format: 'h.264', size: '5' }]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Nosferatu', null);
    expect(outcome.status).toBe('hit');
    const firstUrl = String(fetchMock.mock.calls[0][0]);
    // fl[]=year is always requested; what must be absent is the range filter.
    expect(firstUrl).not.toContain('year%3A%5B');
  });

  it('returns a miss when the year is unknown and two docs both satisfy the title match (ambiguous, no metadata fetch)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(searchResponse([
      { identifier: 'nosferatu_a', title: 'Nosferatu', year: '1922' },
      { identifier: 'nosferatu_b', title: 'Nosferatu', year: '1922' },
    ]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Nosferatu', null);
    expect(outcome.status).toBe('miss');
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('falls back to the cleaned-query pass when the raw pass is ambiguous, and accepts a unique match there', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(searchResponse([
        { identifier: 'nosferatu_uncut_a', title: 'Nosferatu (Uncut Version)', year: '1922' },
        { identifier: 'nosferatu_uncut_b', title: 'Nosferatu (Uncut Version)', year: '1922' },
      ]))
      .mockResolvedValueOnce(searchResponse([
        { identifier: 'nosferatu', title: 'Nosferatu', year: '1922' },
      ]))
      .mockResolvedValueOnce(metadataResponse([{ name: 'nosferatu.mp4', format: 'h.264', size: '5' }]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Nosferatu (Uncut Version)', null);
    expect(outcome.status).toBe('hit');
    if (outcome.status !== 'hit') return;
    expect(outcome.result.identifier).toBe('nosferatu');
    expect(fetchMock.mock.calls.length).toBe(3);
  });

  it('treats an empty-string year the same as no year: two title matches are ambiguous (miss)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(searchResponse([
      { identifier: 'nosferatu_a', title: 'Nosferatu', year: '1922' },
      { identifier: 'nosferatu_b', title: 'Nosferatu', year: '1922' },
    ]));
    global.fetch = fetchMock;

    // The empty string is what a legacy JSONB film row carries instead of
    // null (films.ts's isFilm accepts it and passes it straight through) —
    // it must take the same ambiguity-checked branch as null, not the
    // year-supplied "first match wins" branch.
    const outcome = await enrichFilmFromArchive('Nosferatu', '');
    expect(outcome.status).toBe('miss');
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('treats a title match beyond the fetched rows window as ambiguous when year is unknown (numFound > rows)', async () => {
    const docs = [
      { identifier: 'nosferatu', title: 'Nosferatu', year: '1922' },
      ...Array.from({ length: 9 }, (_, i) => ({
        identifier: `filler_${i}`,
        title: 'Something Else Entirely',
        year: '2000',
      })),
    ];
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { numFound: 40, docs } }),
    } as Response);
    global.fetch = fetchMock;

    // Only the first 10 docs (this pass's `rows`) are ever fetched. A unique
    // accepted match among those tells us nothing when 40 uploads share the
    // title — one of the other 30 could easily be a better/duplicate match.
    const outcome = await enrichFilmFromArchive('Nosferatu', null);
    expect(outcome.status).toBe('miss');
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('still accepts a unique no-year match when numFound is within the fetched rows window', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            numFound: 1,
            docs: [{ identifier: 'noyear', title: 'Nosferatu', year: '1922' }],
          },
        }),
      } as Response)
      .mockResolvedValueOnce(metadataResponse([{ name: 'n.mp4', format: 'h.264', size: '5' }]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Nosferatu', null);
    expect(outcome.status).toBe('hit');
  });

  it('still returns a hit when two docs match and a year was supplied (ambiguity check only applies without a year)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(searchResponse([
        { identifier: 'nold_a', title: 'Night of the Living Dead', year: '1968' },
        { identifier: 'nold_b', title: 'Night of the Living Dead', year: '1968' },
      ]))
      .mockResolvedValueOnce(metadataResponse([{ name: 'film.mp4', format: 'h.264', size: '100' }]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('hit');
    if (outcome.status !== 'hit') return;
    expect(outcome.result.identifier).toBe('nold_a');
  });
});
