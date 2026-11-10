import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CollectionsPage } from './CollectionsPage';
import { LanguageProvider } from '../i18n';
import { translations } from '../i18n/translations';
import * as api from '../services/api';
import type { CollectionListItem } from '../types';

// The page «Raccolte» (spec §6.2 B): cards with a 2×2 mosaic of pictures, grouped by the heading the SERVER sent, a strip of the new ones, a field that
// filters, and at the bottom the hidden ones (to bring them back). The page draws; it decides no heading and no order.

vi.mock('../services/api', () => ({
  fetchCollections: vi.fn(),
  unhideCollection: vi.fn(),
  fetchMe: vi.fn(),
}));

const t = translations.en;
const col = (id: string, name: string, count: number, over: Partial<CollectionListItem> = {}): CollectionListItem => ({
  id, name, kind: 'theme', group: null, parentId: null, count, isNew: false, thumbs: [], views: ['grid', 'list'], defaultView: 'grid', ...over,
});

const LIST: CollectionListItem[] = [
  col('type:music', 'Musica', 719, { kind: 'type', group: 'Tipi', views: ['grid', 'list', 'play'], defaultView: 'play', thumbs: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'] }),
  col('vino', 'Vino', 15, { group: 'Cibo e bevande', isNew: true, thumbs: ['v1.jpg'] }),
  col('rist', 'Ristoranti', 7, { group: 'Cibo e bevande', thumbs: ['r1.jpg', 'r2.jpg', 'r3.jpg', 'r4.jpg'] }),
  col('casa', 'Casa e design', 10, { group: 'Casa' }),
  col('misc', 'Caffè d\'autore', 5),
];

const fetchAll = vi.mocked(api.fetchCollections);

function renderPage() {
  return render(<LanguageProvider><MemoryRouter><CollectionsPage /></MemoryRouter></LanguageProvider>);
}

const headings = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  fetchAll.mockImplementation(async (state) => (state === 'hidden' ? [col('old', 'Moto', 6, { group: 'Tecnologia' })] : state === 'watching' ? [col('w', 'In forse', 4)] : LIST));
  vi.mocked(api.fetchMe).mockResolvedValue({ user: 'mike', displayName: 'Mike', isAdmin: false, authenticated: true, family: [] });
});

describe('the page «Raccolte»', () => {
  it('groups the cards under the headings the server sent, in the order they first appear, and «Other» (no heading) last', async () => {
    renderPage();
    await screen.findByRole('link', { name: /Casa e design/ });
    expect(headings()).toEqual([t.collectionsNewStrip, 'Tipi', 'Cibo e bevande', 'Casa', t.collectionsOther]);
  });

  it('the strip «New» holds only the new ones', async () => {
    renderPage();
    const strip = (await screen.findByRole('heading', { level: 2, name: t.collectionsNewStrip })).closest('section') as HTMLElement;
    expect(within(strip).getAllByRole('link')).toHaveLength(1);
    expect(within(strip).getByRole('link', { name: /Vino/ })).toBeInTheDocument();
  });

  it('with nothing new there is no strip', async () => {
    fetchAll.mockResolvedValue(LIST.map((c) => ({ ...c, isNew: false })));
    renderPage();
    await screen.findByRole('link', { name: /Casa e design/ });
    expect(screen.queryByRole('heading', { level: 2, name: t.collectionsNewStrip })).toBeNull();
  });

  it('a card is a link to the collection (the id of a type, with its colon, is encoded), with the name, the number of posts and «New»', async () => {
    renderPage();
    const music = await screen.findByRole('link', { name: /Musica/ });
    expect(music).toHaveAttribute('href', '/collections/type%3Amusic');
    expect(music).toHaveTextContent(t.collectionPosts.replace('{count}', '719'));
    const section = screen.getByRole('heading', { level: 2, name: 'Cibo e bevande' }).closest('section') as HTMLElement;
    const wine = within(section).getByRole('link', { name: /Vino/ });
    expect(wine).toHaveAttribute('href', '/collections/vino');
    expect(wine).toHaveTextContent(t.collectionNew);
  });

  it('the mosaic is four tiles when there is any picture (neutral tiles for the rest); with none at all it is the first letter of the name', async () => {
    renderPage();
    const section = (await screen.findByRole('heading', { level: 2, name: 'Cibo e bevande' })).closest('section') as HTMLElement;
    const wine = within(section).getByRole('link', { name: /Vino/ });
    expect(wine.querySelectorAll('.collection-tile')).toHaveLength(4);
    expect(wine.querySelectorAll('.collection-tile img')).toHaveLength(1);
    const casa = within(screen.getByRole('heading', { level: 2, name: 'Casa' }).closest('section') as HTMLElement).getByRole('link', { name: /Casa/ });
    expect(casa.querySelectorAll('.collection-tile')).toHaveLength(0);
    expect(casa.querySelector('.collection-mosaic.is-empty')?.textContent).toBe('C');
  });

  it('the field filters the cards by name, without caring for case or accents', async () => {
    renderPage();
    await screen.findByRole('link', { name: /Casa e design/ });
    await userEvent.type(screen.getByRole('searchbox', { name: t.collectionsFilter }), 'CAFFE');
    expect(screen.getByRole('link', { name: /Caffè d'autore/ })).toBeInTheDocument();
    expect(screen.queryAllByRole('link', { name: /Vino/ })).toHaveLength(0);
    expect(screen.queryByRole('heading', { level: 2, name: 'Cibo e bevande' })).toBeNull();     // a heading with no card is not drawn
  });

  it('a filter that matches nothing says so', async () => {
    renderPage();
    await screen.findByRole('link', { name: /Casa e design/ });
    await userEvent.type(screen.getByRole('searchbox', { name: t.collectionsFilter }), 'zzz');
    expect(screen.getByText(t.collectionsNoMatch)).toBeInTheDocument();
  });

  it('no collections yet: it says so and how they appear', async () => {
    fetchAll.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(t.collectionsEmpty)).toBeInTheDocument();
    expect(screen.getByText(t.collectionsEmptyHint)).toBeInTheDocument();
  });

  it('a list that cannot be loaded says so and can be asked again', async () => {
    fetchAll.mockRejectedValueOnce(new Error('down')).mockResolvedValue(LIST);
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(t.collectionsLoadFailed);
    await userEvent.click(screen.getByRole('button', { name: t.libRetry }));
    expect(await screen.findByRole('link', { name: /Casa e design/ })).toBeInTheDocument();
  });
});

describe('the hidden ones and the ones under observation', () => {
  it('«Hidden» is closed and asks nothing until it is opened; then it lists them with a way to bring them back', async () => {
    renderPage();
    await screen.findByRole('link', { name: /Casa e design/ });
    expect(fetchAll).not.toHaveBeenCalledWith('hidden');
    await userEvent.click(screen.getByText(t.collectionsHidden));
    expect(await screen.findByText('Moto')).toBeInTheDocument();
    expect(fetchAll).toHaveBeenCalledWith('hidden');
  });

  it('bringing one back asks the server, then the page lists it again', async () => {
    vi.mocked(api.unhideCollection).mockResolvedValue(undefined);
    renderPage();
    await screen.findByRole('link', { name: /Casa e design/ });
    await userEvent.click(screen.getByText(t.collectionsHidden));
    await userEvent.click(await screen.findByRole('button', { name: new RegExp(`${t.collectionUnhide}.*Moto|Moto.*${t.collectionUnhide}`) }));
    expect(api.unhideCollection).toHaveBeenCalledWith('old');
    await waitFor(() => expect(fetchAll.mock.calls.filter(([s]) => s === 'active' || s === undefined).length).toBeGreaterThanOrEqual(2));
  });

  it('«Under observation» is for an administrator only', async () => {
    renderPage();
    await screen.findByRole('link', { name: /Casa e design/ });
    expect(screen.queryByText(t.collectionsWatching)).toBeNull();
    expect(fetchAll).not.toHaveBeenCalledWith('watching');
  });

  it('an administrator sees it, closed, and it asks only when opened', async () => {
    vi.mocked(api.fetchMe).mockResolvedValue({ user: 'mike', displayName: 'Mike', isAdmin: true, authenticated: true, family: [] });
    renderPage();
    const summary = await screen.findByText(t.collectionsWatching);
    expect(fetchAll).not.toHaveBeenCalledWith('watching');
    await userEvent.click(summary);
    expect(await screen.findByText('In forse')).toBeInTheDocument();
  });
});
