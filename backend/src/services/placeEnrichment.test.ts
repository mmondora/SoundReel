import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { enrichPlace, enrichPlaceDetailed, _resetNominatimThrottle } from './placeEnrichment';

beforeEach(() => {
  // Every test gets a fresh 1.1s Nominatim throttle window — without this,
  // the second (and every later) test in this file to reach searchNominatim
  // would really `await sleep(...)` out the remainder of the window left
  // over from a prior test's call, since lastNominatimCall is module-level
  // state. Mirrors songEnrichment.test.ts's _resetItunesThrottle pattern.
  _resetNominatimThrottle();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
    // Version mirrors hubStatus.ts's derivation (npm_package_version, with a
    // '2.5' fallback) rather than a hardcoded string — npm/npx populate
    // npm_package_version from this package's package.json when running
    // the test suite, so asserting a literal '2.5' here would be
    // environment-dependent.
    expect(options.headers?.['User-Agent']).toBe(
      `SoundReel/${process.env.npm_package_version ?? '2.5'} (personal journal app; contact: mmondora@mondora.com)`
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
    // junk's display_name must NOT share BAR_LUCE's ('Bar Luce, Largo
    // Isarco, ...') — otherwise the comma-head fallback name variant would
    // make junk itself an accepted match, defeating the point of this test.
    const junk = {
      ...BAR_LUCE,
      name: 'Completely Different Place',
      display_name: 'Completely Different Place, Somewhere Else, Italia',
    };
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

describe('enrichPlace — request shape', () => {
  it('requests namedetails=1 alongside the existing params', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [BAR_LUCE] });
    vi.stubGlobal('fetch', fetchMock);

    await enrichPlace('Bar Luce');

    expect(fetchMock.mock.calls[0][0]).toContain('namedetails=1');
  });
});

describe('enrichPlace — namedetails localization (Nominatim localizes `name` to it)', () => {
  it('accepts an English query against a localized-Italian `name` via namedetails["name:en"] equality', async () => {
    // Query is 'Milan' (English); Nominatim's accept-language=it localizes
    // the plain `name` field to 'Milano'. Equality-only (≤2 tokens) against
    // the bare `name` would reject this — namedetails['name:en'] is what
    // saves it.
    const milano = {
      name: 'Milano',
      display_name: 'Milano, Lombardia, Italia',
      lat: '45.4642',
      lon: '9.19',
      osm_type: 'relation' as const,
      osm_id: 1,
      importance: 0.8,
      namedetails: { name: 'Milano', 'name:it': 'Milano', 'name:en': 'Milan' },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [milano] });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('Milan');
    expect(result?.placeName).toBe('Milano');
  });

  it('accepts "Italy" against a localized `name` of "Italia" via namedetails["name:en"]', async () => {
    const italia = {
      name: 'Italia',
      display_name: 'Italia',
      lat: '42.5',
      lon: '12.5',
      osm_type: 'relation' as const,
      osm_id: 2,
      importance: 0.9,
      namedetails: { name: 'Italia', 'name:en': 'Italy' },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [italia] });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('Italy');
    expect(result?.placeName).toBe('Italia');
  });

  it('rejects an unrelated candidate even when its bare `name` happens to equal the query', async () => {
    // Regression guard: namedetails variants must be checked in ADDITION to
    // `name`, not instead of it — an exact `name` match should still win on
    // its own when there's no localization mismatch.
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ...BAR_LUCE, name: 'Roma', namedetails: { name: 'Roma' } }],
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrichPlace('Milan')).toBeNull();
  });
});

describe('enrichPlace — cross-variant acceptance (the real Paris bug)', () => {
  it('selects the localized "Parigi, France" candidate over a same-named "Paris, Texas" one by importance, not array order', async () => {
    // Reproduces the live-probed bug: querying 'Paris' with Nominatim's
    // accept-language=it returns 'Parigi' (France) localized-named, and a
    // literal 'Paris' (Texas, USA) candidate that equality-matches the raw
    // query directly. Both must be accepted; importance (not array
    // position — Texas is listed FIRST here) must decide the winner.
    const parisTexas = {
      name: 'Paris',
      display_name: 'Paris, Lamar County, Texas, Stati Uniti',
      lat: '33.66',
      lon: '-95.55',
      osm_type: 'relation' as const,
      osm_id: 10,
      importance: 0.3,
      namedetails: { name: 'Paris', 'name:en': 'Paris' },
    };
    const parigiFrance = {
      name: 'Parigi',
      display_name: 'Parigi, Francia',
      lat: '48.8566',
      lon: '2.3522',
      osm_type: 'relation' as const,
      osm_id: 20,
      importance: 0.9,
      namedetails: { name: 'Parigi', 'name:it': 'Parigi', 'name:en': 'Paris' },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [parisTexas, parigiFrance] });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('Paris');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result?.placeName).toBe('Parigi');
    expect(result?.placeDisplayName).toBe('Parigi, Francia');
  });

  it('accepts a candidate in pass 1 whose name matches the comma-head variant, without needing a pass-2 call', async () => {
    // 'Tromsø, Norway' as raw text (2+ tokens) would not equality-match a
    // bare 'Tromsø' name variant, but the comma-head query variant
    // ('Tromsø') does — and acceptance checks ALL query variants against
    // every pass-1 candidate, so no second call is needed.
    const tromso = {
      name: 'Tromsø',
      display_name: 'Tromsø, Troms og Finnmark, Norvegia',
      lat: '69.6496',
      lon: '18.9560',
      osm_type: 'relation' as const,
      osm_id: 30,
      importance: 0.6,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [tromso] });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('Tromsø, Norway');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result?.placeName).toBe('Tromsø');
  });

  it('falls back to a pass-2 call using the comma-head query when pass 1 has no accepted candidate', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [{ ...BAR_LUCE, name: 'Something Unrelated' }] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ ...BAR_LUCE, name: 'Dolceacqua' }] });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('Dolceacqua, Liguria');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain(`q=${encodeURIComponent('Dolceacqua')}`);
    expect(result?.placeName).toBe('Dolceacqua');
  });

  it('never makes more than 2 Nominatim calls even when raw/cleaned/comma-head are all distinct and neither pass accepts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [{ ...BAR_LUCE, name: 'Nope' }] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ ...BAR_LUCE, name: 'Still nope' }] });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('A B (paren) - dash, comma tail');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });
});

describe('enrichPlace — normalizePlace spaces punctuation instead of deleting it', () => {
  it('matches "Naz-Sciaves (BZ)" against a hyphenated name via containment, not glued tokens', async () => {
    // If punctuation were deleted (as bookEnrichment's normalize does),
    // 'Naz-Sciaves' would become 'nazsciaves' — gluing the two words into
    // one token, which would never contain/equal 'naz sciaves'. Spacing it
    // instead keeps them separate tokens so containment still works.
    const candidate = {
      name: 'Naz-Sciaves',
      display_name: 'Naz-Sciaves, Bolzano, Trentino-Alto Adige, Italia',
      lat: '46.7',
      lon: '11.7',
      osm_type: 'relation' as const,
      osm_id: 40,
      importance: 0.5,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [candidate] });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('Naz-Sciaves (BZ)');
    expect(result?.placeName).toBe('Naz-Sciaves');
  });
});

describe('enrichPlace — importance-based selection among accepted candidates', () => {
  it('picks the highest-importance accepted candidate even when it is listed last', async () => {
    const low = { ...BAR_LUCE, name: 'Bar Luce', importance: 0.1, osm_id: 1 };
    const high = { ...BAR_LUCE, name: 'Bar Luce', importance: 0.7, osm_id: 2 };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [low, high] });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('Bar Luce');
    expect(result?.osmUrl).toBe('https://www.openstreetmap.org/node/2');
  });

  it('defaults a missing/non-numeric importance to 0 rather than rejecting the candidate', async () => {
    const noImportance = { ...BAR_LUCE, name: 'Bar Luce', importance: undefined, osm_id: 1 };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [noImportance] });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichPlace('Bar Luce');
    expect(result?.placeName).toBe('Bar Luce');
  });
});

describe('enrichPlaceDetailed — miss vs error distinction', () => {
  it('returns {status: "hit", result} on an accepted match', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [BAR_LUCE] });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await enrichPlaceDetailed('Bar Luce');
    expect(outcome.status).toBe('hit');
    if (outcome.status === 'hit') {
      expect(outcome.result.placeName).toBe('Bar Luce');
    }
  });

  it('returns {status: "miss"} on a clean no-match (never throws, HTTP ok)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await enrichPlaceDetailed('Somewhere Obscure');
    expect(outcome).toEqual({ status: 'miss' });
  });

  it('returns {status: "error"} on an HTTP failure', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'boom' });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await enrichPlaceDetailed('Bar Luce');
    expect(outcome).toEqual({ status: 'error' });
  });

  it('returns {status: "error"} on a network throw', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await enrichPlaceDetailed('Bar Luce');
    expect(outcome).toEqual({ status: 'error' });
  });

  it('returns {status: "error"} when the pass-2 call fails, even though pass 1 was a clean miss', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await enrichPlaceDetailed('Bar Luce - un bel posto a Milano');
    expect(outcome).toEqual({ status: 'error' });
  });
});

describe('enrichPlace — wraps enrichPlaceDetailed, collapsing miss/error to null', () => {
  it('returns null on a miss', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrichPlace('Somewhere Obscure')).toBeNull();
  });

  it('returns null on an error', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrichPlace('Bar Luce')).toBeNull();
  });
});

describe('Nominatim throttle — module-level min 1100ms interval, shared by every caller', () => {
  it('lets a lone call through immediately (no artificial delay on the common case)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [BAR_LUCE] });
    vi.stubGlobal('fetch', fetchMock);

    const start = Date.now();
    const result = await enrichPlace('Bar Luce');
    expect(result?.placeName).toBe('Bar Luce');
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('delays a second Nominatim call until the 1100ms window since the first has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [BAR_LUCE] })
      .mockResolvedValueOnce({ ok: true, json: async () => [BAR_LUCE] });
    vi.stubGlobal('fetch', fetchMock);

    const first = enrichPlace('Bar Luce');
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = enrichPlace('Bar Luce');
    // Should not have fired yet after only 500ms of the 1100ms window.
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advancing past the full 1100ms window releases it.
    await vi.advanceTimersByTimeAsync(600);
    const result = await second;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result?.placeName).toBe('Bar Luce');
    expect(Date.now()).toBe(1100);
  });

  it('_resetNominatimThrottle lets an immediate next call through without waiting', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [BAR_LUCE] });
    vi.stubGlobal('fetch', fetchMock);
    const p1 = enrichPlace('Bar Luce');
    await vi.advanceTimersByTimeAsync(0);
    await p1;

    _resetNominatimThrottle();

    const fetchMock2 = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [BAR_LUCE] });
    vi.stubGlobal('fetch', fetchMock2);
    const start = Date.now();
    const p2 = enrichPlace('Bar Luce');
    await vi.advanceTimersByTimeAsync(0);
    await p2;
    expect(fetchMock2).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(start);
  });
});
