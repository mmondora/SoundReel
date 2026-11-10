import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VenueList } from './VenueList';
import { LanguageProvider } from '../i18n';
import { translations } from '../i18n/translations';
import type { CollectionVenue } from '../types';

// «Locali» (spec §4.6, Michele: «voglio anche una sezione con i nomi dei ristoranti e un link a googlemap (oppure apri in gmap)»): one row for each
// venue the posts name, with the posts that cite it and «Apri in Maps». The address of Maps is built by the SERVER; the site only opens it.

const t = translations.en;
const venue = (over: Partial<CollectionVenue> = {}): CollectionVenue => ({
  key: 'trattoria dei navigli|milano', name: 'Trattoria dei Navigli', kind: 'ristorante', place: 'Milano',
  mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Trattoria%20dei%20Navigli%2C%20Milano',
  posts: [{ entryId: 'e1', sourceUrl: 'https://instagram.com/reel/a', sourcePlatform: 'instagram', createdAt: '2026-11-01T10:00:00.000Z' }], ...over,
});

const renderVenues = (venues: CollectionVenue[]) => render(<LanguageProvider><VenueList venues={venues} /></LanguageProvider>);

describe('the list of venues', () => {
  it('has no section at all when there are no venues', () => {
    const { container } = renderVenues([]);
    expect(container.firstChild).toBeNull();
  });

  it('is a section «Places» with one row for each venue: the name, what it is and the city', () => {
    renderVenues([venue(), venue({ key: 'bar luce|milano', name: 'Bar Luce', kind: 'bar' })]);
    const section = screen.getByRole('heading', { name: t.collectionVenues }).closest('section') as HTMLElement;
    const rows = within(section).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Trattoria dei Navigli');
    expect(rows[0]).toHaveTextContent('ristorante');
    expect(rows[0]).toHaveTextContent('Milano');
    expect(rows[1]).toHaveTextContent('Bar Luce');
  });

  it('«Open in Maps» is the address the server built, untouched, that opens in a new tab without giving the page away', () => {
    renderVenues([venue()]);
    const link = screen.getByRole('link', { name: `${t.collectionOpenInMaps}: Trattoria dei Navigli` });
    expect(link).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=Trattoria%20dei%20Navigli%2C%20Milano');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent(t.collectionOpenInMaps);
  });

  it('every venue has its own address, whatever the venue (the site builds none)', () => {
    renderVenues([venue(), venue({ key: 'k2', name: 'Osteria dell\'Orto & Co.', place: null, mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Osteria%20dell\'Orto%20%26%20Co.' })]);
    const links = screen.getAllByRole('link', { name: new RegExp(t.collectionOpenInMaps) });
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://www.google.com/maps/search/?api=1&query=Trattoria%20dei%20Navigli%2C%20Milano',
      'https://www.google.com/maps/search/?api=1&query=Osteria%20dell\'Orto%20%26%20Co.',
    ]);
  });

  it('a venue with no city shows no city', () => {
    renderVenues([venue({ place: null })]);
    expect(screen.getByRole('listitem').textContent).not.toMatch(/Milano|null/);
  });

  it('a venue that two posts name is ONE row with the links to both posts', () => {
    renderVenues([venue({ posts: [
      { entryId: 'e1', sourceUrl: 'https://instagram.com/reel/a', sourcePlatform: 'instagram', createdAt: '2026-11-01T10:00:00.000Z' },
      { entryId: 'e2', sourceUrl: 'https://tiktok.com/@x/video/2', sourcePlatform: 'tiktok', createdAt: '2026-11-03T10:00:00.000Z' },
    ] })]);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    const posts = within(screen.getByTestId('post-links')).getAllByRole('link');
    expect(posts.map((a) => a.getAttribute('href'))).toEqual(['https://instagram.com/reel/a', 'https://tiktok.com/@x/video/2']);
  });

  it('two lists on one page (the collection and a post open next to it) do not share an id: each section is named by its own heading', () => {
    render(<LanguageProvider><VenueList venues={[venue()]} /><VenueList venues={[venue({ key: 'bar luce|milano', name: 'Bar Luce' })]} /></LanguageProvider>);
    const headings = screen.getAllByRole('heading', { name: t.collectionVenues });
    expect(headings).toHaveLength(2);
    expect(new Set(headings.map((h) => h.id)).size).toBe(2);
    for (const h of headings) expect(h.closest('section')).toHaveAttribute('aria-labelledby', h.id);
  });

  describe('a long list', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => venue({ key: `v${i}|milano`, name: `Venue ${i + 1}` }));

    it('shows the first five venues and «Show all (N)» for the rest, so the posts are not pushed far down the page', () => {
      renderVenues(many(7));
      expect(screen.getAllByRole('listitem')).toHaveLength(5);
      expect(screen.getByRole('button', { name: t.collectionVenuesShowAll.replace('{count}', '7') })).toBeInTheDocument();
      expect(screen.queryByText('Venue 6')).toBeNull();
    });

    it('«Show all» opens the whole list, and the button goes', async () => {
      renderVenues(many(7));
      await userEvent.click(screen.getByRole('button', { name: t.collectionVenuesShowAll.replace('{count}', '7') }));
      expect(screen.getAllByRole('listitem')).toHaveLength(7);
      expect(screen.getByText('Venue 7')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
    });

    it('five venues are all shown, with no button', () => {
      renderVenues(many(5));
      expect(screen.getAllByRole('listitem')).toHaveLength(5);
      expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
    });
  });

  describe('the kind of venue', () => {
    it('is written in the words of the page: the server sends a key («refuge»), the site says «mountain hut»', () => {
      renderVenues([venue({ kind: 'refuge', place: 'Alba' })]);
      expect(screen.getByRole('listitem').querySelector('.venue-sub')?.textContent).toBe(`${t.venueKindRefuge} · Alba`);
    });

    it('a kind the site does not know (a newer server) is shown as it came, not lost', () => {
      renderVenues([venue({ kind: 'castle', place: null })]);
      expect(screen.getByRole('listitem')).toHaveTextContent('castle');
    });

    it('«other» says nothing about the venue, so it is not written', () => {
      renderVenues([venue({ kind: 'other', place: 'Milano' })]);
      const sub = screen.getByRole('listitem').querySelector('.venue-sub');
      expect(sub?.textContent).toBe('Milano');
    });
  });
});
