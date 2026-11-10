import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { EntriesPage } from './EntriesPage';
import { LanguageProvider } from '../i18n';
import { UiPrefsProvider } from '../hooks/useUiPrefs';
import * as api from '../services/api';
import { translations } from '../i18n/translations';
import type { Entry, EntrySummary, LinksView, UiPrefs } from '../types';

// Look and feel P3: the Link page (all the posts) has two views, chosen by the user and kept on the server: Studio (list on the left, the
// post on the right, the default) and Bacheca (a wall of cards and a panel that closes). It has no Home view. It lists summaries, so the post
// that is opened is read by its id.

vi.mock('../services/api', () => ({
  listEntrySummaries: vi.fn(),
  getEntry: vi.fn(),
  deleteEntry: vi.fn(),
  retryEntry: vi.fn(),
  enrichEntry: vi.fn(),
  fetchMe: vi.fn().mockResolvedValue({ user: 'mike', displayName: 'Mike', isAdmin: false, authenticated: true, family: [] }),
  fetchEntryMedia: vi.fn().mockResolvedValue({ entryId: '', videoUrl: null, audioUrl: null, thumbnailUrl: null, frames: [], slides: [] }),
  fetchUiPrefs: vi.fn(),
  saveUiPrefs: vi.fn(),
  resetUiPrefs: vi.fn(),
  UiPrefsAnonymousError: class UiPrefsAnonymousError extends Error {},
}));

const t = translations.en;

const SECTIONS: UiPrefs['home']['sections'] = [
  { id: 'resume', visible: true }, { id: 'songs', visible: true }, { id: 'playlists', visible: true },
  { id: 'collections', visible: true }, { id: 'films', visible: true },
];
const prefsWith = (links: LinksView): UiPrefs => ({ v: 1, views: { inbox: 'studio', links }, home: { sections: SECTIONS }, player: { dock: 'bottom', float: { x: 1, y: 1 } } });

const row = (id: string, summary: string, over: Partial<EntrySummary> = {}): EntrySummary => ({
  id, sourceUrl: `https://instagram.com/reel/${id}`, sourcePlatform: 'instagram', caption: null, thumbnailUrl: null, status: 'completed',
  createdAt: '2026-11-10T10:00:00.000Z', summary, songCount: 0, filmCount: 0, noteCount: 0, tags: [], ...over,
});

const full = (id: string, summary: string): Entry => ({
  id, sourceUrl: `https://instagram.com/reel/${id}`, sourcePlatform: 'instagram', inputChannel: 'web', inputUser: null, caption: null, thumbnailUrl: null,
  mediaUrl: null, status: 'completed', results: { songs: [], films: [], notes: [], links: [], tags: [], summary }, actionLog: [], createdAt: '2026-11-10T10:00:00Z',
});

const ROWS = [
  row('one', 'FIRST POST ABOUT JAZZ', { songCount: 12, tags: ['jazz'] }),
  row('two', 'SECOND POST ABOUT FILMS', { filmCount: 2, createdAt: '2026-11-09T09:00:00.000Z' }),
  row('three', 'THIRD POST', { noteCount: 1, createdAt: '2026-11-09T07:00:00.000Z' }),
];

function page(entries: EntrySummary[], total = entries.length, offset = 0) {
  return { entries, total, limit: 40, offset };
}

function renderLinks(path = '/entries') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LanguageProvider><UiPrefsProvider><EntriesPage /></UiPrefsProvider></LanguageProvider>
    </MemoryRouter>,
  );
}

const wall = () => screen.queryByRole('list', { name: t.wallLabel });
const rowButton = (text: RegExp) => screen.getByRole('button', { name: text });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('studio'));
  vi.mocked(api.listEntrySummaries).mockResolvedValue(page(ROWS));
  vi.mocked(api.getEntry).mockImplementation(async (id: string) => full(id, `FULL ${id.toUpperCase()}`));
});

describe('Link page — Studio (the default)', () => {
  it('lists every post, the count, and waits on the right for a post to be opened', async () => {
    renderLinks();
    await screen.findByRole('button', { name: /FIRST POST ABOUT JAZZ/ });
    expect(screen.getAllByRole('button', { name: /POST/ }).length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(t.selectEntry)).toBeInTheDocument();
    expect(wall()).toBeNull();
    expect(screen.getByRole('radio', { name: t.viewStudio })).toBeChecked();
  });

  it('a row opens the post on the right (it is read by its id) and is the pressed one', async () => {
    renderLinks();
    await userEvent.click(await screen.findByRole('button', { name: /SECOND POST ABOUT FILMS/ }));
    expect(api.getEntry).toHaveBeenCalledWith('two');
    const detail = await screen.findByText('FULL TWO', { selector: '.inspector-summary, .inspector *' });
    expect(detail).toBeInTheDocument();
    expect(rowButton(/SECOND POST ABOUT FILMS/)).toHaveAttribute('aria-pressed', 'true');
    expect(rowButton(/FIRST POST ABOUT JAZZ/)).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText(t.selectEntry)).toBeNull();
  });

  it('each row keeps its link to the post in the Inbox', async () => {
    renderLinks();
    await screen.findByRole('button', { name: /FIRST POST ABOUT JAZZ/ });
    const links = screen.getAllByRole('link', { name: t.openEntry });
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/?entry=one', '/?entry=two', '/?entry=three']);
  });

  it('shows the counts of every post (songs, films, notes) and its tags', async () => {
    renderLinks();
    await screen.findByRole('button', { name: /FIRST POST ABOUT JAZZ/ });
    expect(screen.getByText('🎵 12')).toBeInTheDocument();
    expect(screen.getByText('🎬 2')).toBeInTheDocument();
    expect(screen.getByText('📝 1')).toBeInTheDocument();
    expect(screen.getByText('jazz')).toBeInTheDocument();
  });

  it('?q= keeps only the posts that say it, in the summary, the tags or the link', async () => {
    renderLinks('/entries?q=jazz');
    await screen.findByRole('button', { name: /FIRST POST ABOUT JAZZ/ });
    expect(screen.queryByRole('button', { name: /SECOND POST/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /THIRD POST/ })).toBeNull();
  });

  it('?q= also looks at the tags, and at the link', async () => {
    vi.mocked(api.listEntrySummaries).mockResolvedValue(page([...ROWS, row('four', 'UNRELATED TEXT', { tags: ['vinyl'] })]));
    const byTag = renderLinks('/entries?q=vinyl');
    await screen.findByRole('button', { name: /UNRELATED TEXT/ });
    expect(screen.queryByRole('button', { name: /FIRST POST/ })).toBeNull();
    byTag.unmount();
    renderLinks('/entries?q=reel%2Fthree');
    await screen.findByRole('button', { name: /THIRD POST/ });
    expect(screen.queryByRole('button', { name: /FIRST POST/ })).toBeNull();
  });

  it('«load more» asks for the next page and adds it, until there is no more', async () => {
    vi.mocked(api.listEntrySummaries).mockResolvedValueOnce(page([ROWS[0]], 2));
    renderLinks();
    await screen.findByRole('button', { name: /FIRST POST ABOUT JAZZ/ });
    vi.mocked(api.listEntrySummaries).mockResolvedValueOnce(page([ROWS[1]], 2, 1));
    await userEvent.click(screen.getByRole('button', { name: t.loadMoreEntries }));
    await screen.findByRole('button', { name: /SECOND POST ABOUT FILMS/ });
    expect(api.listEntrySummaries).toHaveBeenLastCalledWith(40, 1);
    expect(screen.queryByRole('button', { name: t.loadMoreEntries })).toBeNull();
  });

  it('deleting the open post takes its row out of the list, lowers the count, and empties the right side', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(api.deleteEntry).mockResolvedValue(undefined as never);
    renderLinks();
    await userEvent.click(await screen.findByRole('button', { name: /SECOND POST ABOUT FILMS/ }));
    await screen.findByText('FULL TWO');
    await userEvent.click(screen.getByTitle(t.deleteEntry));
    await waitFor(() => expect(screen.queryByRole('button', { name: /SECOND POST ABOUT FILMS/ })).toBeNull());
    expect(api.deleteEntry).toHaveBeenCalledWith('two');
    expect(screen.getByText(t.selectEntry)).toBeInTheDocument();
    expect(screen.getByText(t.entriesCountLabel.replace('{shown}', '2').replace('{total}', '2'))).toBeInTheDocument();
  });

  it('with a filter «load more» is not offered (the filter sees only the posts already loaded)', async () => {
    vi.mocked(api.listEntrySummaries).mockResolvedValue(page([ROWS[0]], 30));
    renderLinks('/entries?q=jazz');
    await screen.findByRole('button', { name: /FIRST POST ABOUT JAZZ/ });
    expect(screen.queryByRole('button', { name: t.loadMoreEntries })).toBeNull();
  });

  it('on a narrow window the open post has a «back» that closes it', async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 375 });
    try {
      renderLinks();
      await userEvent.click(await screen.findByRole('button', { name: /SECOND POST ABOUT FILMS/ }));
      await screen.findByText('FULL TWO');
      await userEvent.click(screen.getByRole('button', { name: t.back }));
      expect(screen.getByText(t.selectEntry)).toBeInTheDocument();
      expect(rowButton(/SECOND POST ABOUT FILMS/)).toHaveAttribute('aria-pressed', 'false');
    } finally {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
    }
  });

  it('on a wide window there is no «back» (the post is right there)', async () => {
    renderLinks();
    await userEvent.click(await screen.findByRole('button', { name: /SECOND POST ABOUT FILMS/ }));
    await screen.findByText('FULL TWO');
    expect(screen.queryByRole('button', { name: t.back })).toBeNull();
  });

  it('an error and an empty library say so', async () => {
    vi.mocked(api.listEntrySummaries).mockRejectedValueOnce(new Error('boom'));
    const failed = renderLinks();
    expect(await screen.findByText(t.error)).toBeInTheDocument();
    failed.unmount();
    vi.mocked(api.listEntrySummaries).mockResolvedValueOnce(page([]));
    renderLinks();
    expect(await screen.findByText(t.noEntries)).toBeInTheDocument();
  });
});

describe('Link page — the views', () => {
  it('has Studio and Bacheca and no Home', async () => {
    renderLinks();
    const group = await screen.findByRole('group', { name: t.viewSwitchLabel });
    expect(within(group).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual([t.viewStudio, t.viewWall]);
  });

  it('a saved Bacheca opens as the wall: one card per post with its counts, and no list-and-detail', async () => {
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('wall'));
    renderLinks();
    await screen.findByRole('list', { name: t.wallLabel });
    expect(within(wall() as HTMLElement).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /FIRST POST ABOUT JAZZ/ })).toHaveTextContent('🎵 12');
    expect(screen.queryByText(t.selectEntry)).toBeNull();
    expect(screen.getByRole('radio', { name: t.viewWall })).toBeChecked();
  });

  it('a card opens the post in a panel that closes', async () => {
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('wall'));
    renderLinks();
    await userEvent.click(await screen.findByRole('button', { name: /THIRD POST/ }));
    const panel = await screen.findByRole('complementary', { name: t.detailLabel });
    expect(await within(panel).findByText('FULL THREE')).toBeInTheDocument();
    expect(api.getEntry).toHaveBeenCalledWith('three');
    await userEvent.click(within(panel).getByRole('button', { name: t.detailClose }));
    expect(screen.queryByRole('complementary', { name: t.detailLabel })).toBeNull();
  });

  it('the switch changes the view and saves only this page; the post that was open stays open', async () => {
    vi.mocked(api.saveUiPrefs).mockResolvedValue(prefsWith('wall'));
    renderLinks();
    await userEvent.click(await screen.findByRole('button', { name: /THIRD POST/ }));
    await screen.findByText('FULL THREE');
    await userEvent.click(screen.getByRole('radio', { name: t.viewWall }));
    expect(api.saveUiPrefs).toHaveBeenCalledWith({ views: { links: 'wall' } });
    const panel = await screen.findByRole('complementary', { name: t.detailLabel });
    expect(await within(panel).findByText('FULL THREE')).toBeInTheDocument();
  });

  it('while the first answer about the views is on its way: the wait, neither view', async () => {
    vi.mocked(api.fetchUiPrefs).mockReturnValue(new Promise(() => undefined));
    renderLinks();
    expect(await screen.findByText(t.loading)).toBeInTheDocument();
    expect(wall()).toBeNull();
    expect(screen.queryByText(t.selectEntry)).toBeNull();
  });

  it('deleting the open post from the panel closes it and takes the card off the wall', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(api.deleteEntry).mockResolvedValue(undefined as never);
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('wall'));
    renderLinks();
    await userEvent.click(await screen.findByRole('button', { name: /THIRD POST/ }));
    const panel = await screen.findByRole('complementary', { name: t.detailLabel });
    await within(panel).findByText('FULL THREE');
    await userEvent.click(within(panel).getByTitle(t.deleteEntry));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: t.detailLabel })).toBeNull());
    expect(screen.queryByRole('button', { name: /THIRD POST/ })).toBeNull();
  });

  it('?q= works in the wall too', async () => {
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('wall'));
    renderLinks('/entries?q=films');
    await screen.findByRole('list', { name: t.wallLabel });
    expect(within(wall() as HTMLElement).getAllByRole('listitem')).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole('button', { name: /SECOND POST ABOUT FILMS/ })).toBeInTheDocument());
  });
});
