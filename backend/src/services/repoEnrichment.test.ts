import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseRepoUrl, enrichRepoFromUrl } from './repoEnrichment';

describe('parseRepoUrl', () => {
  it('parses github owner/repo and strips tree paths', () => {
    expect(parseRepoUrl('https://github.com/yamadashy/repomix')).toEqual({
      host: 'github',
      path: 'yamadashy/repomix',
      owner: 'yamadashy',
      repo: 'repomix',
    });
    expect(parseRepoUrl('https://github.com/yamadashy/repomix/tree/main/src')).toEqual({
      host: 'github',
      path: 'yamadashy/repomix',
      owner: 'yamadashy',
      repo: 'repomix',
    });
  });

  it('parses gitlab nested groups', () => {
    expect(parseRepoUrl('https://gitlab.com/group/sub/project')).toEqual({
      host: 'gitlab',
      path: 'group/sub/project',
      owner: 'group',
      repo: 'project',
    });
  });

  it('parses codeberg', () => {
    expect(parseRepoUrl('https://codeberg.org/forgejo/forgejo')).toEqual({
      host: 'codeberg',
      path: 'forgejo/forgejo',
      owner: 'forgejo',
      repo: 'forgejo',
    });
  });

  it('rejects non-forge hosts and incomplete paths', () => {
    expect(parseRepoUrl('https://plex.tv/app')).toBeNull();
    expect(parseRepoUrl('https://github.com/only-owner')).toBeNull();
    expect(parseRepoUrl('not-a-url')).toBeNull();
  });
});

describe('enrichRepoFromUrl', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it('reads description and created_at from GitHub', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        description: 'Packs a repo into an AI-friendly file',
        created_at: '2024-06-01T12:00:00Z',
      }),
    } as Response);

    const result = await enrichRepoFromUrl('https://github.com/yamadashy/repomix');
    expect(result).toEqual({
      host: 'github',
      description: 'Packs a repo into an AI-friendly file',
      publishedAt: '2024-06-01T12:00:00.000Z',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/yamadashy/repomix',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('returns null when the forge answers non-OK', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
    expect(await enrichRepoFromUrl('https://github.com/no/such')).toBeNull();
  });
});
