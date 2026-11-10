import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EntriesView } from './EntriesView';
import { LanguageProvider } from '../i18n';
import * as api from '../services/api';
import { translations } from '../i18n/translations';
import type { Entry, EntrySummary } from '../types';

// The posts of a page in the two views (Studio, Bacheca): the Link page and the Inbox draw them here. What these tests hold is what the Inbox needs on top
// of the Link page: the page that changes starts again at the top of the list, and the open post is read again when the library changes.

vi.mock('../services/api', () => ({
  getEntry: vi.fn(),
  deleteEntry: vi.fn(),
  retryEntry: vi.fn(),
  enrichEntry: vi.fn(),
  fetchMe: vi.fn().mockResolvedValue({ user: 'mike', displayName: 'Mike', isAdmin: false, authenticated: true, family: [] }),
  fetchEntryMedia: vi.fn().mockResolvedValue({ entryId: '', videoUrl: null, audioUrl: null, thumbnailUrl: null, frames: [], slides: [] }),
}));

const row = (id: string): EntrySummary => ({
  id, sourceUrl: `https://instagram.com/reel/${id}`, sourcePlatform: 'instagram', caption: null, thumbnailUrl: null, status: 'completed',
  createdAt: '2026-11-10T10:00:00.000Z', summary: `POST ${id}`, songCount: 0, filmCount: 0, noteCount: 0, tags: [],
});
const full = (id: string, status: Entry['status'] = 'completed'): Entry => ({
  id, sourceUrl: `https://instagram.com/reel/${id}`, sourcePlatform: 'instagram', inputChannel: 'web', inputUser: null, caption: null, thumbnailUrl: null,
  mediaUrl: null, status, results: { songs: [], films: [], notes: [], links: [], tags: [], summary: `FULL ${id}` }, actionLog: [], createdAt: '2026-11-10T10:00:00Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getEntry).mockImplementation(async (id: string) => full(id));
});

function renderView(props: Partial<Parameters<typeof EntriesView>[0]> = {}) {
  const base = { entries: [row('a'), row('b')], mode: 'studio' as const, selectedId: null, onSelect: vi.fn(), onDeleted: vi.fn(), ...props };
  const view = render(<MemoryRouter><LanguageProvider><EntriesView {...base} /></LanguageProvider></MemoryRouter>);
  return {
    ...view,
    again: (next: Partial<Parameters<typeof EntriesView>[0]>) => view.rerender(<MemoryRouter><LanguageProvider><EntriesView {...base} {...next} /></LanguageProvider></MemoryRouter>),
  };
}

describe('a new page starts at the top of the list', () => {
  it.each([['studio', '.links-list'], ['wall', '.wall-scroll']] as const)('%s: when the scroll key changes the list that was scrolled goes back to the top', (mode, selector) => {
    const { container, again } = renderView({ mode, scrollKey: 1 });
    const scroller = container.querySelector(selector) as HTMLElement;
    scroller.scrollTop = 500;
    again({ mode, scrollKey: 1 });
    expect(scroller.scrollTop).toBe(500);          // the same page: it stays where it is
    again({ mode, scrollKey: 2 });
    expect(scroller.scrollTop).toBe(0);
  });

  it('without a scroll key nothing is moved', () => {
    const { container, again } = renderView();
    const scroller = container.querySelector('.links-list') as HTMLElement;
    scroller.scrollTop = 300;
    again({ entries: [row('a')] });
    expect(scroller.scrollTop).toBe(300);
  });
});

describe('the open post follows the library', () => {
  it('when the version goes up the open post is read again (an analysis finished)', async () => {
    vi.mocked(api.getEntry).mockResolvedValueOnce(full('a', 'processing')).mockResolvedValueOnce(full('a', 'completed'));
    const { again } = renderView({ selectedId: 'a', version: 0 });
    await screen.findByText(translations.en.processing, { selector: '.inspector-status-badge' });
    again({ selectedId: 'a', version: 1 });
    await screen.findByText('completed', { selector: '.inspector-status-badge' });
    expect(api.getEntry).toHaveBeenCalledTimes(2);
  });

  it('with the same version it is read once', async () => {
    const { again } = renderView({ selectedId: 'a', version: 4 });
    await waitFor(() => expect(api.getEntry).toHaveBeenCalledTimes(1));
    again({ selectedId: 'a', version: 4 });
    expect(api.getEntry).toHaveBeenCalledTimes(1);
  });
});
