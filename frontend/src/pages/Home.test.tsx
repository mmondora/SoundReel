import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Home } from './Home';
import { LanguageProvider } from '../i18n';
import { useJournal } from '../hooks/useJournal';
import * as api from '../services/api';
import { translations } from '../i18n/translations';
import type { Entry } from '../types';

// Regression test for the Telegram "🔗 Vedi entry" deep link
// (https://soundreel.casamon.dev/?entry=<uuid>): the entry it points to may
// not be on the first journal page, so Home must fetch it by id instead of
// only looking inside the currently loaded `entries` list.

vi.mock('../hooks/useJournal', () => ({
  useJournal: vi.fn(),
}));

vi.mock('../services/api', () => ({
  getEntry: vi.fn(),
  searchEntries: vi.fn(),
  deleteEntry: vi.fn(),
  retryEntry: vi.fn(),
  enrichEntry: vi.fn(),
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

function mockJournal(entries: Entry[]) {
  vi.mocked(useJournal).mockReturnValue({
    entries,
    stats: { totalEntries: entries.length, totalSongs: 0, totalFilms: 0, totalNotes: 0 },
    loading: false,
    error: null,
    currentPage: 1,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
    nextPage: vi.fn(),
    prevPage: vi.fn(),
    availablePlatforms: [],
    availableChannels: [],
    availableUsers: [],
    availableCategories: [],
    availableVerdicts: [],
    filteredCount: entries.length,
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

  it('does not call getEntry when the linked entry is already on the loaded page', async () => {
    mockJournal([recentEntry]);
    vi.mocked(api.getEntry).mockResolvedValue(oldEntry);

    renderHomeAt(`/?entry=${RECENT_ID}`);

    const inspector = await screen.findByText('completed', { selector: '.inspector-status-badge' });
    within(inspector.closest('.inspector') as HTMLElement).getByText('RECENT ENTRY MARKER');
    expect(api.getEntry).not.toHaveBeenCalled();
  });

  it('shows the empty-selection placeholder (no spinner, no throw) when the linked entry no longer exists', async () => {
    mockJournal([recentEntry]);
    vi.mocked(api.getEntry).mockRejectedValue(new Error('HTTP 404'));

    renderHomeAt('/?entry=deleted-entry-id');

    await waitFor(() => expect(api.getEntry).toHaveBeenCalledWith('deleted-entry-id'));
    // jsdom's default navigator.language ('en-US') resolves the app to English.
    expect(await screen.findByText(translations.en.selectEntry)).toBeTruthy();
  });
});
