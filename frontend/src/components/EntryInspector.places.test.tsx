import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EntryInspector } from './EntryInspector';
import { LanguageProvider } from '../i18n';
import { translations } from '../i18n/translations';
import * as api from '../services/api';
import type { CollectionVenue, Entry } from '../types';

// The post in full: where it is (the places the server found in the text) and the venues it names, each with «Apri in Maps» (the address is built by
// the SERVER, spec 2026-11-09-library-collections-auto-topics-design.md §4.6); and the tags without the placeholders of the model (§6.5).

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  fetchEntryMedia: vi.fn(),
  fetchMe: vi.fn(),
  fetchEntryShares: vi.fn(),
}));

const t = translations.en;

const venue: CollectionVenue = {
  key: 'trattoria dei navigli|milano', name: 'Trattoria dei Navigli', kind: 'ristorante', place: 'Milano',
  mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Trattoria%20dei%20Navigli%2C%20Milano',
  posts: [{ entryId: 'e1', sourceUrl: 'https://instagram.com/reel/e1', sourcePlatform: 'instagram', createdAt: '2026-11-10T10:00:00.000Z' }],
};

const entry = (over: Partial<Entry> = {}, tags: string[] = []): Entry => ({
  id: 'e1', sourceUrl: 'https://instagram.com/reel/e1', sourcePlatform: 'instagram', inputChannel: 'web', inputUser: null, caption: null,
  thumbnailUrl: null, mediaUrl: null, status: 'completed', actionLog: [], createdAt: '2026-11-10T10:00:00Z',
  results: { songs: [], films: [], notes: [], links: [], tags, summary: 'A POST ABOUT MILAN' }, ...over,
});

const renderInspector = (e: Entry) => render(
  <MemoryRouter><LanguageProvider><EntryInspector entry={e} /></LanguageProvider></MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchEntryMedia).mockResolvedValue({ entryId: 'e1', videoUrl: null, audioUrl: null, thumbnailUrl: null, frames: [], slides: [] });
  vi.mocked(api.fetchMe).mockResolvedValue({ authenticated: false } as Awaited<ReturnType<typeof api.fetchMe>>);
  vi.mocked(api.fetchEntryShares).mockResolvedValue({ entryId: 'e1', sharedWith: [], family: [] });
});

describe('the post in full — places and venues', () => {
  it('names the places the server found in the text', async () => {
    renderInspector(entry({ places: [{ name: 'Milano', kind: 'city' }, { name: 'Lombardia', kind: 'region' }] }));
    const section = (await screen.findByRole('heading', { name: t.entryPlaces })).closest('section') as HTMLElement;
    expect(within(section).getByText('Milano')).toBeInTheDocument();
    expect(within(section).getByText('Lombardia')).toBeInTheDocument();
  });

  it('has no section of places when the server found none', async () => {
    renderInspector(entry({ places: [] }));
    await screen.findByText('A POST ABOUT MILAN');
    expect(screen.queryByRole('heading', { name: t.entryPlaces })).toBeNull();
  });

  it('an older server that sends neither places nor venues: the post is as it always was', async () => {
    renderInspector(entry());
    await screen.findByText('A POST ABOUT MILAN');
    expect(screen.queryByRole('heading', { name: t.entryPlaces })).toBeNull();
    expect(screen.queryByRole('heading', { name: t.collectionVenues })).toBeNull();
  });

  it('lists the venues with «Open in Maps», the address of the server untouched', async () => {
    renderInspector(entry({ venues: [venue] }));
    const link = await screen.findByRole('link', { name: `${t.collectionOpenInMaps}: Trattoria dei Navigli` });
    expect(link).toHaveAttribute('href', venue.mapsUrl);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});

describe('the post in full — its tags', () => {
  it('does not show the placeholders of the model, shows the real tags', async () => {
    const { container } = renderInspector(entry({}, ['#tag', '@utente', '#hashtag', '#barolo']));
    await screen.findByText('A POST ABOUT MILAN');
    expect(Array.from(container.querySelectorAll('.tag-badge')).map((n) => n.textContent)).toEqual(['#barolo']);
  });

  it('has no row of tags when only placeholders are left', async () => {
    const { container } = renderInspector(entry({}, ['#tag', '@utente']));
    await screen.findByText('A POST ABOUT MILAN');
    expect(container.querySelector('.inspector-tags')).toBeNull();
  });
});
