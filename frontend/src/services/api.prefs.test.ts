import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiPrefsAnonymousError, fetchUiPrefs, resetUiPrefs, saveUiPrefs } from './api';
import type { UiPrefs } from '../types';

// `GET|PUT|DELETE /api/me/prefs` (ADR-0026, docs/ui-prefs.md): the configuration of the user. The answer is always the COMPLETE document
// `{ prefs }`; `PUT` sends only the parts to change; `401` is «no user» (local development), `400` names what is wrong.

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status = 200, body: unknown = {}) {
  const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const DOC: UiPrefs = {
  v: 1,
  views: { inbox: 'studio', links: 'studio' },
  home: { sections: [
    { id: 'resume', visible: true }, { id: 'songs', visible: true }, { id: 'playlists', visible: true },
    { id: 'collections', visible: true }, { id: 'films', visible: true },
  ] },
  player: { dock: 'bottom', float: { x: 1, y: 1 } },
};

describe('fetchUiPrefs', () => {
  it('asks the server for the document, never from the cache, and gives back what is inside `prefs`', async () => {
    const f = stubFetch(200, { prefs: DOC });
    await expect(fetchUiPrefs()).resolves.toEqual(DOC);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe('/api/me/prefs');
    expect(f.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
    expect(f.mock.calls[0][1]?.cache).toBe('no-store');
  });

  it('a server that fails is an error (the provider keeps the copy of the session)', async () => {
    stubFetch(500, { error: 'prefs_unavailable' });
    await expect(fetchUiPrefs()).rejects.toThrow(/prefs_unavailable/);
  });
});

describe('saveUiPrefs', () => {
  it('PUTs only the parts to change, as JSON, and gives back the complete document', async () => {
    const wall = { ...DOC, views: { inbox: 'wall' as const, links: 'studio' as const } };
    const f = stubFetch(200, { prefs: wall });
    await expect(saveUiPrefs({ views: { inbox: 'wall' } })).resolves.toEqual(wall);
    const [path, init] = f.mock.calls[0];
    expect(path).toBe('/api/me/prefs');
    expect(init?.method).toBe('PUT');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ views: { inbox: 'wall' } });
  });

  it('401 (no user) is its own error, so the page can keep the choice for this visit without showing a failure', async () => {
    stubFetch(401, { error: 'authentication required', hint: 'Authelia Remote-User missing' });
    await expect(saveUiPrefs({ views: { inbox: 'wall' } })).rejects.toBeInstanceOf(UiPrefsAnonymousError);
  });

  it('400 says what is wrong, in the message', async () => {
    stubFetch(400, { error: 'invalid_prefs:views.links' });
    await expect(saveUiPrefs({ views: { links: 'home' as never } })).rejects.toThrow(/invalid_prefs:views\.links/);
  });
});

describe('resetUiPrefs', () => {
  it('DELETEs the choices and gives back the starting values the server answers', async () => {
    const f = stubFetch(200, { prefs: DOC });
    await expect(resetUiPrefs()).resolves.toEqual(DOC);
    expect(f.mock.calls[0][0]).toBe('/api/me/prefs');
    expect(f.mock.calls[0][1]?.method).toBe('DELETE');
  });

  it('401 is the same «no user» error; 500 is an error', async () => {
    stubFetch(401, { error: 'authentication required' });
    await expect(resetUiPrefs()).rejects.toBeInstanceOf(UiPrefsAnonymousError);
    stubFetch(500, { error: 'prefs_unavailable' });
    await expect(resetUiPrefs()).rejects.toThrow(/prefs_unavailable/);
  });
});
