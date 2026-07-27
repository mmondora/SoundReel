import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { enrichBook } from './bookEnrichment';

afterEach(() => {
  vi.unstubAllGlobals();
});

const DUNE_DOC = {
  title: 'Dune',
  author_name: ['Frank Herbert'],
  first_publish_year: 1965,
  cover_i: 12345,
  key: '/works/OL893415W',
};

describe('enrichBook — happy path', () => {
  it('maps the first doc into a BookEnrichmentResult', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ docs: [DUNE_DOC] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichBook('Dune');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('openlibrary.org/search.json');
    expect(fetchMock.mock.calls[0][0]).toContain(`q=${encodeURIComponent('Dune')}`);
    expect(fetchMock.mock.calls[0][0]).toContain('limit=3');
    expect(fetchMock.mock.calls[0][0]).toContain('fields=title,author_name,first_publish_year,cover_i,key');

    expect(result).toEqual({
      bookTitle: 'Dune',
      bookAuthor: 'Frank Herbert',
      bookYear: 1965,
      coverUrl: 'https://covers.openlibrary.org/b/id/12345-M.jpg',
      openlibraryUrl: 'https://openlibrary.org/works/OL893415W',
    });
  });

  it('picks author_name[0] when multiple authors are present', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ docs: [{ ...DUNE_DOC, author_name: ['Frank Herbert', 'Someone Else'] }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichBook('Dune');
    expect(result?.bookAuthor).toBe('Frank Herbert');
  });

  it('always picks the first doc regardless of how many are returned', async () => {
    const other = { ...DUNE_DOC, title: 'Dune Messiah', key: '/works/OL893416W' };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ docs: [DUNE_DOC, other] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichBook('Dune');
    expect(result?.bookTitle).toBe('Dune');
  });

  it('maps a missing author_name to null', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ docs: [{ ...DUNE_DOC, author_name: undefined }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichBook('Dune');
    expect(result?.bookAuthor).toBeNull();
  });

  it('maps a missing first_publish_year to null', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ docs: [{ ...DUNE_DOC, first_publish_year: undefined }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichBook('Dune');
    expect(result?.bookYear).toBeNull();
  });

  it('maps a missing cover_i to a null coverUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ docs: [{ ...DUNE_DOC, cover_i: undefined }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichBook('Dune');
    expect(result?.coverUrl).toBeNull();
  });

  it('maps a missing key to a null openlibraryUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ docs: [{ ...DUNE_DOC, key: undefined }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichBook('Dune');
    expect(result?.openlibraryUrl).toBeNull();
  });
});

describe('enrichBook — miss / error handling', () => {
  it('returns null when docs is an empty array', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ docs: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrichBook('Some Obscure Text')).toBeNull();
  });

  it('returns null when docs is missing entirely', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrichBook('Some Obscure Text')).toBeNull();
  });

  it('returns null (never throws) when the HTTP call is not ok', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrichBook('Dune')).toBeNull();
  });

  it('returns null (never throws) on a network throw', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrichBook('Dune')).toBeNull();
  });

  it('returns null (never throws) on malformed JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new Error('invalid json');
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrichBook('Dune')).toBeNull();
  });
});

describe('enrichBook — malformed field types (JSONB response is not schema-validated)', () => {
  it('ignores a non-string key rather than building a garbage URL', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ docs: [{ ...DUNE_DOC, key: 12345 }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await enrichBook('Dune');
    expect(result?.openlibraryUrl).toBeNull();
  });

  it('ignores a non-number cover_i rather than building a garbage URL', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ docs: [{ ...DUNE_DOC, cover_i: '12345' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await enrichBook('Dune');
    expect(result?.coverUrl).toBeNull();
  });
});
