import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import '@testing-library/jest-dom';
import { Home } from './Home';
import { LanguageProvider } from '../i18n';
import { UiPrefsProvider } from '../hooks/useUiPrefs';
import { useInbox } from '../hooks/useInbox';
import { useSearch } from '../hooks/useSearch';
import * as api from '../services/api';
import { translations } from '../i18n/translations';
import type { Entry, EntryFacets, EntrySummary, InboxView, UiPrefs } from '../types';

// The Inbox, a page of the whole library at a time (Michele, 10 November: «in inbox sulla lista non voglio avere "apri tutta la libreria" ma la
// paginazione con 30 o 40 per pagina», spec 2026-11-10-web-look-and-feel-rethink-design.md §3.6): 40 posts a page, the number of the page in the address,
// and the filters of «Filtra» applied by the server on the WHOLE library, not on the few posts already loaded.

vi.mock('../hooks/useInbox', () => ({ useInbox: vi.fn(), INBOX_PAGE_SIZE: 40 }));
vi.mock('../hooks/useSearch', () => ({ useSearch: vi.fn() }));
const submit = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('../hooks/useAnalyze', () => ({
  useAnalyze: () => ({ analyze: submit.analyze, loading: false, error: null, successStatus: null, clearError: vi.fn() }),
}));
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

const summary = (id: string, text: string, over: Partial<EntrySummary> = {}): EntrySummary => ({
  id, sourceUrl: `https://instagram.com/reel/${id}`, sourcePlatform: 'instagram', caption: null, thumbnailUrl: null, status: 'completed',
  createdAt: '2026-11-10T10:00:00.000Z', summary: text, songCount: 0, filmCount: 0, noteCount: 0, tags: [], ...over,
});
const full = (id: string, text: string): Entry => ({
  id, sourceUrl: `https://instagram.com/reel/${id}`, sourcePlatform: 'instagram', inputChannel: 'web', inputUser: null, caption: null, thumbnailUrl: null,
  mediaUrl: null, status: 'completed', results: { songs: [], films: [], notes: [], links: [], tags: [], summary: text }, actionLog: [], createdAt: '2026-11-10T10:00:00Z',
});

const EMPTY_FACETS: EntryFacets = { platforms: [], channels: [], users: [], categories: [], verdicts: [], tags: [] };
const FACETS: EntryFacets = {
  platforms: [{ platform: 'instagram', count: 900 }, { platform: 'tiktok', count: 300 }],
  channels: [{ channel: 'telegram', count: 1500 }, { channel: 'web', count: 200 }],
  users: [{ user: 'mike', count: 1600 }, { user: 'sara', count: 100 }],
  categories: [{ category: 'tech', count: 12 }],
  verdicts: [{ verdict: 'true', count: 5 }],
  tags: [{ tag: '#vino', count: 15 }, { tag: '#ai', count: 40 }],
};
const reload = vi.fn();

function mockInbox(entries: EntrySummary[], over: Partial<ReturnType<typeof useInbox>> = {}) {
  vi.mocked(useInbox).mockReturnValue({
    entries, total: entries.length, pageCount: 1, loading: false, error: false, facets: EMPTY_FACETS, version: 0, reload, ...over,
  });
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

const where = () => screen.getByTestId('where').textContent;
const lastCall = () => vi.mocked(useInbox).mock.calls[vi.mocked(useInbox).mock.calls.length - 1];
const nav = () => screen.getByRole('navigation', { name: t.pageNavLabel });
const goTo = (n: number) => userEvent.click(within(nav()).getByRole('button', { name: t.pageGoTo.replace('{page}', String(n)) }));

const PAGE_OF_POSTS = Array.from({ length: 40 }, (_, i) => summary(`p${i}`, `POST NUMBER ${i}`));

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('studio'));
  vi.mocked(api.fetchWebHome).mockResolvedValue({ sections: [] });
  vi.mocked(api.getEntry).mockImplementation(async (id: string) => full(id, `FULL ${id}`));
  vi.mocked(useSearch).mockReturnValue({ results: [], expandedTerms: [], loading: false, error: null } as ReturnType<typeof useSearch>);
  mockInbox(PAGE_OF_POSTS, { total: 1721, pageCount: 44, facets: FACETS });
});

describe('Inbox — the pages', () => {
  it('shows the posts of the page, 40 of them, and under them the pages of the whole library (44): never «open the whole library»', async () => {
    renderInbox();
    await screen.findByRole('button', { name: /POST NUMBER 0\b/ });
    expect(document.querySelectorAll('.library-row')).toHaveLength(40);
    expect(within(nav()).getAllByRole('button').map((b) => b.textContent)).toEqual(['‹', '1', '2', '3', '4', '5', '44', '›']);
    expect(screen.queryByRole('link', { name: /libreria|library/i })).toBeNull();
  });

  it('asks the first page of everything, with no filter', async () => {
    renderInbox();
    await screen.findByRole('navigation', { name: t.pageNavLabel });
    expect(lastCall()).toEqual([1, {}]);
  });

  it('says how many posts there are in all', async () => {
    renderInbox();
    expect(await screen.findByText(t.inboxCount.replace('{total}', '1721'))).toBeInTheDocument();
  });

  it('has no pages when everything fits in one', async () => {
    mockInbox(PAGE_OF_POSTS.slice(0, 5), { total: 5, pageCount: 1 });
    renderInbox();
    await screen.findByRole('button', { name: /POST NUMBER 0\b/ });
    expect(screen.queryByRole('navigation', { name: t.pageNavLabel })).toBeNull();
  });

  it('the page is in the address: ?pagina=3 opens the third page', async () => {
    renderInbox('/?pagina=3');
    await screen.findByRole('navigation', { name: t.pageNavLabel });
    expect(lastCall()).toEqual([3, {}]);
    expect(within(nav()).getByRole('button', { name: t.pageGoTo.replace('{page}', '3') })).toHaveAttribute('aria-current', 'page');
  });

  it('a number in the bar changes the page and the address; page 1 takes the number out of the address again', async () => {
    renderInbox();
    await screen.findByRole('navigation', { name: t.pageNavLabel });
    await goTo(4);
    await waitFor(() => expect(where()).toBe('/?pagina=4'));
    expect(lastCall()).toEqual([4, {}]);
    await goTo(1);
    await waitFor(() => expect(where()).toBe('/'));
    expect(lastCall()).toEqual([1, {}]);
  });

  it('«next» and «previous» go one page', async () => {
    renderInbox('/?pagina=5');
    await screen.findByRole('navigation', { name: t.pageNavLabel });
    await userEvent.click(within(nav()).getByRole('button', { name: t.pageNext }));
    await waitFor(() => expect(where()).toBe('/?pagina=6'));
    await userEvent.click(within(nav()).getByRole('button', { name: t.pagePrev }));
    await waitFor(() => expect(where()).toBe('/?pagina=5'));
  });

  it('a change of page leaves the rest of the address as it was (the post that is open stays open)', async () => {
    renderInbox('/?entry=p1');
    await screen.findByRole('navigation', { name: t.pageNavLabel });
    await goTo(2);
    await waitFor(() => expect(where()).toBe('/?entry=p1&pagina=2'));
  });

  it('a new page starts at the top of the list', async () => {
    renderInbox();
    await screen.findByRole('navigation', { name: t.pageNavLabel });
    const list = document.querySelector('.links-list') as HTMLElement;
    list.scrollTop = 600;
    await goTo(2);
    await waitFor(() => expect(list.scrollTop).toBe(0));
  });

  it('a page beyond the last (an old link, a library that got smaller) lands on the last page there is', async () => {
    renderInbox('/?pagina=99');
    await waitFor(() => expect(where()).toBe('/?pagina=44'));
  });

  it('a page that is no number is the first page', async () => {
    renderInbox('/?pagina=abc');
    await screen.findByRole('navigation', { name: t.pageNavLabel });
    expect(lastCall()).toEqual([1, {}]);
  });

  it('while the page is being read the pages do not jump to the last one', async () => {
    mockInbox([], { loading: true, total: 0, pageCount: 1 });
    renderInbox('/?pagina=7');
    await screen.findByText(t.loading);
    expect(where()).toBe('/?pagina=7');
  });

  it('the wall has its pages too', async () => {
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('wall'));
    renderInbox();
    await screen.findByRole('list', { name: t.wallLabel });
    expect(within(nav()).getByRole('button', { name: t.pageGoTo.replace('{page}', '44') })).toBeInTheDocument();
  });
});

describe('Inbox — the filters are the server\'s, on the whole library', () => {
  const open = async () => userEvent.click(await screen.findByRole('button', { name: t.filterToggle }));

  it('a chip asks for that filter and goes back to the first page', async () => {
    renderInbox('/?pagina=3');
    await open();
    await userEvent.click(screen.getByRole('button', { name: /^TT\s*300$/ }));
    expect(lastCall()).toEqual([1, { platform: 'tiktok' }]);
    await waitFor(() => expect(where()).toBe('/'));
  });

  it('each kind of chip is its own filter, and they add up', async () => {
    renderInbox();
    await open();
    await userEvent.click(screen.getByRole('button', { name: /^IG\s*900$/ }));
    await userEvent.click(screen.getByRole('button', { name: /^TG\s*1500$/ }));
    await userEvent.click(screen.getByRole('button', { name: /^sara\s*100$/ }));
    await userEvent.click(screen.getByRole('button', { name: /Tech\s*12$/ }));
    await userEvent.click(screen.getByRole('button', { name: /TRUE\s*5$/ }));
    await userEvent.click(screen.getByRole('button', { name: /^#vino\s*15$/ }));
    expect(lastCall()).toEqual([1, { platform: 'instagram', channel: 'telegram', user: 'sara', category: 'tech', verdict: 'true', tag: '#vino' }]);
  });

  it('the same chip again takes the filter off; «All» takes them all off', async () => {
    renderInbox();
    await open();
    await userEvent.click(screen.getByRole('button', { name: /^IG\s*900$/ }));
    expect(lastCall()).toEqual([1, { platform: 'instagram' }]);
    await userEvent.click(screen.getByRole('button', { name: /^IG\s*900$/ }));
    expect(lastCall()?.[1]).toEqual({ platform: null });
    await userEvent.click(screen.getByRole('button', { name: /^#ai\s*40$/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Tutti' }));
    expect(lastCall()).toEqual([1, {}]);
  });

  it('«All» takes the filters off and goes back to the first page, even from a later one', async () => {
    renderInbox();
    await open();
    await userEvent.click(screen.getByRole('button', { name: /^IG\s*900$/ }));
    await goTo(2);
    await waitFor(() => expect(where()).toBe('/?pagina=2'));
    await userEvent.click(screen.getByRole('button', { name: 'Tutti' }));
    await waitFor(() => expect(where()).toBe('/'));
    expect(lastCall()).toEqual([1, {}]);
  });

  it('the tag chips are the 24 most used (the server sends 40): the rest are on the next visit of the filters, not a wall of chips', async () => {
    const tags = Array.from({ length: 30 }, (_, i) => ({ tag: `#tag${String(i).padStart(2, '0')}x`, count: 100 - i }));
    mockInbox(PAGE_OF_POSTS, { total: 1721, pageCount: 44, facets: { ...FACETS, tags } });
    renderInbox();
    await open();
    expect(screen.getAllByRole('button', { name: /^#tag\d\dx\s*\d+$/ })).toHaveLength(24);
  });

  it('the toggle says how many posts pass the filter, and the chips stay open while a filter is on', async () => {
    renderInbox();
    await open();
    await userEvent.click(screen.getByRole('button', { name: /^IG\s*900$/ }));
    mockInbox(PAGE_OF_POSTS.slice(0, 3), { total: 900, pageCount: 23, facets: FACETS });
    await userEvent.click(screen.getByRole('button', { name: /^IG\s*900$/ }));      // off and on again to redraw with the new answer
    await userEvent.click(screen.getByRole('button', { name: /^IG\s*900$/ }));
    expect(screen.getByRole('button', { name: new RegExp(`${t.filterToggle} · 900`) })).toBeInTheDocument();
  });

  it('a channel or a user that is only one in the library is no choice, so it has no chip (as before)', async () => {
    mockInbox(PAGE_OF_POSTS, { total: 1721, pageCount: 44, facets: { ...FACETS, channels: [{ channel: 'telegram', count: 1721 }], users: [{ user: 'mike', count: 1721 }] } });
    renderInbox();
    await open();
    expect(screen.queryByRole('button', { name: /^TG\s*1721$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^mike\s*1721$/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^IG\s*900$/ })).toBeInTheDocument();
  });

  it('the chips come from the facets of the server: no facets, no «Filter» button', async () => {
    mockInbox(PAGE_OF_POSTS, { total: 1721, pageCount: 44, facets: null });
    renderInbox();
    await screen.findByRole('navigation', { name: t.pageNavLabel });
    expect(screen.queryByRole('button', { name: t.filterToggle })).toBeNull();
  });

  it('with a filter on and nothing that passes it, it says so and offers to take the filters off', async () => {
    renderInbox();
    await open();
    await userEvent.click(screen.getByRole('button', { name: /^IG\s*900$/ }));
    mockInbox([], { total: 0, pageCount: 1, facets: FACETS });
    await userEvent.click(screen.getByRole('button', { name: /^TT\s*300$/ }));
    expect(await screen.findByText(t.inboxNoMatch)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: t.inboxClearFilters }));
    expect(lastCall()).toEqual([1, {}]);
  });
});

describe('Inbox — it follows the library', () => {
  it('when the library changes (the version goes up) the post that is open is read again, in the list', async () => {
    mockInbox(PAGE_OF_POSTS, { total: 1721, pageCount: 44, facets: FACETS, version: 0 });
    const view = renderInbox('/?entry=p1');
    await screen.findByText('FULL p1');
    expect(api.getEntry).toHaveBeenCalledTimes(1);
    mockInbox(PAGE_OF_POSTS, { total: 1721, pageCount: 44, facets: FACETS, version: 1 });
    view.rerender(
      <MemoryRouter initialEntries={['/?entry=p1']}>
        <LanguageProvider><UiPrefsProvider><Home /><LocationProbe /></UiPrefsProvider></LanguageProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.getEntry).toHaveBeenCalledTimes(2));
  });

  it('and in the Home view too (the post is opened from a section)', async () => {
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('home'));
    mockInbox(PAGE_OF_POSTS, { total: 1721, pageCount: 44, facets: FACETS, version: 0 });
    const view = renderInbox('/?entry=p1');
    await screen.findByText('FULL p1');
    expect(api.getEntry).toHaveBeenCalledTimes(1);
    mockInbox(PAGE_OF_POSTS, { total: 1721, pageCount: 44, facets: FACETS, version: 1 });
    view.rerender(
      <MemoryRouter initialEntries={['/?entry=p1']}>
        <LanguageProvider><UiPrefsProvider><Home /><LocationProbe /></UiPrefsProvider></LanguageProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.getEntry).toHaveBeenCalledTimes(2));
  });

  it('a post deleted from the panel closes it and the page is read again (the pages move up by one)', async () => {
    vi.mocked(api.deleteEntry).mockResolvedValue({ success: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderInbox('/?entry=p1');
    await screen.findByText('FULL p1');
    await userEvent.click(await screen.findByRole('button', { name: /Delete|Elimina|🗑/ }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('FULL p1')).toBeNull();
  });
});

describe('Inbox — when it goes wrong, and when a link is pasted', () => {
  it('a page that cannot be read says so, with «Retry» that asks again, not a blank list', async () => {
    mockInbox([], { error: true, total: 0, pageCount: 1 });
    renderInbox();
    expect(await screen.findByRole('alert')).toHaveTextContent(t.inboxLoadError);
    expect(screen.queryByText(/\d+ posts?$/)).toBeNull();   // no count over an error
    await userEvent.click(screen.getByRole('button', { name: t.libRetry }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('navigation', { name: t.pageNavLabel })).toBeNull();
  });

  it('a link that was pasted opens its post and brings the list back to the first page, where the new post arrives', async () => {
    submit.analyze.mockResolvedValue('brand-new');
    renderInbox('/?pagina=3');
    await screen.findByRole('navigation', { name: t.pageNavLabel });
    await userEvent.type(screen.getByRole('textbox'), 'https://instagram.com/reel/abc');
    await userEvent.click(screen.getByRole('button', { name: /Analyze|Analizza/ }));
    await waitFor(() => expect(where()).toBe('/'));
    await waitFor(() => expect(api.getEntry).toHaveBeenCalledWith('brand-new'));
    expect(await screen.findByText('FULL brand-new')).toBeInTheDocument();
  });

  it('a search is not paged (and says nothing of pages): its results are the page', async () => {
    renderInbox('/?q=jazz&pagina=2');
    await screen.findByText(/risultati per/);
    expect(screen.queryByRole('navigation', { name: t.pageNavLabel })).toBeNull();
    expect(screen.queryByText(t.inboxCount.replace('{total}', '1721'))).toBeNull();
  });

  it('the Home view has no pages and no count: it is not a list', async () => {
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('home'));
    renderInbox();
    await screen.findByRole('radio', { name: t.viewHome });
    await waitFor(() => expect(screen.getByRole('radio', { name: t.viewHome })).toBeChecked());
    expect(screen.queryByRole('navigation', { name: t.pageNavLabel })).toBeNull();
    expect(screen.queryByText(t.inboxCount.replace('{total}', '1721'))).toBeNull();
  });
});
