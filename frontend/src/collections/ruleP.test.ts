import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Rule P for the collections (ADR-0022, spec 2026-11-09-library-collections-auto-topics-design.md §8 and docs/collections.md): the SERVER discovers the
// collections (vectors, groups, names, places, venues) and builds the address of Maps; the site only draws what it is sent. This scan keeps the
// logic from growing back into the browser: no address of Maps built here, no clustering words, no call to the embedding route. Every non-test
// .ts/.tsx under src is read, comments included (a comment that names one of these is a sign the code still knows about it); the match ignores the case.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every .ts / .tsx file under `dir` that is not a test. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const FILES = sourceFiles(SRC).map((full) => ({ name: relative(SRC, full).split('\\').join('/'), text: readFileSync(full, 'utf8') }));

/** Where `token` shows up (file:line), ignoring the case. */
function offenders(token: string): string[] {
  const needle = token.toLowerCase();
  return FILES.flatMap(({ name, text }) =>
    text.split('\n').flatMap((line, i) => (line.toLowerCase().includes(needle) ? [`${name}:${i + 1}`] : [])),
  );
}

/** The pages of the notes had their own link to Maps long before the collections (a place note, by its coordinates): it is not part of this rule. */
const OLD_MAPS_LINK = ['pages/NotesPage.tsx'];

// (the credit line «© OpenStreetMap contributors» of the notes map is an attribution, not an address: it is not in this list)
const MAPS_ADDRESSES = ['google.com/maps', 'maps.google', 'maps/search', 'maps.apple.com'];
const CLUSTERING = ['cosine', 'centroid', 'kmeans', 'nomic', 'cluster', 'similarity', '/api/embed'];

describe('rule P for the collections: the browser discovers nothing and builds no address of Maps', () => {
  it('the scan sees the pages and the components of the collections (it cannot pass by reading nothing)', () => {
    const names = FILES.map((f) => f.name);
    expect(names.length).toBeGreaterThan(50);
    for (const wanted of ['pages/CollectionsPage.tsx', 'pages/CollectionPage.tsx', 'components/VenueList.tsx', 'components/CollectionChips.tsx', 'hooks/useCollections.ts', 'services/api.ts']) {
      expect(names, `${wanted} is not scanned`).toContain(wanted);
    }
    expect(names.some((n) => /\.test\.tsx?$/.test(n))).toBe(false);
  });

  it.each(MAPS_ADDRESSES)('no "%s" in the sources of the site (the server builds the address: `mapsUrl`)', (token) => {
    const found = offenders(token).filter((where) => !OLD_MAPS_LINK.includes(where.split(':')[0]));
    expect(found).toEqual([]);
  });

  it('the one old link to Maps stays where it was (the exception does not grow)', () => {
    const files = new Set(MAPS_ADDRESSES.flatMap((token) => offenders(token)).map((where) => where.split(':')[0]));
    expect([...files].filter((f) => !OLD_MAPS_LINK.includes(f))).toEqual([]);
  });

  it('«Open in Maps» opens the address the server sent, untouched', () => {
    const venueList = FILES.find((f) => f.name === 'components/VenueList.tsx')?.text ?? '';
    expect(venueList).toContain('href={venue.mapsUrl}');
  });

  it.each(CLUSTERING)('no "%s" in the sources of the site (the server groups the posts, with local vectors)', (token) => {
    expect(offenders(token)).toEqual([]);
  });
});
