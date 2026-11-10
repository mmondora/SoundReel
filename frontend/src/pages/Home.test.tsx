import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Home } from './Home';
import { LanguageProvider } from '../i18n';
import { useInbox } from '../hooks/useInbox';
import * as api from '../services/api';
import { translations } from '../i18n/translations';
import type { Entry, EntrySummary } from '../types';

// Regression test for the Telegram "🔗 Vedi entry" deep link
// (https://soundreel.casamon.dev/?entry=<uuid>): the entry it points to may
// not be on the page of the list that is shown, so Home reads it by its id
// (the list holds summaries, so even a post that is on the page is read so).

vi.mock('../hooks/useInbox', () => ({
  useInbox: vi.fn(),
  INBOX_PAGE_SIZE: 40,
}));

vi.mock('../services/api', () => ({
  getEntry: vi.fn(),
  searchEntries: vi.fn(),
  deleteEntry: vi.fn(),
  retryEntry: vi.fn(),
  enrichEntry: vi.fn(),
  fetchJournalStats: vi.fn().mockResolvedValue({
    totalEntries: 0,
    totalSongs: 0,
    totalFilms: 0,
    totalNotes: 0,
    totalSoftware: 0,
  }),
  // Header and the inspector ask who is signed in.
  fetchMe: vi.fn().mockResolvedValue({
    user: 'mike',
    displayName: 'Mike',
    isAdmin: false,
    authenticated: true,
    family: [],
  }),
  fetchEntryMedia: vi.fn().mockResolvedValue({
    entryId: '',
    videoUrl: null,
    audioUrl: null,
    thumbnailUrl: null,
    frames: [],
    slides: [],
  }),
}));

function makeEntry(partial: Partial<Entry> & Pick<Entry, 'id'>): Entry {
  return {
    sourceUrl: 'https://instagram.com/reel/x',
    sourcePlatform: 'instagram',
    inputChannel: 'telegram',
    inputUser: null,
    caption: null,
    thumbnailUrl: null,
    mediaUrl: null,
    status: 'completed',
    results: { songs: [], films: [], notes: [], links: [], tags: [] },
    actionLog: [],
    createdAt: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

const RECENT_ID = 'recent-entry-on-page-1';
const OLD_ID = 'old-entry-not-on-page-1';

const recentEntry = makeEntry({
  id: RECENT_ID,
  results: { songs: [], films: [], notes: [], links: [], tags: [], summary: 'RECENT ENTRY MARKER' },
});

const oldEntry = makeEntry({
  id: OLD_ID,
  results: { songs: [], films: [], notes: [], links: [], tags: [], summary: 'OLD ENTRY DEEP LINK MARKER' },
});

const summaryOf = (e: Entry): EntrySummary => ({
  id: e.id, sourceUrl: e.sourceUrl, sourcePlatform: e.sourcePlatform, caption: e.caption, thumbnailUrl: e.thumbnailUrl, status: e.status,
  createdAt: e.createdAt, summary: e.results.summary ?? null, songCount: 0, filmCount: 0, noteCount: 0, tags: [],
});

function mockJournal(entries: Entry[]) {
  vi.mocked(useInbox).mockReturnValue({
    entries: entries.map(summaryOf),
    total: entries.length,
    pageCount: 1,
    loading: false,
    error: false,
    facets: null,
    version: 0,
    reload: vi.fn(),
  });
}

function renderHomeAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LanguageProvider>
        <Home />
      </LanguageProvider>
    </MemoryRouter>
  );
}

describe('Home — ?entry= deep link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches and shows an entry that is not on the loaded journal page', async () => {
    mockJournal([recentEntry]);
    vi.mocked(api.getEntry).mockResolvedValue(oldEntry);

    renderHomeAt(`/?entry=${OLD_ID}`);

    await screen.findByText('OLD ENTRY DEEP LINK MARKER');
    expect(api.getEntry).toHaveBeenCalledWith(OLD_ID);
  });

  it('reads the linked entry by its id, once, even when the post is on the page that is shown (the list holds summaries)', async () => {
    mockJournal([recentEntry]);
    vi.mocked(api.getEntry).mockResolvedValue(recentEntry);

    renderHomeAt(`/?entry=${RECENT_ID}`);

    const inspector = await screen.findByText('completed', { selector: '.inspector-status-badge' });
    within(inspector.closest('.inspector') as HTMLElement).getByText('RECENT ENTRY MARKER');
    expect(api.getEntry).toHaveBeenCalledTimes(1);
    expect(api.getEntry).toHaveBeenCalledWith(RECENT_ID);
  });

  it('shows the empty-selection placeholder (no spinner, no throw) when the linked entry no longer exists', async () => {
    mockJournal([recentEntry]);
    vi.mocked(api.getEntry).mockRejectedValue(new Error('HTTP 404'));

    renderHomeAt('/?entry=deleted-entry-id');

    await waitFor(() => expect(api.getEntry).toHaveBeenCalledWith('deleted-entry-id'));
    // jsdom's default navigator.language ('en-US') resolves the app to English.
    expect(await screen.findByText(translations.en.selectEntry)).toBeTruthy();
  });

  it('opens the mobile inspector panel for a deep link on a narrow screen', async () => {
    // Regression: the entry loaded into the DOM fine, but on mobile the post is hidden by CSS unless the list says it has a selection
    // (`.has-selection`): a phone opening the Telegram link saw only the list. jsdom doesn't apply the stylesheet's media query, so this
    // test asserts the class directly rather than just checking the inspector is present in the DOM.
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 375 });
    window.dispatchEvent(new Event('resize'));

    try {
      mockJournal([recentEntry]);
      vi.mocked(api.getEntry).mockResolvedValue(oldEntry);

      renderHomeAt(`/?entry=${OLD_ID}`);

      await screen.findByText('OLD ENTRY DEEP LINK MARKER');
      // the list of the Studio carries the class that, on a phone, puts the post over the list
      const split = document.querySelector('.links-split');
      expect(split).not.toBeNull();
      expect(split?.classList.contains('has-selection')).toBe(true);
    } finally {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: originalInnerWidth });
    }
  });
});
