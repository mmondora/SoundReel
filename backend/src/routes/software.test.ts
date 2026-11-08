import { describe, it, expect } from 'vitest';
import { aggregateSoftware, collectSoftwareFromEntry } from './software';
import type { Entry, EntryResults } from '../types';

function entry(
  id: string,
  results: Partial<EntryResults>,
  extras: Partial<Entry> = {},
): Entry {
  return {
    id,
    sourceUrl: extras.sourceUrl ?? 'https://example.com/x',
    sourcePlatform: 'other',
    inputChannel: 'web',
    inputUser: null,
    ownerUser: 'mike',
    caption: null,
    thumbnailUrl: null,
    mediaUrl: null,
    status: 'completed',
    actionLog: [],
    createdAt: extras.createdAt ?? '2026-11-01T00:00:00Z',
    results: {
      songs: [],
      films: [],
      notes: [],
      links: [],
      tags: [],
      summary: null,
      ...results,
    },
  };
}

describe('collectSoftwareFromEntry', () => {
  it('keeps explicit software items', () => {
    const e = entry('1', {
      software: [
        { title: 'Repomix', url: 'https://github.com/yamadashy/repomix', tag: 'repo' },
        { title: 'How to ship', url: 'https://example.com/blog/ship', tag: 'article' },
      ],
    });
    expect(collectSoftwareFromEntry(e)).toHaveLength(2);
  });

  it('harvests github links when software[] is empty', () => {
    const e = entry('2', {
      links: [{ url: 'https://github.com/foo/bar', label: 'foo/bar' }],
    });
    const items = collectSoftwareFromEntry(e);
    expect(items).toEqual([
      expect.objectContaining({
        title: 'foo/bar',
        url: 'https://github.com/foo/bar',
        tag: 'repo',
      }),
    ]);
  });

  it('harvests github sourceUrl', () => {
    const e = entry('2b', {}, { sourceUrl: 'https://github.com/acme/tool' });
    expect(collectSoftwareFromEntry(e)[0]).toEqual(
      expect.objectContaining({ title: 'acme/tool', tag: 'repo' }),
    );
  });

  it('does not harvest non-repo links automatically', () => {
    const e = entry('3', {
      links: [{ url: 'https://plex.tv', label: 'Plex' }],
    });
    expect(collectSoftwareFromEntry(e)).toHaveLength(0);
  });
});

describe('aggregateSoftware', () => {
  it('dedupes the same repo across entries and counts mentions', () => {
    const a = entry(
      'a',
      { links: [{ url: 'https://github.com/foo/bar', label: null }] },
      { createdAt: '2026-10-01T00:00:00Z' },
    );
    const b = entry(
      'b',
      { software: [{ title: 'foo/bar', url: 'https://github.com/foo/bar', tag: 'repo' }] },
      { createdAt: '2026-11-01T00:00:00Z' },
    );
    const map = aggregateSoftware([a, b]);
    expect(map.size).toBe(1);
    const item = [...map.values()][0];
    expect(item.mentions).toHaveLength(2);
    expect(item.title).toBe('foo/bar');
  });

  it('overlays forge meta description and publishedAt onto aggregated repos', () => {
    const e = entry('1', {
      software: [{ title: 'foo/bar', url: 'https://github.com/foo/bar', tag: 'repo', description: 'ai guess' }],
    });
    const key = 'repo::url::https://github.com/foo/bar';
    const meta = new Map([
      [key, {
        softwareKey: key,
        description: 'Official repo description',
        publishedAt: '2020-01-15T00:00:00.000Z',
        host: 'github',
        enrichedAt: '2026-11-02T00:00:00.000Z',
      }],
    ]);
    const item = [...aggregateSoftware([e], meta).values()][0];
    expect(item.description).toBe('Official repo description');
    expect(item.publishedAt).toBe('2020-01-15T00:00:00.000Z');
  });
});
