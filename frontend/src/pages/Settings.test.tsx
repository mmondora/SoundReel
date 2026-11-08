import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Settings } from './Settings';
import { LanguageProvider } from '../i18n';
import { setStoredLanguage } from '../i18n/translations';
import * as api from '../services/api';
import type { MeResponse } from '../types';

vi.mock('../services/spotify', () => ({ initiateSpotifyAuth: vi.fn() }));
vi.mock('../services/api', () => ({
  fetchMe: vi.fn(),
  getSpotifyStatus: vi.fn(),
  getFeatures: vi.fn(),
  updateFeatures: vi.fn(),
  getOpenAIConfig: vi.fn(),
  updateOpenAIConfig: vi.fn(),
  deleteAllEntries: vi.fn(),
  getMusicFolders: vi.fn(),
  saveMusicFolders: vi.fn(),
  browseMusicFolders: vi.fn(),
  rescanMusicFolders: vi.fn(),
}));

const ME = (isAdmin: boolean): MeResponse => ({ user: 'mike', displayName: 'Michele', isAdmin, authenticated: true, family: [] });

beforeEach(() => {
  vi.clearAllMocks();
  setStoredLanguage('en');
  vi.mocked(api.getSpotifyStatus).mockResolvedValue({ connected: false, playlistId: null } as Awaited<ReturnType<typeof api.getSpotifyStatus>>);
  vi.mocked(api.getFeatures).mockResolvedValue({ allowDuplicateUrls: false } as Awaited<ReturnType<typeof api.getFeatures>>);
  vi.mocked(api.getOpenAIConfig).mockResolvedValue({ enabled: false, apiKey: null } as Awaited<ReturnType<typeof api.getOpenAIConfig>>);
  vi.mocked(api.getMusicFolders).mockResolvedValue({
    roots: [{ path: '/music', label: 'Libreria (Spooty)', builtIn: true }],
    folders: [{ id: 'library', path: '/music', label: 'Libreria (Spooty)', enabled: true, builtIn: true, status: 'ok', files: 10, truncated: false, scannedAt: null }],
  });
});

function renderSettings() {
  return render(
    <LanguageProvider>
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    </LanguageProvider>,
  );
}

describe('the web configuration page', () => {
  it('shows "Music folders" to an admin, above the danger zone', async () => {
    vi.mocked(api.fetchMe).mockResolvedValue(ME(true));
    renderSettings();
    const heading = await screen.findByRole('heading', { name: 'Music folders' });
    const danger = await screen.findByRole('heading', { name: /danger zone/i });
    expect(heading.compareDocumentPosition(danger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(api.getMusicFolders).toHaveBeenCalled());
  });

  it('does not show it, and never asks for it, to a plain user', async () => {
    vi.mocked(api.fetchMe).mockResolvedValue(ME(false));
    renderSettings();
    await screen.findByRole('heading', { name: /danger zone/i });
    await waitFor(() => expect(api.fetchMe).toHaveBeenCalled());
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(screen.queryByRole('heading', { name: 'Music folders' })).toBeNull();
    expect(api.getMusicFolders).not.toHaveBeenCalled();
  });

  it('the rest of the page is there either way (language, Spotify, features)', async () => {
    vi.mocked(api.fetchMe).mockResolvedValue(ME(false));
    renderSettings();
    expect(await screen.findByRole('heading', { name: 'Language' })).toBeInTheDocument();
  });
});
