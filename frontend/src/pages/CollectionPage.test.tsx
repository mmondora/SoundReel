import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import '@testing-library/jest-dom';
import { CollectionPage } from './CollectionPage';
import { LanguageProvider } from '../i18n';
import * as api from '../services/api';
import { translations } from '../i18n/translations';
import type { AggregatedSong, CollectionListItem, CollectionPage as CollectionAnswer, Entry, EntrySummary } from '../types';

// The page of one collection (spec 2026-11-09-library-collections-auto-topics-design.md §6.3, docs/collections.md): the name and the count, the menu of
// corrections (only a theme can be corrected), «Why is it here?», the facets, the views the SERVER says make sense for this collection (the page draws
// only those), the posts, «Play all» for the music, and the venues with «Open in Maps». The page computes nothing: the server decides everything.

const playerMock = vi.hoisted(() => ({ playSong: vi.fn() }));
vi.mock('../player/PlayerContext', () => ({ usePlayer: () => playerMock }));

vi.mock('../services/api', () => ({
  fetchCollection: vi.fn(),
  fetchCollections: vi.fn(),
  renameCollection: vi.fn(),
  mergeCollection: vi.fn(),
  hideCollection: vi.fn(),
  removeEntryFromCollection: vi.fn(),
  addEntryToCollection: vi.fn(),
  fetchSongs: vi.fn(),
  getEntry: vi.fn(),
  deleteEntry: vi.fn(),
  retryEntry: vi.fn(),
  enrichEntry: vi.fn(),
  fetchMe: vi.fn().mockResolvedValue({ user: 'mike', displayName: 'Mike', isAdmin: false, authenticated: true, family: [] }),
  fetchEntryMedia: vi.fn().mockResolvedValue({ entryId: '', videoUrl: null, audioUrl: null, thumbnailUrl: null, frames: [], slides: [] }),
}));

const t = translations.en;

const col = (over: Partial<CollectionListItem> = {}): CollectionListItem => ({
  id: 'c-wine', name: 'Wine', kind: 'theme', group: 'Food and drink', parentId: null, count: 15, isNew: false, thumbs: [], views: ['grid', 'list'], defaultView: 'grid', ...over,
});
const row = (id: string, summary: string, over: Partial<EntrySummary> = {}): EntrySummary => ({
  id, sourceUrl: `https://instagram.com/reel/${id}`, sourcePlatform: 'instagram', caption: null, thumbnailUrl: null, status: 'completed',
  createdAt: '2026-11-10T10:00:00.000Z', summary, songCount: 0, filmCount: 0, noteCount: 0, tags: [], ...over,
});
const full = (id: string, summary: string): Entry => ({
  id, sourceUrl: `https://instagram.com/reel/${id}`, sourcePlatform: 'instagram', inputChannel: 'web', inputUser: null, caption: null, thumbnailUrl: null,
  mediaUrl: null, status: 'completed', results: { songs: [], films: [], notes: [], links: [], tags: [], summary }, actionLog: [], createdAt: '2026-11-10T10:00:00Z',
});

const POSTS = [
  row('w1', 'A BAROLO FROM THE LANGHE', { collections: [{ id: 'c-wine', name: 'Wine' }, { id: 'place:milano', name: 'Milano' }] }),
  row('w2', 'A CHIANTI FOR THE WEEKEND', { createdAt: '2026-11-09T09:00:00.000Z', collections: [{ id: 'c-wine', name: 'Wine' }] }),
];
const answer = (over: Partial<CollectionAnswer> = {}): CollectionAnswer => ({
  collection: col(), why: { words: ['wine', 'cellar', 'barolo'], entryIds: ['w1'] }, facets: { places: [], sources: [], months: [] },
  entries: POSTS.map((e) => ({ ...e, collections: e.collections ?? [] })), venues: [], total: 2, ...over,
});

function Where() {
  const l = useLocation();
  return <output data-testid="where">{`${l.pathname}${l.search}`}</output>;
}

function renderPage(path = '/collections/c-wine') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LanguageProvider>
        <Routes>
          <Route path="/collections" element={<p>THE LIST OF COLLECTIONS</p>} />
          <Route path="/collections/:id" element={<CollectionPage />} />
        </Routes>
        <Where />
      </LanguageProvider>
    </MemoryRouter>,
  );
}

const wall = () => screen.queryByRole('list', { name: t.wallLabel });
const where = () => screen.getByTestId('where').textContent;
const openMenu = async () => userEvent.click(await screen.findByRole('button', { name: t.collectionMenu }));
const countText = (n: number) => t.collectionPosts.replace('{count}', String(n));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchCollection).mockResolvedValue(answer());
  vi.mocked(api.fetchCollections).mockResolvedValue([col(), col({ id: 'c-casa', name: 'Home and design', count: 10 }), col({ id: 'type:films', name: 'Films', kind: 'type', views: ['grid'], defaultView: 'grid' }), col({ id: 'place:milano', name: 'Milano', kind: 'place' })]);
  vi.mocked(api.getEntry).mockImplementation(async (id: string) => full(id, `FULL ${id.toUpperCase()}`));
  vi.mocked(api.removeEntryFromCollection).mockResolvedValue(undefined);
});

describe('the page of a collection — what it shows', () => {
  it('reads the collection named in the address (decoded), and shows its name, how many posts it holds and «New»', async () => {
    vi.mocked(api.fetchCollection).mockResolvedValue(answer({ collection: col({ id: 'type:music', name: 'Music', kind: 'type', count: 719, isNew: true, views: ['list', 'play'], defaultView: 'play' }) }));
    renderPage('/collections/type%3Amusic');
    expect(await screen.findByRole('heading', { level: 1, name: /Music/ })).toBeInTheDocument();
    expect(api.fetchCollection).toHaveBeenCalledWith('type:music', expect.objectContaining({ offset: 0, limit: 40 }));
    expect(screen.getByText(countText(719))).toBeInTheDocument();
    expect(screen.getByText(t.collectionNew)).toBeInTheDocument();
  });

  it('has a way back to all the collections', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('link', { name: new RegExp(t.collectionsTitle) }));
    expect(where()).toBe('/collections');
  });

  it('draws the posts as a wall when the server says the grid is the default view', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Wine' });
    expect(wall()).not.toBeNull();
    expect(within(wall() as HTMLElement).getAllByRole('button')).toHaveLength(2);
  });

  it('draws the posts as a list when the server says the list is the default view', async () => {
    vi.mocked(api.fetchCollection).mockResolvedValue(answer({ collection: col({ defaultView: 'list' }) }));
    renderPage();
    expect(await screen.findByRole('button', { name: /A BAROLO FROM THE LANGHE/ })).toBeInTheDocument();
    expect(wall()).toBeNull();
  });

  it('says so when no post passes the filters', async () => {
    vi.mocked(api.fetchCollection).mockResolvedValue(answer({ entries: [], total: 0 }));
    renderPage();
    expect(await screen.findByText(t.collectionNoPosts)).toBeInTheDocument();
  });

  it('a post opens on the right and is read by its id', async () => {
    vi.mocked(api.fetchCollection).mockResolvedValue(answer({ collection: col({ defaultView: 'list' }) }));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /A BAROLO FROM THE LANGHE/ }));
    await waitFor(() => expect(api.getEntry).toHaveBeenCalledWith('w1'));
    expect(await screen.findByText('FULL W1')).toBeInTheDocument();
  });
});

describe('the page of a collection — the views', () => {
  it('offers only the views the server named, and the default one is chosen', async () => {
    renderPage();
    const group = await screen.findByRole('group', { name: t.collectionViewLabel });
    expect(within(group).getByRole('radio', { name: t.collectionViewGrid })).toBeChecked();
    expect(within(group).getByRole('radio', { name: t.collectionViewList })).not.toBeChecked();
    expect(within(group).queryByRole('radio', { name: t.collectionViewPlay })).toBeNull();
  });

  it('has no switch at all when the data fills a single view', async () => {
    vi.mocked(api.fetchCollection).mockResolvedValue(answer({ collection: col({ views: ['grid'], defaultView: 'grid' }) }));
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Wine' });
    expect(screen.queryByRole('group', { name: t.collectionViewLabel })).toBeNull();
  });

  it('choosing another view redraws the posts', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Wine' });
    await userEvent.click(screen.getByRole('radio', { name: t.collectionViewList }));
    expect(wall()).toBeNull();
    expect(screen.getByRole('button', { name: /A CHIANTI FOR THE WEEKEND/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: t.collectionViewGrid }));
    expect(wall()).not.toBeNull();
  });
});

describe('the page of a collection — «Play all» (the music)', () => {
  const music = col({ id: 'type:music', name: 'Music', kind: 'type', count: 3, views: ['list', 'play'], defaultView: 'play' });
  const song = (songKey: string, title: string): AggregatedSong => ({ songKey, title, artist: 'A', album: null, youtubeUrl: null, spotifyUrl: null, mentions: [], meta: null });

  beforeEach(() => {
    vi.mocked(api.fetchCollection).mockResolvedValue(answer({ collection: music, songKeys: ['k1', 'zz', 'k2'] }));
    vi.mocked(api.fetchSongs).mockResolvedValue([song('k2', 'Second'), song('k1', 'First'), song('k3', 'Not in the collection')]);
  });

  it('queues the songs in the order the server gave, the first one plays, and the queue is named after the collection', async () => {
    renderPage('/collections/type%3Amusic');
    await userEvent.click(await screen.findByRole('button', { name: t.collectionPlayAll }));
    await waitFor(() => expect(playerMock.playSong).toHaveBeenCalledTimes(1));
    const [first, queue, label] = playerMock.playSong.mock.calls[0] as [string, AggregatedSong[], string];
    expect(first).toBe('k1');
    expect(queue.map((s) => s.songKey)).toEqual(['k1', 'k2']);   // a key the library does not know is skipped; a song the server did not name is not queued
    expect(label).toBe('Music');
  });

  it('while the songs are being read the button says so and cannot be pressed twice', async () => {
    let release: (songs: AggregatedSong[]) => void = () => undefined;
    vi.mocked(api.fetchSongs).mockReturnValue(new Promise((resolve) => { release = resolve; }));
    renderPage('/collections/type%3Amusic');
    await userEvent.click(await screen.findByRole('button', { name: t.collectionPlayAll }));
    const busy = await screen.findByRole('button', { name: t.collectionPlayLoading });
    expect(busy).toBeDisabled();
    release([song('k1', 'First')]);
    await waitFor(() => expect(playerMock.playSong).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: t.collectionPlayAll })).toBeEnabled();
  });

  it('when none of the songs can be found nothing plays and the page says so', async () => {
    vi.mocked(api.fetchSongs).mockResolvedValue([song('other', 'Other')]);
    renderPage('/collections/type%3Amusic');
    await userEvent.click(await screen.findByRole('button', { name: t.collectionPlayAll }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t.collectionActionFailed);
    expect(playerMock.playSong).not.toHaveBeenCalled();
  });

  it('a failure to read the songs says so, and the button is back', async () => {
    vi.mocked(api.fetchSongs).mockRejectedValue(new Error('network down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderPage('/collections/type%3Amusic');
    await userEvent.click(await screen.findByRole('button', { name: t.collectionPlayAll }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t.collectionActionFailed);
    expect(screen.getByRole('button', { name: t.collectionPlayAll })).toBeEnabled();
  });

  it('a collection without the view «play» has no «Play all»', async () => {
    vi.mocked(api.fetchCollection).mockResolvedValue(answer());   // the wine collection: grid and list only
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Wine' });
    expect(screen.queryByRole('button', { name: t.collectionPlayAll })).toBeNull();
  });
});

describe('the page of a collection — the corrections (a theme only)', () => {
  it.each([['type:films', 'type'], ['place:milano', 'place']] as const)('%s (%s) is computed, so it has no menu of corrections', async (id, kind) => {
    vi.mocked(api.fetchCollection).mockResolvedValue(answer({ collection: col({ id, kind, name: 'Computed' }) }));
    renderPage(`/collections/${encodeURIComponent(id)}`);
    await screen.findByRole('heading', { level: 1, name: 'Computed' });
    expect(screen.queryByRole('button', { name: t.collectionMenu })).toBeNull();
  });

  it('Escape closes the menu of corrections, and then the form that a choice opened', async () => {
    renderPage();
    await openMenu();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: t.collectionRename }));
    expect(screen.getByRole('textbox', { name: t.collectionRenameLabel })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: t.collectionRenameLabel })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Wine' })).toBeInTheDocument();
  });

  it('«Cancel» closes the form of the rename without sending anything', async () => {
    renderPage();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: t.collectionRename }));
    await userEvent.click(screen.getByRole('button', { name: t.collectionCancel }));
    expect(screen.queryByRole('textbox', { name: t.collectionRenameLabel })).toBeNull();
    expect(api.renameCollection).not.toHaveBeenCalled();
  });

  it('the rename cannot be saved while the name is empty or the same as it is', async () => {
    renderPage();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: t.collectionRename }));
    const save = screen.getByRole('button', { name: t.collectionRenameSave });
    expect(save).toBeDisabled();                       // it opens with the present name
    await userEvent.clear(screen.getByRole('textbox', { name: t.collectionRenameLabel }));
    expect(save).toBeDisabled();                       // empty
    await userEvent.type(screen.getByRole('textbox', { name: t.collectionRenameLabel }), 'Wines');
    expect(save).toBeEnabled();
  });

  it('renames: the new name is sent, and the page shows the name the server answers with', async () => {
    vi.mocked(api.renameCollection).mockResolvedValue(col({ name: 'Wines of Italy' }));
    renderPage();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: t.collectionRename }));
    const field = screen.getByRole('textbox', { name: t.collectionRenameLabel });
    expect(field).toHaveValue('Wine');
    await userEvent.clear(field);
    await userEvent.type(field, 'Wines of Italy');
    await userEvent.click(screen.getByRole('button', { name: t.collectionRenameSave }));
    expect(api.renameCollection).toHaveBeenCalledWith('c-wine', 'Wines of Italy');
    expect(await screen.findByRole('heading', { level: 1, name: 'Wines of Italy' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: t.collectionRenameLabel })).toBeNull();
  });

  it('a refused rename keeps the old name and says so', async () => {
    vi.mocked(api.renameCollection).mockRejectedValue(new Error('invalid_name'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderPage();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: t.collectionRename }));
    await userEvent.type(screen.getByRole('textbox', { name: t.collectionRenameLabel }), '#@"');
    await userEvent.click(screen.getByRole('button', { name: t.collectionRenameSave }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t.collectionActionFailed);
    expect(screen.getByRole('heading', { level: 1, name: 'Wine' })).toBeInTheDocument();
  });

  it('merges into another theme (not into itself, a type or a place) and goes to the one it merged into', async () => {
    vi.mocked(api.mergeCollection).mockResolvedValue(col({ id: 'c-casa', name: 'Home and design' }));
    renderPage();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: t.collectionMerge }));
    const targets = within(await screen.findByRole('group', { name: t.collectionMergeInto })).getAllByRole('button');
    expect(targets.map((b) => b.textContent)).toEqual(['Home and design']);
    await userEvent.click(targets[0]);
    expect(api.mergeCollection).toHaveBeenCalledWith('c-wine', 'c-casa');
    await waitFor(() => expect(where()).toBe('/collections/c-casa'));
    await waitFor(() => expect(api.fetchCollection).toHaveBeenCalledWith('c-casa', expect.anything()));
  });

  it('with no other theme to merge into, it says so', async () => {
    vi.mocked(api.fetchCollections).mockResolvedValue([col()]);
    renderPage();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: t.collectionMerge }));
    expect(await screen.findByText(t.collectionMergeNone)).toBeInTheDocument();
  });

  it('hides, and goes back to the list of collections', async () => {
    vi.mocked(api.hideCollection).mockResolvedValue(undefined);
    renderPage();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: t.collectionHide }));
    expect(api.hideCollection).toHaveBeenCalledWith('c-wine');
    await waitFor(() => expect(where()).toBe('/collections'));
    expect(screen.getByText('THE LIST OF COLLECTIONS')).toBeInTheDocument();
  });

  it('a refused «hide» stays on the page and says so', async () => {
    vi.mocked(api.hideCollection).mockRejectedValue(new Error('not_editable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderPage();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: t.collectionHide }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t.collectionActionFailed);
    expect(where()).toBe('/collections/c-wine');
  });

  it('«not this one» on a chip takes the post out of this collection: it leaves the list and the count goes down', async () => {
    vi.mocked(api.fetchCollection).mockResolvedValue(answer({ collection: col({ defaultView: 'list' }) }));
    renderPage();
    const one = (await screen.findByRole('button', { name: /A BAROLO FROM THE LANGHE/ })).closest('li') as HTMLElement;
    await userEvent.click(within(one).getByRole('button', { name: t.collectionChipRemove.replace('{name}', 'Wine') }));
    expect(api.removeEntryFromCollection).toHaveBeenCalledWith('c-wine', 'w1');
    await waitFor(() => expect(screen.queryByRole('button', { name: /A BAROLO FROM THE LANGHE/ })).toBeNull());
    expect(screen.getByRole('button', { name: /A CHIANTI FOR THE WEEKEND/ })).toBeInTheDocument();
    expect(screen.getByText(countText(14))).toBeInTheDocument();
  });

  it('the other collections of a post (its place) keep their chip when one is taken out', async () => {
    vi.mocked(api.fetchCollection).mockResolvedValue(answer({ collection: col({ defaultView: 'list' }) }));
    renderPage();
    const one = (await screen.findByRole('button', { name: /A BAROLO FROM THE LANGHE/ })).closest('li') as HTMLElement;
    expect(within(one).getByRole('link', { name: 'Milano' })).toBeInTheDocument();
    expect(within(one).queryByRole('button', { name: t.collectionChipRemove.replace('{name}', 'Milano') })).toBeNull();   // a place is computed: no «×»
  });
});

describe('the page of a collection — «+» (put a post in another theme by hand)', () => {
  beforeEach(() => {
    vi.mocked(api.fetchCollection).mockResolvedValue(answer({ collection: col({ defaultView: 'list' }) }));
    vi.mocked(api.addEntryToCollection).mockResolvedValue(undefined);
  });

  const two = async () => (await screen.findByRole('button', { name: /A CHIANTI FOR THE WEEKEND/ })).closest('li') as HTMLElement;

  it('offers the other themes (not the one the post is in, not a type or a place), and the chip appears when one is chosen', async () => {
    renderPage();
    const row2 = await two();
    await userEvent.click(await within(row2).findByRole('button', { name: t.collectionChipAdd }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Home and design']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Home and design' }));
    expect(api.addEntryToCollection).toHaveBeenCalledWith('c-casa', 'w2');
    expect(await within(row2).findByRole('link', { name: 'Home and design' })).toHaveAttribute('href', '/entries?raccolta=c-casa');
  });

  it('choosing the same theme twice before the server has answered gives one chip, not two', async () => {
    const answers: Array<() => void> = [];
    vi.mocked(api.addEntryToCollection).mockImplementation(() => new Promise<void>((resolve) => { answers.push(resolve); }));
    renderPage();
    const row2 = await two();
    for (let i = 0; i < 2; i += 1) {
      await userEvent.click(await within(row2).findByRole('button', { name: t.collectionChipAdd }));
      await userEvent.click(screen.getByRole('menuitem', { name: 'Home and design' }));
    }
    expect(api.addEntryToCollection).toHaveBeenCalledTimes(2);
    answers.forEach((answerIt) => answerIt());
    await waitFor(() => expect(within(row2).getAllByRole('link', { name: 'Home and design' })).toHaveLength(1));
  });

  it('a refusal of the server says so and leaves the row as it was', async () => {
    vi.mocked(api.addEntryToCollection).mockRejectedValue(new Error('not_editable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderPage();
    const row2 = await two();
    await userEvent.click(await within(row2).findByRole('button', { name: t.collectionChipAdd }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Home and design' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t.collectionActionFailed);
    expect(within(row2).queryByRole('link', { name: 'Home and design' })).toBeNull();
  });
});

describe('the page of a collection — «Why is it here?», the facets, the venues', () => {
  it('«Why is it here?» opens the words that define the collection, and closes again', async () => {
    renderPage();
    const why = await screen.findByRole('button', { name: t.collectionWhy });
    expect(why).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/wine · cellar · barolo/)).toBeNull();
    await userEvent.click(why);
    expect(why).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/wine · cellar · barolo/)).toBeInTheDocument();
    await userEvent.click(why);
    expect(screen.queryByText(/wine · cellar · barolo/)).toBeNull();
  });

  it('«Why is it here?» also shows the most typical posts (read by their id, only when it is opened), and one opens in the panel', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Wine' });
    expect(api.getEntry).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: t.collectionWhy }));
    const typical = (await screen.findByText(t.collectionWhyPosts)).closest('div') as HTMLElement;
    await userEvent.click(await within(typical).findByRole('button', { name: /FULL W1/ }));
    expect(await screen.findByRole('complementary', { name: t.detailLabel })).toBeInTheDocument();
  });

  it('a typical post that cannot be read is left out, the words stay', async () => {
    vi.mocked(api.getEntry).mockRejectedValue(new Error('gone'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: t.collectionWhy }));
    expect(screen.getByText(/wine · cellar · barolo/)).toBeInTheDocument();
    await waitFor(() => expect(api.getEntry).toHaveBeenCalledWith('w1'));
    expect(screen.queryByRole('button', { name: /FULL/ })).toBeNull();
  });

  it('with words but no typical post it says the words and leaves out the title of the posts', async () => {
    vi.mocked(api.fetchCollection).mockResolvedValue(answer({ why: { words: ['wine', 'cellar'], entryIds: [] } }));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: t.collectionWhy }));
    expect(screen.getByText(/wine · cellar/)).toBeInTheDocument();
    expect(screen.queryByText(t.collectionWhyPosts)).toBeNull();
  });

  it('has no «Why is it here?» for a collection that has no words (a type, a place)', async () => {
    vi.mocked(api.fetchCollection).mockResolvedValue(answer({ collection: col({ id: 'type:films', kind: 'type' }), why: { words: [], entryIds: [] } }));
    renderPage('/collections/type%3Afilms');
    await screen.findByRole('heading', { level: 1, name: 'Wine' });
    expect(screen.queryByRole('button', { name: t.collectionWhy })).toBeNull();
  });

  it('a facet narrows the posts (it goes in the address and the collection is read again with it); the same one again clears it', async () => {
    vi.mocked(api.fetchCollection).mockResolvedValue(answer({ facets: { places: [{ name: 'Milano', count: 3 }], sources: [], months: [] } }));
    renderPage();
    const chip = await screen.findByRole('button', { name: /Milano/ });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(chip);
    await waitFor(() => expect(where()).toBe('/collections/c-wine?dove=Milano'));
    await waitFor(() => expect(api.fetchCollection).toHaveBeenLastCalledWith('c-wine', expect.objectContaining({ dove: 'Milano', offset: 0 })));
    await userEvent.click(await screen.findByRole('button', { name: /Milano/ }));
    await waitFor(() => expect(where()).toBe('/collections/c-wine'));
  });

  it('opens on a facet that is in the address', async () => {
    renderPage('/collections/c-wine?fonte=instagram&quando=2026-11');
    await screen.findByRole('heading', { level: 1, name: 'Wine' });
    expect(api.fetchCollection).toHaveBeenCalledWith('c-wine', expect.objectContaining({ fonte: 'instagram', quando: '2026-11', dove: undefined }));
  });

  it('lists the venues the posts name, with «Open in Maps» (the address is the server\'s)', async () => {
    const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=Enoteca%20Rossi%2C%20Milano';
    vi.mocked(api.fetchCollection).mockResolvedValue(answer({ venues: [{ key: 'enoteca rossi|milano', name: 'Enoteca Rossi', kind: 'bar', place: 'Milano', mapsUrl, posts: [] }] }));
    renderPage();
    const link = await screen.findByRole('link', { name: `${t.collectionOpenInMaps}: Enoteca Rossi` });
    expect(link).toHaveAttribute('href', mapsUrl);
  });

  it('the venues are on top of the list too (the list view), not only of the wall', async () => {
    const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=Enoteca%20Rossi%2C%20Milano';
    vi.mocked(api.fetchCollection).mockResolvedValue(answer({ collection: col({ defaultView: 'list' }), venues: [{ key: 'enoteca rossi|milano', name: 'Enoteca Rossi', kind: 'bar', place: 'Milano', mapsUrl, posts: [] }] }));
    renderPage();
    expect(await screen.findByRole('link', { name: `${t.collectionOpenInMaps}: Enoteca Rossi` })).toHaveAttribute('href', mapsUrl);
    expect(wall()).toBeNull();
  });

  it('has no section of venues when the posts name none', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Wine' });
    expect(screen.queryByRole('heading', { name: t.collectionVenues })).toBeNull();
  });
});

describe('the page of a collection — more posts, and when it goes wrong', () => {
  it('«load more» reads the next posts and adds them; it goes when there are no more', async () => {
    const more = [row('w3', 'A BAROLO FROM ALBA'), row('w4', 'A BRUNELLO FROM MONTALCINO')];
    vi.mocked(api.fetchCollection).mockResolvedValueOnce(answer({ collection: col({ defaultView: 'list' }), total: 4 })).mockResolvedValueOnce(answer({ collection: col({ defaultView: 'list' }), entries: more.map((e) => ({ ...e, collections: [] })), total: 4 }));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: t.collectionLoadMore }));
    await waitFor(() => expect(api.fetchCollection).toHaveBeenLastCalledWith('c-wine', expect.objectContaining({ offset: 2, limit: 40 })));
    expect(await screen.findByRole('button', { name: /A BRUNELLO FROM MONTALCINO/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /A BAROLO FROM THE LANGHE/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.collectionLoadMore })).toBeNull();
  });

  it('a failure to read the next posts says so and keeps the posts already on the page', async () => {
    vi.mocked(api.fetchCollection).mockResolvedValueOnce(answer({ collection: col({ defaultView: 'list' }), total: 4 })).mockRejectedValueOnce(new Error('network down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: t.collectionLoadMore }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t.collectionLoadFailed);
    expect(screen.getByRole('button', { name: /A BAROLO FROM THE LANGHE/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.collectionLoadMore })).toBeEnabled();   // and it can be tried again
  });

  it('«load more» is in the grid too', async () => {
    const more = [row('w3', 'A BAROLO FROM ALBA')];
    vi.mocked(api.fetchCollection).mockResolvedValueOnce(answer({ total: 3 })).mockResolvedValueOnce(answer({ entries: more.map((e) => ({ ...e, collections: [] })), total: 3 }));
    renderPage();
    expect(await screen.findByRole('list', { name: t.wallLabel })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: t.collectionLoadMore }));
    await waitFor(() => expect(within(wall() as HTMLElement).getAllByRole('listitem')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: t.collectionLoadMore })).toBeNull();
  });

  it('a collection that does not exist (any more) says so and offers the way back, not a blank page', async () => {
    vi.mocked(api.fetchCollection).mockRejectedValue(new Error('collection_not_found'));
    renderPage('/collections/gone');
    expect(await screen.findByText(t.collectionGone)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: t.collectionGoneBack }));
    expect(where()).toBe('/collections');
  });

  it('a failure to read it says so, and «Retry» reads it again', async () => {
    vi.mocked(api.fetchCollection).mockRejectedValueOnce(new Error('network down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(t.collectionLoadFailed);
    await userEvent.click(screen.getByRole('button', { name: t.libRetry }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Wine' })).toBeInTheDocument();
  });
});
