import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { EntriesPage } from './EntriesPage';
import { LanguageProvider } from '../i18n';
import { UiPrefsProvider } from '../hooks/useUiPrefs';
import * as api from '../services/api';
import { translations } from '../i18n/translations';
import type { CollectionListItem, CollectionPage, Entry, EntrySummary, LinksView, UiPrefs } from '../types';

// Look and feel P3: the Link page (all the posts) has two views, chosen by the user and kept on the server: Studio (list on the left, the
// post on the right, the default) and Bacheca (a wall of cards and a panel that closes). It has no Home view. It lists summaries, so the post
// that is opened is read by its id.

vi.mock('../services/api', () => ({
  listEntrySummaries: vi.fn(),
  fetchCollections: vi.fn(),
  fetchCollection: vi.fn(),
  removeEntryFromCollection: vi.fn(),
  addEntryToCollection: vi.fn(),
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

function Where() {
  const l = useLocation();
  return <output data-testid="where">{`${l.pathname}${l.search}`}</output>;
}

function renderLinks(path = '/entries') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LanguageProvider><UiPrefsProvider><EntriesPage /><Where /></UiPrefsProvider></LanguageProvider>
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
  vi.mocked(api.fetchCollections).mockResolvedValue([]);
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

  it('«load more» is in the wall too', async () => {
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('wall'));
    vi.mocked(api.listEntrySummaries).mockResolvedValueOnce(page([ROWS[0]], 2));
    renderLinks();
    await screen.findByRole('list', { name: t.wallLabel });
    vi.mocked(api.listEntrySummaries).mockResolvedValueOnce(page([ROWS[1]], 2, 1));
    await userEvent.click(screen.getByRole('button', { name: t.loadMoreEntries }));
    await waitFor(() => expect(within(wall() as HTMLElement).getAllByRole('listitem')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: t.loadMoreEntries })).toBeNull();
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


// ---- the collections (docs/collections.md, plan Task 9): the rail on top, and `?raccolta=` changes the SOURCE of the posts, in both views

const col = (id: string, name: string, count: number, over: Partial<CollectionListItem> = {}): CollectionListItem => ({
  id, name, kind: 'theme', group: null, parentId: null, count, isNew: false, thumbs: [], views: ['grid', 'list'], defaultView: 'grid', ...over,
});
const COLLECTIONS = [col('type:music', 'Musica', 719, { kind: 'type' }), col('vino', 'Vino', 15, { isNew: true }), col('casa', 'Casa e design', 10)];
const collectionPage = (collection: CollectionListItem, entries: EntrySummary[], over: Partial<CollectionPage> = {}): CollectionPage => ({
  collection, why: { words: [], entryIds: [] }, facets: { places: [], sources: [], months: [] }, venues: [], total: entries.length,
  entries: entries.map((e) => ({ ...e, collections: e.collections ?? [] })), ...over,
});
const WINE = [row('w1', 'ABOUT A BAROLO'), row('w2', 'ABOUT A CHIANTI', { createdAt: '2026-11-09T09:00:00.000Z' })];

describe('Link page — the chips of the collections on the rows', () => {
  const CHIPPED = row('chip', 'POST WITH CHIPS', { collections: [{ id: 'vino', name: 'Vino' }, { id: 'place:milano', name: 'Milano' }], tags: ['#tag', '#barolo', '@utente'] });

  beforeEach(() => {
    vi.mocked(api.listEntrySummaries).mockResolvedValue(page([CHIPPED, row('plain', 'POST WITHOUT CHIPS')]));
    vi.mocked(api.removeEntryFromCollection).mockResolvedValue(undefined);
  });

  it('a row shows its collections first and then its real tags; the placeholders of the model are not shown', async () => {
    renderLinks();
    const row1 = (await screen.findByRole('button', { name: /POST WITH CHIPS/ })).closest('li') as HTMLElement;
    const chips = within(row1).getByRole('group', { name: t.collectionChipsLabel });
    expect(chips.textContent).toBe('Vino×Milano#barolo');
    expect(within(chips).getByRole('link', { name: 'Vino' })).toHaveAttribute('href', '/entries?raccolta=vino');
  });

  it('the × of a theme chip is «not this one»: it asks the server, and the chip goes from the row', async () => {
    renderLinks();
    const row1 = (await screen.findByRole('button', { name: /POST WITH CHIPS/ })).closest('li') as HTMLElement;
    await userEvent.click(within(row1).getByRole('button', { name: t.collectionChipRemove.replace('{name}', 'Vino') }));
    expect(api.removeEntryFromCollection).toHaveBeenCalledWith('vino', 'chip');
    await waitFor(() => expect(within(row1).queryByRole('link', { name: 'Vino' })).toBeNull());
    expect(within(row1).getByRole('link', { name: 'Milano' })).toBeInTheDocument();           // the place stays: it is computed, it has no ×
  });

  it('the counts of the rail are read again after a «not this one» (the number of the collection changed)', async () => {
    vi.mocked(api.fetchCollections).mockResolvedValue([col('vino', 'Vino', 15)]);
    renderLinks();
    const one = (await screen.findByRole('button', { name: /POST WITH CHIPS/ })).closest('li') as HTMLElement;
    expect(api.fetchCollections).toHaveBeenCalledTimes(1);
    await userEvent.click(within(one).getByRole('button', { name: t.collectionChipRemove.replace('{name}', 'Vino') }));
    await waitFor(() => expect(api.fetchCollections).toHaveBeenCalledTimes(2));
  });

  it('the post that is open leaves with its collection: the panel closes, it does not keep showing a post that is no longer in the list', async () => {
    vi.mocked(api.fetchCollections).mockResolvedValue([col('vino', 'Vino', 2)]);
    vi.mocked(api.fetchCollection).mockResolvedValue(collectionPage(col('vino', 'Vino', 2), [CHIPPED, row('plain', 'POST WITHOUT CHIPS')], { total: 2 }));
    renderLinks('/entries?raccolta=vino');
    const one = (await screen.findByRole('button', { name: /POST WITH CHIPS/ })).closest('li') as HTMLElement;
    await userEvent.click(within(one).getByRole('button', { name: /POST WITH CHIPS/ }));
    expect(await screen.findByText('FULL CHIP')).toBeInTheDocument();
    await userEvent.click(within(one).getByRole('button', { name: t.collectionChipRemove.replace('{name}', 'Vino') }));
    await waitFor(() => expect(screen.queryByText('FULL CHIP')).toBeNull());
    expect(screen.getByText(t.selectEntry)).toBeInTheDocument();
  });

  it('inside that collection, taking a post out takes it off the list and lowers the count', async () => {
    vi.mocked(api.fetchCollections).mockResolvedValue([col('vino', 'Vino', 2)]);
    vi.mocked(api.fetchCollection).mockResolvedValue(collectionPage(col('vino', 'Vino', 2), [CHIPPED, row('plain', 'POST WITHOUT CHIPS')], { total: 2 }));
    renderLinks('/entries?raccolta=vino');
    const row1 = (await screen.findByRole('button', { name: /POST WITH CHIPS/ })).closest('li') as HTMLElement;
    await userEvent.click(within(row1).getByRole('button', { name: t.collectionChipRemove.replace('{name}', 'Vino') }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /POST WITH CHIPS/ })).toBeNull());
    expect(screen.getByRole('button', { name: /POST WITHOUT CHIPS/ })).toBeInTheDocument();
    expect(screen.getByText(t.entriesCountLabel.replace('{shown}', '1').replace('{total}', '1'))).toBeInTheDocument();
  });

  it('a refusal of the server leaves the chip where it is', async () => {
    vi.mocked(api.removeEntryFromCollection).mockRejectedValue(new Error('{"error":"not_editable"}'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderLinks();
    const row1 = (await screen.findByRole('button', { name: /POST WITH CHIPS/ })).closest('li') as HTMLElement;
    await userEvent.click(within(row1).getByRole('button', { name: t.collectionChipRemove.replace('{name}', 'Vino') }));
    await waitFor(() => expect(api.removeEntryFromCollection).toHaveBeenCalled());
    expect(within(row1).getByRole('link', { name: 'Vino' })).toBeInTheDocument();
    expect(await screen.findByText(t.collectionChipRemoveFailed)).toBeInTheDocument();
  });

  it('a post with no chips and only placeholder tags shows no chips at all', async () => {
    vi.mocked(api.listEntrySummaries).mockResolvedValue(page([row('only', 'ONLY PLACEHOLDERS', { tags: ['#tag', '@utente', '#hashtag'] })]));
    renderLinks();
    const row1 = (await screen.findByRole('button', { name: /ONLY PLACEHOLDERS/ })).closest('li') as HTMLElement;
    expect(within(row1).queryByRole('group', { name: t.collectionChipsLabel })).toBeNull();
  });
});

describe('Link page — «add to a collection» on the rows', () => {
  const PLAIN = row('plain', 'POST WITHOUT CHIPS');
  const CHIPPED = row('chip', 'POST WITH CHIPS', { collections: [{ id: 'vino', name: 'Vino' }] });

  beforeEach(() => {
    vi.mocked(api.listEntrySummaries).mockResolvedValue(page([CHIPPED, PLAIN]));
    vi.mocked(api.fetchCollections).mockResolvedValue([col('type:music', 'Musica', 719, { kind: 'type' }), col('vino', 'Vino', 15), col('casa', 'Casa e design', 10), col('place:milano', 'Milano', 9, { kind: 'place' })]);
    vi.mocked(api.addEntryToCollection).mockResolvedValue(undefined);
  });

  const rowOf = async (text: RegExp) => (await screen.findByRole('button', { name: text })).closest('li') as HTMLElement;

  it('offers only the themes the post is not in yet (a type or a place cannot be put by hand)', async () => {
    renderLinks();
    const one = await rowOf(/POST WITH CHIPS/);
    await userEvent.click(await within(one).findByRole('button', { name: t.collectionChipAdd }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Casa e design']);
  });

  it('a post with no chips gets a «+» too, and it offers every theme', async () => {
    renderLinks();
    const plain = await rowOf(/POST WITHOUT CHIPS/);
    await userEvent.click(await within(plain).findByRole('button', { name: t.collectionChipAdd }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Vino', 'Casa e design']);
  });

  it('choosing a theme asks the server, and the chip appears on the row', async () => {
    renderLinks();
    const plain = await rowOf(/POST WITHOUT CHIPS/);
    await userEvent.click(await within(plain).findByRole('button', { name: t.collectionChipAdd }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Casa e design' }));
    expect(api.addEntryToCollection).toHaveBeenCalledWith('casa', 'plain');
    expect(await within(plain).findByRole('link', { name: 'Casa e design' })).toHaveAttribute('href', '/entries?raccolta=casa');
  });

  it('the counts of the rail are read again after a correction (the number of the collection changes)', async () => {
    renderLinks();
    const plain = await rowOf(/POST WITHOUT CHIPS/);
    expect(api.fetchCollections).toHaveBeenCalledTimes(1);
    await userEvent.click(await within(plain).findByRole('button', { name: t.collectionChipAdd }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Casa e design' }));
    await waitFor(() => expect(api.fetchCollections).toHaveBeenCalledTimes(2));
  });

  it('a refusal of the server leaves the row as it was and says so', async () => {
    vi.mocked(api.addEntryToCollection).mockRejectedValue(new Error('not_editable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderLinks();
    const plain = await rowOf(/POST WITHOUT CHIPS/);
    await userEvent.click(await within(plain).findByRole('button', { name: t.collectionChipAdd }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Vino' }));
    expect(await screen.findByText(t.collectionChipAddFailed)).toBeInTheDocument();
    expect(within(plain).queryByRole('link', { name: 'Vino' })).toBeNull();
  });

  it('with no collections (a failure, or none found yet) there is no «+»: the page is as it always was', async () => {
    vi.mocked(api.fetchCollections).mockResolvedValue([]);
    renderLinks();
    await rowOf(/POST WITHOUT CHIPS/);
    expect(screen.queryByRole('button', { name: t.collectionChipAdd })).toBeNull();
  });
});

describe('Link page — the rail of collections', () => {
  beforeEach(() => {
    vi.mocked(api.fetchCollections).mockResolvedValue(COLLECTIONS);
    vi.mocked(api.fetchCollection).mockImplementation(async (id) => collectionPage(COLLECTIONS.find((c) => c.id === id) ?? COLLECTIONS[1], WINE));
  });

  it('shows the collections the server sent, in its order, with their counts, above the posts', async () => {
    renderLinks();
    const rail = await screen.findByRole('group', { name: t.collectionsRailLabel });
    expect(within(rail).getAllByRole('button').map((b) => b.textContent)).toEqual([`${t.collectionsAll}3`, 'Musica719', `Vino${t.collectionNew}15`, 'Casa e design10']);
    expect(await screen.findByRole('button', { name: /FIRST POST ABOUT JAZZ/ })).toBeInTheDocument();
  });

  it('with no collections there is no rail and the page is as it was', async () => {
    vi.mocked(api.fetchCollections).mockResolvedValue([]);
    renderLinks();
    await screen.findByRole('button', { name: /FIRST POST ABOUT JAZZ/ });
    expect(screen.queryByRole('group', { name: t.collectionsRailLabel })).toBeNull();
  });

  it('a rail that cannot be loaded does not break the page', async () => {
    vi.mocked(api.fetchCollections).mockRejectedValue(new Error('down'));
    renderLinks();
    expect(await screen.findByRole('button', { name: /FIRST POST ABOUT JAZZ/ })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: t.collectionsRailLabel })).toBeNull();
  });

  it('a tap on a chip puts it in the address (so it can be shared and «back» works) and shows the posts of that collection', async () => {
    renderLinks();
    await userEvent.click(await screen.findByRole('button', { name: /^Vino/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/entries?raccolta=vino');
    expect(await screen.findByRole('button', { name: /ABOUT A BAROLO/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /FIRST POST ABOUT JAZZ/ })).toBeNull();
    expect(api.fetchCollection).toHaveBeenLastCalledWith('vino', { dove: undefined, fonte: undefined, quando: undefined, offset: 0, limit: 40 });
    expect(screen.getByRole('button', { name: /^Vino/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a link with ?raccolta= opens on that collection', async () => {
    renderLinks('/entries?raccolta=vino');
    expect(await screen.findByRole('button', { name: /ABOUT A BAROLO/ })).toBeInTheDocument();
    expect(api.listEntrySummaries).not.toHaveBeenCalled();
  });

  it('a tap on the chosen chip, or on «All», clears it and the posts are all of them again', async () => {
    renderLinks('/entries?raccolta=vino');
    await screen.findByRole('button', { name: /ABOUT A BAROLO/ });
    await userEvent.click(screen.getByRole('button', { name: /^Vino/ }));
    expect(screen.getByTestId('where').textContent).not.toContain('raccolta');
    expect(await screen.findByRole('button', { name: /FIRST POST ABOUT JAZZ/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Casa/ }));
    await screen.findByRole('button', { name: /ABOUT A BAROLO/ });
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`^${t.collectionsAll}`) }));
    expect(screen.getByTestId('where').textContent).not.toContain('raccolta');
  });

  it('the facets «Where / Source / When» appear when a collection is chosen, and a tap on one narrows the posts and the address', async () => {
    vi.mocked(api.fetchCollection).mockResolvedValue(collectionPage(COLLECTIONS[1], WINE, {
      facets: { places: [{ name: 'Milano', count: 5 }, { name: 'Torino', count: 2 }], sources: [{ platform: 'instagram', count: 6 }], months: [{ month: '2026-10', count: 4 }] },
    }));
    renderLinks('/entries?raccolta=vino');
    const where = await screen.findByRole('group', { name: t.collectionsFacetWhere });
    expect(within(where).getAllByRole('button').map((b) => b.textContent)).toEqual(['Milano5', 'Torino2']);
    expect(screen.getByRole('group', { name: t.collectionsFacetSource })).toHaveTextContent('IG');
    expect(screen.getByRole('group', { name: t.collectionsFacetWhen })).toHaveTextContent('Oct 2026');
    await userEvent.click(within(where).getByRole('button', { name: /Milano/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('dove=Milano');
    await waitFor(() => expect(api.fetchCollection).toHaveBeenLastCalledWith('vino', { dove: 'Milano', fonte: undefined, quando: undefined, offset: 0, limit: 40 }));
    await userEvent.click(within(await screen.findByRole('group', { name: t.collectionsFacetWhere })).getByRole('button', { name: /Milano/ }));
    expect(screen.getByTestId('where').textContent).not.toContain('dove');           // the chosen facet is cleared by a second tap
  });

  it('with no collection chosen there are no facets', async () => {
    renderLinks();
    await screen.findByRole('button', { name: /FIRST POST ABOUT JAZZ/ });
    expect(screen.queryByRole('group', { name: t.collectionsFacetWhere })).toBeNull();
  });

  it('changing the collection drops the facets of the old one (a place of Vino is not a place of Casa)', async () => {
    renderLinks('/entries?raccolta=vino&dove=Milano');
    await screen.findByRole('button', { name: /ABOUT A BAROLO/ });
    await userEvent.click(screen.getByRole('button', { name: /^Casa/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/entries?raccolta=casa');
    expect(screen.getByTestId('where').textContent).not.toContain('dove');
  });

  it('a collection that is gone says so, with a way back to all the posts', async () => {
    vi.mocked(api.fetchCollection).mockRejectedValue(new Error('{"error":"collection_not_found"}'));
    renderLinks('/entries?raccolta=old');
    expect(await screen.findByText(t.collectionGone)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: t.collectionGoneBack }));
    expect(screen.getByTestId('where').textContent).not.toContain('raccolta');
    expect(await screen.findByRole('button', { name: /FIRST POST ABOUT JAZZ/ })).toBeInTheDocument();
  });

  it('the text filter of the page keeps working inside a collection', async () => {
    renderLinks('/entries?raccolta=vino&q=chianti');
    await screen.findByRole('button', { name: /ABOUT A CHIANTI/ });
    expect(screen.queryByRole('button', { name: /ABOUT A BAROLO/ })).toBeNull();
  });

  it('«load more» inside a collection asks the collection for the next page', async () => {
    vi.mocked(api.fetchCollection).mockResolvedValueOnce(collectionPage(COLLECTIONS[1], [WINE[0]], { total: 2 })).mockResolvedValueOnce(collectionPage(COLLECTIONS[1], [WINE[1]], { total: 2 }));
    renderLinks('/entries?raccolta=vino');
    await screen.findByRole('button', { name: /ABOUT A BAROLO/ });
    await userEvent.click(screen.getByRole('button', { name: t.loadMoreEntries }));
    await screen.findByRole('button', { name: /ABOUT A CHIANTI/ });
    expect(api.fetchCollection).toHaveBeenLastCalledWith('vino', { dove: undefined, fonte: undefined, quando: undefined, offset: 1, limit: 40 });
  });

  it('the count says how many posts the collection has, not how many there are in all', async () => {
    vi.mocked(api.fetchCollection).mockResolvedValue(collectionPage(COLLECTIONS[1], WINE, { total: 15 }));
    renderLinks('/entries?raccolta=vino');
    expect(await screen.findByText(t.entriesCountLabel.replace('{shown}', '2').replace('{total}', '15'))).toBeInTheDocument();
  });

  it('works in the wall too: a saved wall draws the posts of the collection as cards', async () => {
    vi.mocked(api.fetchUiPrefs).mockResolvedValue(prefsWith('wall'));
    renderLinks('/entries?raccolta=vino');
    await screen.findByRole('list', { name: t.wallLabel });
    expect(within(wall() as HTMLElement).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /ABOUT A BAROLO/ })).toBeInTheDocument();
  });

  it('a late answer for the collection that was chosen before does not replace the one chosen now', async () => {
    let late!: (p: CollectionPage) => void;
    vi.mocked(api.fetchCollection)
      .mockReturnValueOnce(new Promise<CollectionPage>((resolve) => { late = resolve; }))
      .mockResolvedValueOnce(collectionPage(COLLECTIONS[2], [row('h1', 'ABOUT A HOUSE')]));
    renderLinks('/entries?raccolta=vino');
    await userEvent.click(await screen.findByRole('button', { name: /^Casa/ }));
    await screen.findByRole('button', { name: /ABOUT A HOUSE/ });
    await act(async () => { late(collectionPage(COLLECTIONS[1], WINE)); });
    expect(screen.queryByRole('button', { name: /ABOUT A BAROLO/ })).toBeNull();
    expect(screen.getByRole('button', { name: /ABOUT A HOUSE/ })).toBeInTheDocument();
  });
});
