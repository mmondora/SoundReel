import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { enrichPlace } from './placeEnrichment';

afterEach(() => {
  vi.unstubAllGlobals();
});

const BAR_LUCE = {
  name: 'Bar Luce',
  display_name: 'Bar Luce, Largo Isarco, Milano, Lombardia, Italia',
  lat: '45.4408',
  lon: '9.1900',
  osm_type: 'node' as const,
  osm_id: 123456,
  type: 'cafe',
  importance: 0.5,
};

describe('enrichPlace — happy path', () => {
  it('maps the first accepted result into a PlaceEnrichmentResult', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [BAR_LUCE] });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('Bar Luce');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('nominatim.openstreetmap.org/search');
    expect(fetchMock.mock.calls[0][0]).toContain(`q=${encodeURIComponent('Bar Luce')}`);
    expect(fetchMock.mock.calls[0][0]).toContain('format=jsonv2');
    expect(fetchMock.mock.calls[0][0]).toContain('limit=3');
    expect(fetchMock.mock.calls[0][0]).toContain('accept-language=it');

    expect(result).toEqual({
      placeName: 'Bar Luce',
      placeDisplayName: 'Bar Luce, Largo Isarco, Milano, Lombardia, Italia',
      placeLat: 45.4408,
      placeLon: 9.19,
      osmUrl: 'https://www.openstreetmap.org/node/123456',
    });
  });

  it('sends the mandatory Nominatim User-Agent header', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [BAR_LUCE] });
    vi.stubGlobal('fetch', fetchMock);

    await enrichPlace('Bar Luce');

    const options = fetchMock.mock.calls[0][1] as { headers?: Record<string, string> };
    expect(options.headers?.['User-Agent']).toBe(
      'SoundReel/2.5 (personal journal app; contact: mmondora@mondora.com)'
    );
  });

  it('maps a missing display_name to null', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ...BAR_LUCE, display_name: undefined }],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('Bar Luce');
    expect(result?.placeDisplayName).toBeNull();
  });

  it('builds osmUrl for way and relation types too', async () => {
    const fetchMockWay = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ...BAR_LUCE, osm_type: 'way', osm_id: 999 }],
    });
    vi.stubGlobal('fetch', fetchMockWay);
    expect((await enrichPlace('Bar Luce'))?.osmUrl).toBe('https://www.openstreetmap.org/way/999');
    vi.unstubAllGlobals();

    const fetchMockRelation = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ...BAR_LUCE, osm_type: 'relation', osm_id: 777 }],
    });
    vi.stubGlobal('fetch', fetchMockRelation);
    expect((await enrichPlace('Bar Luce'))?.osmUrl).toBe('https://www.openstreetmap.org/relation/777');
  });
});

describe('enrichPlace — miss / error handling', () => {
  it('returns null when the response is an empty array', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrichPlace('Somewhere Obscure')).toBeNull();
  });

  it('returns null when the response is not an array', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ error: 'Unable to geocode' }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrichPlace('Somewhere Obscure')).toBeNull();
  });

  it('returns null (never throws) when the HTTP call is not ok', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrichPlace('Bar Luce')).toBeNull();
  });

  it('returns null (never throws) on a network throw', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrichPlace('Bar Luce')).toBeNull();
  });

  it('returns null (never throws) on malformed JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new Error('invalid json');
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrichPlace('Bar Luce')).toBeNull();
  });
});

describe('enrichPlace — coordinate validation', () => {
  it('skips a candidate with non-finite lat and falls through to the next candidate', async () => {
    const bad = { ...BAR_LUCE, lat: 'not-a-number', name: 'Bar Luce' };
    const good = { ...BAR_LUCE, lat: '45.5', lon: '9.5', name: 'Bar Luce' };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [bad, good] });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('Bar Luce');
    expect(result?.placeLat).toBe(45.5);
    expect(result?.placeLon).toBe(9.5);
  });

  it('skips a candidate with non-finite lon and falls through to the next candidate', async () => {
    const bad = { ...BAR_LUCE, lon: 'not-a-number', name: 'Bar Luce' };
    const good = { ...BAR_LUCE, lat: '45.5', lon: '9.5', name: 'Bar Luce' };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [bad, good] });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('Bar Luce');
    expect(result?.placeLat).toBe(45.5);
    expect(result?.placeLon).toBe(9.5);
  });

  it('returns null when every accepted candidate has non-finite coordinates', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ...BAR_LUCE, lat: 'nope', lon: 'nope' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrichPlace('Bar Luce')).toBeNull();
  });
});

describe('enrichPlace — malformed field types (response is not schema-validated)', () => {
  it('ignores an osm_type outside node/way/relation, keeping the rest of the enrichment', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ...BAR_LUCE, osm_type: 'something-else' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await enrichPlace('Bar Luce');
    expect(result?.osmUrl).toBeNull();
    expect(result?.placeName).toBe('Bar Luce');
  });

  it('ignores a non-positive osm_id, keeping the rest of the enrichment', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ...BAR_LUCE, osm_id: -1 }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await enrichPlace('Bar Luce');
    expect(result?.osmUrl).toBeNull();
  });

  it('ignores a non-integer osm_id, keeping the rest of the enrichment', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ...BAR_LUCE, osm_id: 1.5 }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await enrichPlace('Bar Luce');
    expect(result?.osmUrl).toBeNull();
  });

  it('ignores a non-number osm_id, keeping the rest of the enrichment', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ...BAR_LUCE, osm_id: '123456' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await enrichPlace('Bar Luce');
    expect(result?.osmUrl).toBeNull();
    expect(result?.placeName).toBe('Bar Luce');
  });
});

describe('enrichPlace — match verification (rejects unrelated Nominatim hits)', () => {
  it('rejects a junk first result and accepts a later result that actually matches', async () => {
    const junk = { ...BAR_LUCE, name: 'Completely Different Place' };
    const real = { ...BAR_LUCE, name: 'Bar Luce' };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [junk, real] });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('Bar Luce');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result?.placeName).toBe('Bar Luce');
  });

  it('falls back to a cleaned-query second pass when the raw sentence-shaped note yields zero results', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ ...BAR_LUCE, name: 'Bar Luce' }] });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('Bar Luce - un bel posto a Milano');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain(encodeURIComponent('Bar Luce - un bel posto a Milano'));
    expect(fetchMock.mock.calls[1][0]).toContain(`q=${encodeURIComponent('Bar Luce')}`);
    expect(result?.placeName).toBe('Bar Luce');
  });

  it('requires near-equality (not containment) for a ≤2-token query', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ...BAR_LUCE, name: 'Bar Luce Fondazione Prada' }],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('Bar');
    // cleanQuery('Bar') === 'Bar' — no change, so pass 2 is skipped.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('returns null when every result in both passes is rejected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [{ ...BAR_LUCE, name: 'Completely Unrelated Place' }] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ ...BAR_LUCE, name: 'Still Not It' }] });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('"Some Place" (a bar) - subtitle: extra');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });
});
