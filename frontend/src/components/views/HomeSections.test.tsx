import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeSections } from './HomeSections';
import { UiPrefsProvider } from '../../hooks/useUiPrefs';
import { LanguageProvider } from '../../i18n';
import { translations } from '../../i18n/translations';
import * as api from '../../services/api';
import type { HomeSectionId, UiPrefs, WebHomeResponse } from '../../types';

vi.mock('../../services/api', () => ({
  fetchWebHome: vi.fn(),
  fetchUiPrefs: vi.fn(),
  saveUiPrefs: vi.fn(),
  resetUiPrefs: vi.fn(),
  UiPrefsAnonymousError: class UiPrefsAnonymousError extends Error {},
}));

// The Home view (look and feel P3, board C): the sections the server prepared (what each holds, in which order its items are), drawn in the
// order and with the switches the user chose. The page computes nothing: it draws, links, and skips what it does not know.

const t = translations.en;
const config = (...entries: Array<[HomeSectionId, boolean]>): UiPrefs => ({
  v: 1, views: { inbox: 'home', links: 'studio' }, home: { sections: entries.map(([id, visible]) => ({ id, visible })) }, player: { dock: 'bottom', float: { x: 1, y: 1 } },
});
const FULL = config(['resume', true], ['songs', true], ['playlists', true], ['collections', true], ['films', true]);

const HOME: WebHomeResponse = {
  sections: [
    { id: 'resume', total: 40, items: [
      { id: 'p1', sourceUrl: 'https://instagram.com/reel/p1', sourcePlatform: 'instagram', caption: null, thumbnailUrl: null, status: 'completed', createdAt: '2026-11-10T09:00:00.000Z', summary: 'POST ONE', songCount: 5, filmCount: 0, noteCount: 0, tags: [] },
      { id: 'p2', sourceUrl: 'https://tiktok.com/p2', sourcePlatform: 'tiktok', caption: null, thumbnailUrl: null, status: 'completed', createdAt: '2026-11-10T08:00:00.000Z', summary: 'POST TWO', songCount: 0, filmCount: 2, noteCount: 0, tags: [] },
    ] },
    { id: 'songs', total: 943, items: [
      { songKey: 'kavinsky::nightcall', title: 'Nightcall', artist: 'Kavinsky', coverUrl: 'https://img/nightcall.jpg', entryId: 'p1', sourceUrl: null, createdAt: '2026-11-10T09:00:00.000Z' },
      { songKey: 'a::b & c', title: 'b & c', artist: 'A', coverUrl: null, entryId: 'p2', sourceUrl: null, createdAt: '2026-11-09T09:00:00.000Z' },
    ] },
    { id: 'playlists', total: 56, items: [
      { id: 'pl1', name: 'Jazz da ascoltare', songCount: 15, createdAt: '2026-11-10T07:00:00.000Z', kind: 'dynamic', origin: 'auto', ruleSummary: 'Aggiunte di recente · Jazz · max 200', ownerUser: 'mike' },
      { id: 'pl2', name: 'Estate', songCount: 7, createdAt: '2026-11-09T07:00:00.000Z', kind: 'static', origin: 'user', ruleSummary: null, ownerUser: 'mike' },
    ] },
    { id: 'films', total: 731, items: [
      { filmKey: 'dune::2021', title: 'Dune', year: '2021', posterUrl: 'https://img/dune.jpg', imdbUrl: null, entryId: 'p2', sourceUrl: null, createdAt: '2026-11-10T08:00:00.000Z' },
      { filmKey: 'heat::', title: 'Heat', year: null, posterUrl: null, imdbUrl: null, entryId: 'p2', sourceUrl: null, createdAt: '2026-11-09T08:00:00.000Z' },
    ] },
  ],
};

function renderHome(onOpenEntry: (id: string) => void = () => undefined, selectedId: string | null = null) {
  return render(
    <MemoryRouter>
      <LanguageProvider><UiPrefsProvider><HomeSections selectedId={selectedId} onOpenEntry={onOpenEntry} /></UiPrefsProvider></LanguageProvider>
    </MemoryRouter>,
  );
}

const headings = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(api.fetchUiPrefs).mockResolvedValue(FULL);
  vi.mocked(api.fetchWebHome).mockResolvedValue(HOME);
});

describe('the Home view — which sections, in which order', () => {
  it('draws the sections the server sent in the order of the configuration; collections (not built) leaves no empty frame', async () => {
    renderHome();
    await screen.findByRole('heading', { level: 2, name: t.homeSectionResume });
    expect(headings()).toEqual([t.homeSectionResume, t.homeSectionSongs, t.homeSectionPlaylists, t.homeSectionFilms]);
  });

  it('follows the order the user chose, and leaves out the sections that are switched off', async () => {
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(config(['films', true], ['songs', false], ['resume', true], ['collections', true], ['playlists', false]));
    renderHome();
    await screen.findByRole('heading', { level: 2, name: t.homeSectionFilms });
    expect(headings()).toEqual([t.homeSectionFilms, t.homeSectionResume]);
  });

  it('skips a section it does not know', async () => {
    vi.mocked(api.fetchWebHome).mockResolvedValue({ sections: [...HOME.sections, { id: 'radio', total: 1, items: [] } as never] });
    renderHome();
    await screen.findByRole('heading', { level: 2, name: t.homeSectionResume });
    expect(headings()).toHaveLength(4);
  });

  it('without a configuration (the server could not be asked) it draws the sections as the server sent them', async () => {
    vi.mocked(api.fetchUiPrefs).mockRejectedValue(new Error('network down'));
    renderHome();
    await screen.findByRole('heading', { level: 2, name: t.homeSectionResume });
    expect(headings()).toEqual([t.homeSectionResume, t.homeSectionSongs, t.homeSectionPlaylists, t.homeSectionFilms]);
  });

  it('«see all (N)» heads every section and goes to its page', async () => {
    renderHome();
    await screen.findByRole('heading', { level: 2, name: t.homeSectionResume });
    const see = (n: number) => t.homeSeeAll.replace('{count}', String(n));
    expect(screen.getByRole('link', { name: see(40) })).toHaveAttribute('href', '/entries');
    expect(screen.getByRole('link', { name: see(943) })).toHaveAttribute('href', '/songs');
    expect(screen.getByRole('link', { name: see(56) })).toHaveAttribute('href', '/playlist-manager');
    expect(screen.getByRole('link', { name: see(731) })).toHaveAttribute('href', '/films');
  });
});

const WITH_COLLECTIONS: WebHomeResponse = {
  sections: [
    HOME.sections[0], HOME.sections[1], HOME.sections[2],
    { id: 'collections', total: 14, items: [
      { id: '5f0c-wine', name: 'Vino', count: 15, isNew: true, thumbs: ['https://img/w1.jpg', 'https://img/w2.jpg'] },
      { id: 'place:milano', name: 'Milano', count: 9, isNew: false, thumbs: [] },
    ] },
    HOME.sections[3],
  ],
};

describe('the Home view — the collections', () => {
  beforeEach(() => {
    vi.mocked(api.fetchWebHome).mockResolvedValue(WITH_COLLECTIONS);
  });

  it('is drawn where the configuration of the user puts it, between the playlists and the films', async () => {
    renderHome();
    await screen.findByRole('heading', { level: 2, name: t.homeSectionResume });
    expect(headings()).toEqual([t.homeSectionResume, t.homeSectionSongs, t.homeSectionPlaylists, t.homeSectionCollections, t.homeSectionFilms]);
  });

  it('has a tile for each collection the server sent: the name, how many posts, «New»; it opens the collection (the id goes in the address encoded)', async () => {
    renderHome();
    const section = (await screen.findByRole('heading', { level: 2, name: t.homeSectionCollections })).closest('section') as HTMLElement;
    const tiles = within(section).getAllByRole('link').filter((a) => a.classList.contains('collection-card'));
    expect(tiles.map((a) => a.querySelector('.collection-card-name')?.textContent)).toEqual(['Vino', 'Milano']);
    expect(tiles.map((a) => a.querySelector('.collection-card-sub')?.textContent)).toEqual([
      `${t.collectionPosts.replace('{count}', '15')}${t.collectionNew}`,
      t.collectionPosts.replace('{count}', '9'),
    ]);
    expect(tiles[0]).toHaveAttribute('href', '/collections/5f0c-wine');
    expect(tiles[1]).toHaveAttribute('href', '/collections/place%3Amilano');
  });

  it('«see all (N)» goes to the page of the collections', async () => {
    renderHome();
    const section = (await screen.findByRole('heading', { level: 2, name: t.homeSectionCollections })).closest('section') as HTMLElement;
    expect(within(section).getByRole('link', { name: t.homeSeeAll.replace('{count}', '14') })).toHaveAttribute('href', '/collections');
  });

  it('switched off by the user, it is not drawn', async () => {
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(config(['resume', true], ['songs', true], ['playlists', true], ['collections', false], ['films', true]));
    renderHome();
    await screen.findByRole('heading', { level: 2, name: t.homeSectionResume });
    expect(headings()).not.toContain(t.homeSectionCollections);
  });
});

describe('the Home view — the sections', () => {
  it('«pick up»: the latest posts as cards; a card opens the post (the page decides where) and the open one is pressed', async () => {
    const onOpen = vi.fn();
    renderHome(onOpen, 'p2');
    const resume = (await screen.findByRole('heading', { level: 2, name: t.homeSectionResume })).closest('section') as HTMLElement;
    await userEvent.click(within(resume).getByRole('button', { name: /POST ONE/ }));
    expect(onOpen).toHaveBeenCalledWith('p1');
    expect(within(resume).getByRole('button', { name: /POST TWO/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(resume).getByRole('list', { name: t.homeSectionResume })).toBeInTheDocument();
  });

  it('new songs: cover (or the first letter), title and artist; each goes to the Songs page filtered on its title', async () => {
    renderHome();
    const songs = (await screen.findByRole('heading', { level: 2, name: t.homeSectionSongs })).closest('section') as HTMLElement;
    const night = within(songs).getByRole('link', { name: /Nightcall/ });
    expect(night).toHaveTextContent('Kavinsky');
    expect(night).toHaveAttribute('href', '/songs?q=Nightcall');
    expect(night.querySelector('img')).toHaveAttribute('src', 'https://img/nightcall.jpg');
    expect(night.querySelector('.home-tile-art')).not.toHaveClass('poster');
    const bc = within(songs).getByRole('link', { name: /b & c/ });
    expect(bc).toHaveAttribute('href', '/songs?q=b%20%26%20c');
    expect(bc.querySelector('img')).toBeNull();
    expect(within(bc).getByText('B', { selector: '.home-tile-art' })).toBeInTheDocument();      // the first letter, in capital
  });

  it('playlists: the name, how many songs, «automatica» for the ones the server made, the rule for a dynamic one', async () => {
    renderHome();
    const lists = (await screen.findByRole('heading', { level: 2, name: t.homeSectionPlaylists })).closest('section') as HTMLElement;
    const jazz = within(lists).getByRole('link', { name: /Jazz da ascoltare/ });
    expect(jazz).toHaveTextContent(t.mgrItems.replace('{n}', '15'));
    expect(jazz).toHaveTextContent(t.playlistAutoBadge);
    expect(jazz).toHaveTextContent('Aggiunte di recente · Jazz · max 200');
    expect(jazz).toHaveAttribute('href', '/playlist-manager');
    const summer = within(lists).getByRole('link', { name: /Estate/ });
    expect(summer).toHaveTextContent(t.mgrItems.replace('{n}', '7'));
    expect(summer.textContent).not.toContain(t.playlistAutoBadge);
  });

  it('to watch: the poster (or the first letter), the title and the year when there is one', async () => {
    renderHome();
    const films = (await screen.findByRole('heading', { level: 2, name: t.homeSectionFilms })).closest('section') as HTMLElement;
    const dune = within(films).getByRole('link', { name: /Dune/ });
    expect(dune).toHaveTextContent('2021');
    expect(dune.querySelector('img')).toHaveAttribute('src', 'https://img/dune.jpg');
    expect(dune).toHaveAttribute('href', '/films');
    const heat = within(films).getByRole('link', { name: /Heat/ });
    expect(heat.querySelector('img')).toBeNull();
    expect(heat.textContent).not.toMatch(/\(|null/);
    expect(heat.querySelector('.home-tile-sub')).toBeNull();                                // no year: no empty line
    expect(dune.querySelector('.home-tile-art')).toHaveClass('poster');                         // a poster is taller than a cover
    expect(within(films).queryAllByRole('link').length).toBe(2 + 1);                            // two films and «see all»
  });
});

describe('the Home view — waiting, failing, empty', () => {
  it('waits while the sections are on their way', async () => {
    vi.mocked(api.fetchWebHome).mockReturnValue(new Promise(() => undefined));
    renderHome();
    expect(await screen.findByText(t.loading)).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
  });

  it('a Home that cannot be read says so and can be tried again', async () => {
    vi.mocked(api.fetchWebHome).mockRejectedValueOnce(new Error('home failed')).mockResolvedValueOnce(HOME);
    renderHome();
    expect(await screen.findByRole('alert')).toHaveTextContent(t.homeLoadError);
    await userEvent.click(screen.getByRole('button', { name: t.libRetry }));
    await screen.findByRole('heading', { level: 2, name: t.homeSectionResume });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an empty library says so (no frames without anything in them)', async () => {
    vi.mocked(api.fetchWebHome).mockResolvedValue({ sections: [] });
    renderHome();
    expect(await screen.findByText(t.homeEmpty)).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
  });

  it('every section switched off says the same, not a blank page', async () => {
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(config(['resume', false], ['songs', false], ['playlists', false], ['collections', false], ['films', false]));
    renderHome();
    await waitFor(() => expect(screen.getByText(t.homeEmpty)).toBeInTheDocument());
  });
});
