import { describe, expect, it } from 'vitest';
import { orderHomeSections } from './homeSections';
import type { HomeSectionId, WebHomeSection } from '../types';

// The server decides what each section holds and which sections exist; the user decides which are visible and in what order (docs/ui-prefs.md).
// The page draws the sections the server sent, in the order and with the switches of the configuration; it skips what it does not know.

const config = (...entries: Array<[HomeSectionId, boolean]>) => entries.map(([id, visible]) => ({ id, visible }));
const FULL = config(['resume', true], ['songs', true], ['playlists', true], ['collections', true], ['films', true]);

const section = (id: WebHomeSection['id']): WebHomeSection => ({ id, total: 1, items: [] } as unknown as WebHomeSection);
const SENT = [section('resume'), section('songs'), section('playlists'), section('films')];                // collections is not built yet: absent
const ids = (list: WebHomeSection[]) => list.map((s) => s.id);

describe('orderHomeSections', () => {
  it('draws the sections in the order of the configuration', () => {
    const swapped = config(['songs', true], ['resume', true], ['films', true], ['collections', true], ['playlists', true]);
    expect(ids(orderHomeSections(swapped, SENT))).toEqual(['songs', 'resume', 'films', 'playlists']);
  });

  it('a section the user switched off is not drawn', () => {
    const off = config(['resume', true], ['songs', false], ['playlists', true], ['collections', true], ['films', false]);
    expect(ids(orderHomeSections(off, SENT))).toEqual(['resume', 'playlists']);
  });

  it('a section in the configuration that the server did not send (not built, empty, failed) is skipped, not an empty frame', () => {
    expect(ids(orderHomeSections(FULL, SENT))).toEqual(['resume', 'songs', 'playlists', 'films']);
    expect(ids(orderHomeSections(FULL, []))).toEqual([]);
  });

  it('a section the configuration does not know (a newer server, an old page) is skipped', () => {
    const extra = [...SENT, { id: 'radio', total: 1, items: [] } as unknown as WebHomeSection];
    expect(ids(orderHomeSections(FULL, extra))).toEqual(['resume', 'songs', 'playlists', 'films']);
  });

  it('a section sent twice is drawn once (the first)', () => {
    const twice = [SENT[0], SENT[1], { ...SENT[1], total: 99 } as WebHomeSection, SENT[2]];
    const out = orderHomeSections(FULL, twice);
    expect(ids(out)).toEqual(['resume', 'songs', 'playlists']);
    expect(out[1].total).toBe(1);
  });

  it('without a configuration (the server could not be asked) the sections come as the server sent them', () => {
    expect(ids(orderHomeSections(null, SENT))).toEqual(['resume', 'songs', 'playlists', 'films']);
  });
});
