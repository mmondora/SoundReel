import { describe, it, expect } from 'vitest';
import { filterSoftware, collectSoftwareTags, sortSoftware } from './softwareFilters';
import type { AggregatedSoftware } from '../types';

function item(
  key: string,
  tag: AggregatedSoftware['tag'],
  title: string,
  createdAt = '2026-11-01T00:00:00Z',
): AggregatedSoftware {
  return {
    softwareKey: key,
    title,
    url: `https://example.com/${key}`,
    tag,
    description: null,
    mentions: [{ entryId: 'e1', createdAt }],
  };
}

const ITEMS = [
  item('r1', 'repo', 'foo/bar', '2026-11-02T00:00:00Z'),
  item('p1', 'product', 'Plex', '2026-10-01T00:00:00Z'),
  item('a1', 'article', 'How to ship', '2026-09-01T00:00:00Z'),
];

describe('softwareFilters', () => {
  it('filters by tag', () => {
    expect(filterSoftware(ITEMS, { tags: ['repo'] }).map((i) => i.softwareKey)).toEqual(['r1']);
  });

  it('filters by text', () => {
    expect(filterSoftware(ITEMS, { tags: [], text: 'plex' }).map((i) => i.softwareKey)).toEqual(['p1']);
  });

  it('collects tags in canonical order', () => {
    expect(collectSoftwareTags(ITEMS)).toEqual(['repo', 'product', 'article']);
  });

  it('sorts by date descending by default', () => {
    expect(sortSoftware(ITEMS, 'date').map((i) => i.softwareKey)).toEqual(['r1', 'p1', 'a1']);
  });
});
