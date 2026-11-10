import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREFS_CACHE_KEY, applyPrefsPatch, readCachedPrefs, writeCachedPrefs } from './uiPrefs';
import type { UiPrefs } from '../types';

// ADR-0026: the server owns the configuration and decides every default. The client only mirrors the way the server MERGES a partial document
// (views page by page, the sections all together, the dock replaced, the float axis by axis) so that a change shows at once, and keeps a copy
// in the session to draw the first frame while the answer is on its way. The server answer always wins.

const SECTIONS: UiPrefs['home']['sections'] = [
  { id: 'resume', visible: true }, { id: 'songs', visible: true }, { id: 'playlists', visible: true },
  { id: 'collections', visible: true }, { id: 'films', visible: true },
];
const BASE: UiPrefs = { v: 1, views: { inbox: 'studio', links: 'studio' }, home: { sections: SECTIONS }, player: { dock: 'bottom', float: { x: 1, y: 1 } } };

describe('applyPrefsPatch mirrors the merge of the server', () => {
  it('the views merge page by page: changing one leaves the other', () => {
    const out = applyPrefsPatch(BASE, { views: { inbox: 'wall' } });
    expect(out.views).toEqual({ inbox: 'wall', links: 'studio' });
    expect(applyPrefsPatch(out, { views: { links: 'wall' } }).views).toEqual({ inbox: 'wall', links: 'wall' });
  });

  it('the sections are replaced all together, with their order and switches', () => {
    const reordered = [SECTIONS[1], SECTIONS[0], SECTIONS[2], SECTIONS[3], { id: 'films' as const, visible: false }];
    const out = applyPrefsPatch(BASE, { home: { sections: reordered } });
    expect(out.home.sections.map((s) => `${s.id}:${s.visible}`)).toEqual(['songs:true', 'resume:true', 'playlists:true', 'collections:true', 'films:false']);
  });

  it('the dock is replaced and the float position merges axis by axis', () => {
    const out = applyPrefsPatch(BASE, { player: { dock: 'float', float: { x: 0.25 } } });
    expect(out.player).toEqual({ dock: 'float', float: { x: 0.25, y: 1 } });
    expect(applyPrefsPatch(out, { player: { float: { y: 0 } } }).player).toEqual({ dock: 'float', float: { x: 0.25, y: 0 } });
    expect(applyPrefsPatch(out, { player: { dock: 'side' } }).player.float).toEqual({ x: 0.25, y: 1 });
  });

  it('an empty patch changes nothing, and the input is never touched', () => {
    const frozen = structuredClone(BASE);
    expect(applyPrefsPatch(BASE, {})).toEqual(BASE);
    applyPrefsPatch(BASE, { views: { inbox: 'home' }, home: { sections: [] }, player: { dock: 'hidden', float: { x: 0 } } });
    expect(BASE).toEqual(frozen);
  });

  it('a key that carries no value is not a change (`{ inbox: undefined }` must not erase the view)', () => {
    const out = applyPrefsPatch(BASE, { views: { inbox: undefined }, player: { dock: undefined, float: { x: undefined } } });
    expect(out).toEqual(BASE);
  });

  it('the result shares nothing with the patch (a later edit of the patch cannot change the document)', () => {
    const sections = SECTIONS.map((s) => ({ ...s }));
    const out = applyPrefsPatch(BASE, { home: { sections } });
    sections[0].visible = false;
    expect(out.home.sections[0].visible).toBe(true);
  });
});

describe('the copy kept in the session', () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('what is written is read back, under one key', () => {
    writeCachedPrefs(BASE);
    expect(sessionStorage.getItem(PREFS_CACHE_KEY)).not.toBeNull();
    expect(readCachedPrefs()).toEqual(BASE);
  });

  it('nothing cached, garbage or an old shape is «no copy», never an exception', () => {
    expect(readCachedPrefs()).toBeNull();
    sessionStorage.setItem(PREFS_CACHE_KEY, '{not json');
    expect(readCachedPrefs()).toBeNull();
    sessionStorage.setItem(PREFS_CACHE_KEY, JSON.stringify({ v: 2, views: {} }));
    expect(readCachedPrefs()).toBeNull();
    sessionStorage.setItem(PREFS_CACHE_KEY, JSON.stringify({ ...BASE, views: { inbox: 'carousel', links: 'studio' } }));
    expect(readCachedPrefs()).toBeNull();
    sessionStorage.setItem(PREFS_CACHE_KEY, JSON.stringify({ ...BASE, home: { sections: SECTIONS.slice(0, 4) } }));
    expect(readCachedPrefs()).toBeNull();
    sessionStorage.setItem(PREFS_CACHE_KEY, JSON.stringify({ ...BASE, player: { dock: 'bottom', float: { x: 2, y: 1 } } }));
    expect(readCachedPrefs()).toBeNull();
  });

  it.each([
    ['a version this build does not know', { ...BASE, v: 2 }],
    ['the Home view on the Link page', { ...BASE, views: { inbox: 'studio', links: 'home' } }],
    ['a section twice (so one is missing)', { ...BASE, home: { sections: [SECTIONS[0], SECTIONS[0], SECTIONS[2], SECTIONS[3], SECTIONS[4]] } }],
    ['a section that does not exist', { ...BASE, home: { sections: [...SECTIONS.slice(0, 4), { id: 'radio', visible: true }] } }],
    ['a switch that is not a boolean', { ...BASE, home: { sections: [{ id: 'resume', visible: 'yes' }, ...SECTIONS.slice(1)] } }],
    ['a dock that does not exist', { ...BASE, player: { dock: 'left', float: { x: 1, y: 1 } } }],
    ['a position below 0', { ...BASE, player: { dock: 'float', float: { x: -0.1, y: 1 } } }],
    ['a position that is not a number', { ...BASE, player: { dock: 'float', float: { x: 1, y: '1' } } }],
    ['no player at all', { ...BASE, player: undefined }],
  ])('a copy with %s is «no copy»', (_name, doc) => {
    sessionStorage.setItem(PREFS_CACHE_KEY, JSON.stringify(doc));
    expect(readCachedPrefs()).toBeNull();
  });

  it('a storage that refuses (private window, blocked site data) breaks nothing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readCachedPrefs()).toBeNull();
    expect(() => writeCachedPrefs(BASE)).not.toThrow();
  });
});
