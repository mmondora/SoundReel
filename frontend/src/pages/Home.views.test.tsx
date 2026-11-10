import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Home } from './Home';
import { LanguageProvider } from '../i18n';
import { UiPrefsProvider } from '../hooks/useUiPrefs';
import { useJournal } from '../hooks/useJournal';
import { useSearch } from '../hooks/useSearch';
import * as api from '../services/api';
import { translations } from '../i18n/translations';
import type { Entry, InboxView, SearchResult, UiPrefs } from '../types';

// Look and feel P3: the Inbox has three views, chosen by the user and kept on the server: Studio (list and detail, the default), Bacheca (a wall
// of cards and a detail panel that closes) and Home (the sections). The filters, the search and the deep link `?entry=` work in each.

vi.mock('../hooks/useJournal', () => ({ useJournal: vi.fn() }));
vi.mock('../hooks/useSearch', () => ({ useSearch: vi.fn() }));
vi.mock('../services/api', () => ({
  getEntry: vi.fn(),
  searchEntries: vi.fn(),
  deleteEntry: vi.fn(),
  retryEntry: vi.fn(),
  enrichEntry: vi.fn(),
  fetchJournalStats: vi.fn().mockResolvedValue({ totalEntries: 0, totalSongs: 0, totalFilms: 0, totalNotes: 0, totalSoftware: 0 }),
  fetchMe: vi.fn().mockResolvedValue({ user: 'mike', displayName: 'Mike', isAdmin: false, authenticated: true, family: [] }),
  fetchEntryMedia: vi.fn().mockResolvedValue({ entryId: '', videoUrl: null, audioUrl: null, thumbnailUrl: null, frames: [], slides: [] }),
  fetchUiPrefs: vi.fn(),
  saveUiPrefs: vi.fn(),
  resetUiPrefs: vi.fn(),
  fetchWebHome: vi.fn(),
  UiPrefsAnonymousError: class UiPrefsAnonymousError extends Error {},
}));

const t = translations.en;

const SECTIONS: UiPrefs['home']['sections'] = [
  { id: 'resume', visible: true }, { id: 'songs', visible: true }, { id: 'playlists', visible: true },
  { id: 'collections', visible: true }, { id: 'films', visible: true },
];
const prefsWith = (inbox: InboxView): UiPrefs => ({ v: 1, views: { inbox, links: 'studio' }, home: { sections: SECTIONS }, player: { dock: 'bottom', float: { x: 1, y: 1 } } });

const song = (title: string, artist: string) => ({ title, artist, album: null, source: 'ai_analysis' as const, spotifyUri: null, spotifyUrl: null, youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false });

function makeEntry(id: string, summary: string, over: Partial<Entry> = {}, results: Partial<Entry['results']> = {}): Entry {
  return {
    id, sourceUrl: `https://instagram.com/reel/${id}`, sourcePlatform: 'instagram', inputChannel: 'web', inputUser: null, caption: null, thumbnailUrl: null,
    mediaUrl: null, status: 'completed', results: { songs: [], films: [], notes: [], links: [], tags: [], summary, ...results },
    actionLog: [], createdAt: '2026-11-10T10:00:00Z', ...over,
  };
}

function mockJournal(entries: Entry[], over: Record<string, unknown> = {}) {
  vi.mocked(useJournal).mockReturnValue({
    entries, stats: { totalEntries: entries.length, totalSongs: 0, totalFilms: 0, totalNotes: 0 }, loading: false, error: null,
    currentPage: 1, totalPages: 1, hasNext: false, hasPrev: false, nextPage: vi.fn(), prevPage: vi.fn(),
    availablePlatforms: [], availableChannels: [], availableUsers: [], availableCategories: [], availableVerdicts: [], availableTags: [],
    filteredCount: entries.length, ...over,
  } as ReturnType<typeof useJournal>);
}

function LocationProbe() {
  const l = useLocation();
  return <output data-testid="where">{`${l.pathname}${l.search}`}</output>;
}

function renderInbox(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LanguageProvider><UiPrefsProvider><Home /><LocationProbe /></UiPrefsProvider></LanguageProvider>
    </MemoryRouter>,
  );
}

const wall = () => screen.queryByRole('list', { name: t.wallLabel });
const card = (text: RegExp | string) => screen.getByRole('button', { name: text });

const NIGHT = makeEntry('night', 'SUMMARY NIGHT', {}, { songs: [song('Nightcall', 'Kavinsky'), song('Lux Aeterna', 'Clint Mansell')] });
const PLAIN = makeEntry('plain', 'SUMMARY PLAIN');

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('studio'));
  vi.mocked(api.fetchWebHome).mockResolvedValue({ sections: [] });
  vi.mocked(useSearch).mockReturnValue({ results: [], expandedTerms: [], loading: false, error: null } as ReturnType<typeof useSearch>);
  mockJournal([NIGHT, PLAIN]);
});

describe('Inbox — which view', () => {
  it('the Studio is the default: list on the left, inspector on the right, no wall', async () => {
    renderInbox();
    await screen.findByRole('group', { name: t.viewSwitchLabel });
    expect(document.querySelector('.master-detail')).not.toBeNull();
    expect(wall()).toBeNull();
    expect(screen.getByRole('radio', { name: t.viewStudio })).toBeChecked();
  });

  it('a saved Bacheca opens as the wall, one card per post with its songs in view, and no list-and-detail', async () => {
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('wall'));
    renderInbox();
    await screen.findByRole('list', { name: t.wallLabel });
    expect(within(wall() as HTMLElement).getAllByRole('listitem')).toHaveLength(2);
    expect(card(/SUMMARY NIGHT/)).toHaveTextContent('Nightcall — Kavinsky');
    expect(document.querySelector('.master-detail')).toBeNull();
    expect(screen.getByRole('radio', { name: t.viewWall })).toBeChecked();
  });

  it('the wall shows every post that was loaded; the Studio keeps its five recent ones', async () => {
    const many = Array.from({ length: 8 }, (_, i) => makeEntry(`e${i}`, `POST ${i}`));
    mockJournal(many);
    const studio = renderInbox();
    await screen.findByRole('group', { name: t.viewSwitchLabel });
    expect(document.querySelectorAll('.compact-card')).toHaveLength(5);
    studio.unmount();
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('wall'));
    renderInbox();
    await screen.findByRole('list', { name: t.wallLabel });
    expect(within(wall() as HTMLElement).getAllByRole('listitem')).toHaveLength(8);
  });

  it('the switch changes the view at once and saves it (only this page)', async () => {
    vi.mocked(api.saveUiPrefs).mockResolvedValueOnce(prefsWith('wall')).mockResolvedValueOnce(prefsWith('studio'));
    renderInbox();
    await userEvent.click(await screen.findByRole('radio', { name: t.viewWall }));
    expect(await screen.findByRole('list', { name: t.wallLabel })).toBeInTheDocument();
    expect(api.saveUiPrefs).toHaveBeenCalledWith({ views: { inbox: 'wall' } });
    await userEvent.click(screen.getByRole('radio', { name: t.viewStudio }));
    await waitFor(() => expect(wall()).toBeNull());
    expect(document.querySelector('.master-detail')).not.toBeNull();
  });

  it('while the first answer about the views is on its way the page shows neither, only the wait', async () => {
    vi.mocked(api.fetchUiPrefs).mockReturnValue(new Promise(() => undefined));
    renderInbox();
    expect(await screen.findByText(t.loading)).toBeInTheDocument();
    expect(document.querySelector('.master-detail')).toBeNull();
    expect(wall()).toBeNull();
  });

  it('if the server cannot be asked the page is the Studio, never blank', async () => {
    vi.mocked(api.fetchUiPrefs).mockRejectedValue(new Error('network down'));
    renderInbox();
    await waitFor(() => expect(document.querySelector('.master-detail')).not.toBeNull());
  });
});

describe('Inbox — the wall and its panel', () => {
  beforeEach(() => {
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('wall'));
  });

  it('a card opens the detail of the post in a panel next to the wall; × closes it', async () => {
    renderInbox();
    await screen.findByRole('list', { name: t.wallLabel });
    expect(screen.queryByRole('complementary', { name: t.detailLabel })).toBeNull();
    await userEvent.click(card(/SUMMARY PLAIN/));
    const panel = await screen.findByRole('complementary', { name: t.detailLabel });
    expect(within(panel).getByText('SUMMARY PLAIN')).toBeInTheDocument();
    expect(card(/SUMMARY PLAIN/)).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(panel).getByRole('button', { name: t.detailClose }));
    expect(screen.queryByRole('complementary', { name: t.detailLabel })).toBeNull();
    expect(card(/SUMMARY PLAIN/)).toHaveAttribute('aria-pressed', 'false');
  });

  it('another card changes the panel without closing it', async () => {
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /SUMMARY PLAIN/ }));
    await userEvent.click(card(/SUMMARY NIGHT/));
    const panel = await screen.findByRole('complementary', { name: t.detailLabel });
    expect(within(panel).getByText('SUMMARY NIGHT')).toBeInTheDocument();
    expect(within(panel).queryByText('SUMMARY PLAIN')).toBeNull();
  });

  it('a link with ?entry= opens its panel (here the post is on the loaded page), and closing it takes ?entry= out of the address', async () => {
    renderInbox('/?entry=night');
    const panel = await screen.findByRole('complementary', { name: t.detailLabel });
    expect(within(panel).getByText('SUMMARY NIGHT')).toBeInTheDocument();
    expect(api.getEntry).not.toHaveBeenCalled();
    await userEvent.click(within(panel).getByRole('button', { name: t.detailClose }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: t.detailLabel })).toBeNull());
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/);
  });

  it('a link to a post that is not on the loaded page fetches it and shows it in the panel', async () => {
    vi.mocked(api.getEntry).mockResolvedValue(makeEntry('old', 'SUMMARY OLD ONE'));
    renderInbox('/?entry=old');
    const panel = await screen.findByRole('complementary', { name: t.detailLabel });
    expect(await within(panel).findByText('SUMMARY OLD ONE')).toBeInTheDocument();
    expect(api.getEntry).toHaveBeenCalledWith('old');
  });

  it('under the wall, «open the whole library» leads to the Link page; with a filter on, it is not offered', async () => {
    renderInbox();
    expect(await screen.findByRole('link', { name: t.seeAllJournal })).toHaveAttribute('href', '/entries');
  });

  it('the filter on: no «open the whole library» link under the filtered wall', async () => {
    mockJournal([NIGHT, PLAIN], { availablePlatforms: [{ platform: 'instagram', count: 2 }, { platform: 'tiktok', count: 1 }] });
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: t.filterToggle }));
    await userEvent.click(screen.getByRole('button', { name: /^IG\s*2$/ }));
    await waitFor(() => expect(screen.queryByRole('link', { name: t.seeAllJournal })).toBeNull());
  });

  it('no posts: the empty message, not an empty wall', async () => {
    mockJournal([]);
    renderInbox();
    expect(await screen.findByText(t.noEntries)).toBeInTheDocument();
    expect(wall()).toBeNull();
  });

  it('the search works in the wall: the results are the cards, with how many there are', async () => {
    const found: SearchResult = {
      id: 'r1', sourceUrl: 'https://youtube.com/watch?v=1', sourcePlatform: 'youtube', caption: null, thumbnailUrl: null, rank: 1,
      results: { songs: [{ title: 'Blue in Green', artist: 'Miles Davis' }], films: [], notes: [], tags: [], summary: 'A JAZZ RESULT' }, createdAt: '2026-11-09T10:00:00Z',
    };
    vi.mocked(useSearch).mockReturnValue({ results: [found], expandedTerms: [], loading: false, error: null } as ReturnType<typeof useSearch>);
    renderInbox('/?q=jazz');
    expect(await screen.findByRole('button', { name: /A JAZZ RESULT/ })).toHaveTextContent('Blue in Green — Miles Davis');
    expect(screen.queryByRole('button', { name: /SUMMARY NIGHT/ })).toBeNull();
    expect(screen.getByText(/1 risultati per/)).toBeInTheDocument();   // the search line is written in Italian in the page, in every view
  });

  it('no results for a search: the message, not an empty wall', async () => {
    renderInbox('/?q=zzz');
    expect(await screen.findByText(/Nessun risultato per/)).toBeInTheDocument();
    expect(wall()).toBeNull();
  });

  it('the filters work in the wall: the toggle opens the chips and a chip asks the journal for that platform', async () => {
    mockJournal([NIGHT, PLAIN], { availablePlatforms: [{ platform: 'instagram', count: 2 }, { platform: 'tiktok', count: 1 }] });
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: t.filterToggle }));
    await userEvent.click(screen.getByRole('button', { name: /^IG\s*2$/ }));      // the chip «IG 2» (jsdom has no layout, so no space between the two spans), not a card
    await waitFor(() => expect(vi.mocked(useJournal)).toHaveBeenLastCalledWith(20, expect.objectContaining({ platform: 'instagram' })));
  });
});

describe('Inbox — the Home view', () => {
  const HOME_POSTS = {
    sections: [
      { id: 'resume' as const, total: 2, items: [
        { id: 'night', sourceUrl: 'https://instagram.com/reel/night', sourcePlatform: 'instagram', caption: null, thumbnailUrl: null, status: 'completed', createdAt: '2026-11-10T10:00:00.000Z', summary: 'SUMMARY NIGHT', songCount: 2, filmCount: 0, noteCount: 0, tags: [] },
        { id: 'plain', sourceUrl: 'https://instagram.com/reel/plain', sourcePlatform: 'instagram', caption: null, thumbnailUrl: null, status: 'completed', createdAt: '2026-11-10T09:00:00.000Z', summary: 'SUMMARY PLAIN', songCount: 0, filmCount: 0, noteCount: 0, tags: [] },
      ] },
      { id: 'films' as const, total: 1, items: [{ filmKey: 'dune::2021', title: 'Dune', year: '2021', posterUrl: null, imdbUrl: null, entryId: 'night', sourceUrl: null, createdAt: '2026-11-10T10:00:00.000Z' }] },
    ],
  };

  beforeEach(() => {
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('home'));
    vi.mocked(api.fetchWebHome).mockResolvedValue(HOME_POSTS);
  });

  it('a saved Home draws the sections the server prepared, and neither the list-and-detail nor the wall of the journal', async () => {
    renderInbox();
    expect(await screen.findByRole('heading', { level: 2, name: t.homeSectionResume })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: t.homeSectionFilms })).toBeInTheDocument();
    expect(document.querySelector('.master-detail')).toBeNull();
    expect(wall()).toBeNull();                                       // the cards of «pick up» are a list named after their section
    expect(screen.getByRole('radio', { name: t.viewHome })).toBeChecked();
  });

  it('the field to paste a link stays on top in every view', async () => {
    renderInbox();
    await screen.findByRole('heading', { level: 2, name: t.homeSectionResume });
    expect(document.querySelector('#paste, .url-input')).not.toBeNull();
  });

  it('a post of «pick up» opens in the panel that closes', async () => {
    renderInbox();
    const resume = (await screen.findByRole('heading', { level: 2, name: t.homeSectionResume })).closest('section') as HTMLElement;
    await userEvent.click(within(resume).getByRole('button', { name: /SUMMARY PLAIN/ }));
    const panel = await screen.findByRole('complementary', { name: t.detailLabel });
    expect(within(panel).getByText('SUMMARY PLAIN')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: t.detailClose }));
    expect(screen.queryByRole('complementary', { name: t.detailLabel })).toBeNull();
  });

  it('the filters of the journal are not offered here (the Home has no list to filter)', async () => {
    mockJournal([NIGHT, PLAIN], { availablePlatforms: [{ platform: 'instagram', count: 2 }, { platform: 'tiktok', count: 1 }] });
    renderInbox();
    await screen.findByRole('heading', { level: 2, name: t.homeSectionResume });
    expect(screen.queryByRole('button', { name: t.filterToggle })).toBeNull();
  });

  it('a search shows its results (as cards), not the sections', async () => {
    const found: SearchResult = {
      id: 'r1', sourceUrl: 'https://youtube.com/watch?v=1', sourcePlatform: 'youtube', caption: null, thumbnailUrl: null, rank: 1,
      results: { songs: [], films: [], notes: [], tags: [], summary: 'A JAZZ RESULT' }, createdAt: '2026-11-09T10:00:00Z',
    };
    vi.mocked(useSearch).mockReturnValue({ results: [found], expandedTerms: [], loading: false, error: null } as ReturnType<typeof useSearch>);
    renderInbox('/?q=jazz');
    expect(await screen.findByRole('button', { name: /A JAZZ RESULT/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: t.homeSectionResume })).toBeNull();
  });

  it('a link with ?entry= opens its panel here too', async () => {
    renderInbox('/?entry=night');
    const panel = await screen.findByRole('complementary', { name: t.detailLabel });
    expect(within(panel).getByText('SUMMARY NIGHT')).toBeInTheDocument();
  });

  it('choosing Home from the Studio saves only this page', async () => {
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('studio'));
    vi.mocked(api.saveUiPrefs).mockResolvedValue(prefsWith('home'));
    renderInbox();
    await userEvent.click(await screen.findByRole('radio', { name: t.viewHome }));
    expect(api.saveUiPrefs).toHaveBeenCalledWith({ views: { inbox: 'home' } });
    expect(await screen.findByRole('heading', { level: 2, name: t.homeSectionResume })).toBeInTheDocument();
  });
});
