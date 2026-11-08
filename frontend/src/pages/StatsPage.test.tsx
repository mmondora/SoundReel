import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StatsPage } from './StatsPage';
import { LanguageProvider } from '../i18n';
import { setStoredLanguage } from '../i18n/translations';
import * as api from '../services/api';
import type { MeResponse } from '../types';

vi.mock('../services/api', () => ({
  fetchMe: vi.fn(),
  fetchJournalStats: vi.fn().mockResolvedValue({ totalEntries: 0, totalSongs: 0, totalFilms: 0, totalNotes: 0, totalSoftware: 0 }),
  fetchListeningStats: vi.fn(),
  fetchRecentPlays: vi.fn(),
}));

const USER: MeResponse = {
  user: 'mike', displayName: 'Michele', isAdmin: false, authenticated: true,
  family: [{ id: 'mike', displayName: 'Michele' }, { id: 'archi', displayName: 'Archimede' }],
};
const ADMIN: MeResponse = { ...USER, isAdmin: true };

const HEAT = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
HEAT[5][23] = 9; // Saturday, 23:00
HEAT[2][8] = 3;

const STATS = {
  totals: { plays: 42, skips: 7, listenedMs: 5_400_000, songs: 20, artists: 9, devices: 2 },
  perDay: [
    { day: '2026-11-05', plays: 3, listenedMs: 600_000 },
    { day: '2026-11-07', plays: 5, listenedMs: 900_000 },
  ],
  heatmap: HEAT,
  topSongs: [{ songKey: 'air::sexy boy', title: 'Sexy Boy', artist: 'Air', plays: 6 }],
  topArtists: [{ artist: 'Air', plays: 9 }],
  topGenres: [{ genre: 'rock', plays: 11 }],
  perDevice: [{ device: 'iPhone di Michele', plays: 30 }, { device: 'web', plays: 12 }],
  perOrigin: [{ origin: 'local', plays: 20 }, { origin: 'stream', plays: 10 }, { origin: 'web', plays: 12 }],
  neverPlayed: 15,
  period: { from: '2026-10-09', to: '2026-11-07' },
};

const EMPTY = { ...STATS, totals: { plays: 0, skips: 0, listenedMs: 0, songs: 0, artists: 0, devices: 0 }, perDay: [], topSongs: [], topArtists: [], topGenres: [], perDevice: [], perOrigin: [] };

const RECENT = {
  plays: [
    { id: 'p1', songKey: 'air::sexy boy', title: 'Sexy Boy', artist: 'Air', user: 'mike', device: 'web', origin: 'web', startedAt: '2026-11-07T10:00:00Z', listenedMs: 215_000, counted: true },
    { id: 'p2', songKey: 'daft punk::one more time', title: 'One More Time', artist: 'Daft Punk', user: 'archi', device: 'iPhone di Archimede', origin: 'local', startedAt: '2026-11-07T09:00:00Z', listenedMs: 4_000, counted: false },
  ],
};

function renderPage() {
  return render(
    <LanguageProvider>
      <MemoryRouter>
        <StatsPage />
      </MemoryRouter>
    </LanguageProvider>,
  );
}

const statsCalls = () => vi.mocked(api.fetchListeningStats).mock.calls.map((c) => c[0]);
const lastCall = () => statsCalls()[statsCalls().length - 1];
const tile = (id: string) => document.querySelector(`[data-tile="${id}"] dd`)?.textContent;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setStoredLanguage('en');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 7, 12, 0, 0)); // Saturday 7 Nov 2026, local time
  vi.mocked(api.fetchMe).mockResolvedValue(USER);
  vi.mocked(api.fetchListeningStats).mockResolvedValue(STATS);
  vi.mocked(api.fetchRecentPlays).mockResolvedValue(RECENT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StatsPage dashboard', () => {
  it('shows totals, both charts, the rankings and the recent plays', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Plays per day' });

    expect(tile('plays')).toBe('42');
    expect(tile('skips')).toBe('7');
    expect(tile('listened')).toBe('1 h 30 min');
    expect(tile('songs')).toBe('20');
    expect(tile('artists')).toBe('9');
    expect(tile('devices')).toBe('2');
    expect(tile('never')).toBe('15');

    // The bars cover every day between the first and the last (the 6th is a zero bar): 3 days, 8 plays.
    expect(screen.getByRole('img', { name: /Plays per day: 3 days, 8 plays in total, the busiest day has 5\./ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Peak: Saturday at 23:00, 9 plays/ })).toBeInTheDocument();

    for (const title of ['Most played songs', 'Most played artists', 'Most played types (genres)', 'By device', 'By origin', 'Recent plays']) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }
    const songs = within(screen.getByRole('region', { name: 'Most played songs' }));
    expect(songs.getByText('Sexy Boy')).toBeInTheDocument();
    expect(songs.getByText('6 plays')).toBeInTheDocument();
    // Origins are said in words, not as raw ids.
    const origins = within(screen.getByRole('region', { name: 'By origin' }));
    expect(origins.getByText('On the phone (downloaded file)')).toBeInTheDocument();
    expect(origins.getByText('Streamed from the server')).toBeInTheDocument();
    expect(origins.getByText('Web player')).toBeInTheDocument();
  });

  it('exposes the numbers of both charts as real tables', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Plays per day' });
    const perDay = screen.getByRole('table', { name: 'Plays per day' });
    expect(within(perDay).getByRole('row', { name: /2026-11-07\s+5\s+15 min/ })).toBeInTheDocument();
    const heat = screen.getByRole('table', { name: 'When you listen (local hour)' });
    expect(within(heat).getByRole('row', { name: /Saturday/ })).toHaveTextContent('9');
  });

  it('lists recent plays with their outcome, and hides the user column for a plain user', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Recent plays' });
    const recent = screen.getAllByRole('table').find((t) => within(t).queryByRole('columnheader', { name: 'Result' }));
    expect(recent).toBeDefined();
    const rows = within(recent as HTMLElement).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Sexy Boy — Air');
    expect(rows[1]).toHaveTextContent('3:35');
    expect(rows[1]).toHaveTextContent('counted');
    expect(rows[2]).toHaveTextContent('0:04');
    expect(rows[2]).toHaveTextContent('skip');
    expect(within(recent as HTMLElement).queryByRole('columnheader', { name: 'User' })).toBeNull();
  });

  it('asks for the last 30 days of the viewer’s own listening, with the browser time zone, and nothing else', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Plays per day' });
    expect(statsCalls()[0]).toMatchObject({ scope: 'me', from: '2026-10-09', to: '2026-11-07' });
    expect(typeof statsCalls()[0].tz).toBe('string');
    expect(statsCalls()[0]).not.toHaveProperty('user');
    expect(statsCalls()[0]).not.toHaveProperty('device');
    expect(vi.mocked(api.fetchRecentPlays).mock.calls[0][0]).toMatchObject({ scope: 'me', from: '2026-10-09' });
    expect(screen.getByRole('radio', { name: '30 days' })).toBeChecked();
    expect(screen.getByText('Your listening')).toBeInTheDocument();
  });

  it('changes the period: 7 days is a week ending today, All time has no bounds', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Plays per day' });

    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(lastCall()).toMatchObject({ from: '2026-11-01', to: '2026-11-07' }));

    fireEvent.click(screen.getByRole('radio', { name: 'All time' }));
    await waitFor(() => expect(lastCall()).toBeDefined());
    const last = lastCall();
    expect(last).toMatchObject({ scope: 'me' });
    expect(last).not.toHaveProperty('from');
    expect(last).not.toHaveProperty('to');
    expect(screen.getByRole('radio', { name: 'All time' })).toBeChecked();
  });

  it('reloads on demand', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Plays per day' });
    const before = statsCalls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(statsCalls().length).toBe(before + 1));
  });
});

describe('StatsPage empty, error and loading states', () => {
  it('explains an empty period instead of drawing empty charts', async () => {
    vi.mocked(api.fetchListeningStats).mockResolvedValue(EMPTY);
    renderPage();
    expect(await screen.findByRole('heading', { name: 'No listening recorded yet' })).toBeInTheDocument();
    expect(screen.getByText(/Listening is recorded from the web player and from Mondrop/)).toBeInTheDocument();
    expect(screen.getByText('Library songs never played: 15')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Plays per day' })).toBeNull();
    // The controls are still there: a wider period may have data.
    expect(screen.getByRole('radio', { name: 'All time' })).toBeInTheDocument();
  });

  it('shows a loading line first', async () => {
    let release: (v: unknown) => void = () => undefined;
    vi.mocked(api.fetchListeningStats).mockReturnValue(new Promise((resolve) => { release = resolve; }));
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('Loading statistics…');
    release(STATS);
    await screen.findByRole('heading', { name: 'Plays per day' });
    expect(screen.getByRole('status')).not.toHaveTextContent('Loading');
  });

  it('shows the failure with a retry that works', async () => {
    vi.mocked(api.fetchListeningStats).mockRejectedValueOnce(new Error('HTTP 500'));
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Statistics unavailable');
    expect(alert).toHaveTextContent('HTTP 500');
    fireEvent.click(within(alert).getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('heading', { name: 'Plays per day' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still draws the dashboard when only the recent-plays list fails', async () => {
    vi.mocked(api.fetchRecentPlays).mockRejectedValue(new Error('HTTP 500'));
    renderPage();
    await screen.findByRole('heading', { name: 'Plays per day' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Recent plays' })).toBeInTheDocument();
    expect(screen.getAllByText('No data in this period').length).toBeGreaterThan(0);
  });

  it('ignores a slow answer for an older period (the newest request wins)', async () => {
    const slow = new Promise<unknown>((resolve) => { setTimeout(() => resolve(STATS), 50); });
    const quick = { ...STATS, totals: { ...STATS.totals, plays: 5 } };
    vi.mocked(api.fetchListeningStats).mockReturnValueOnce(slow).mockResolvedValue(quick);
    renderPage();
    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(tile('plays')).toBe('5'));
    await new Promise((resolve) => { setTimeout(resolve, 80); });
    expect(tile('plays')).toBe('5');
  });
});

describe('StatsPage permissions (who sees what)', () => {
  it('gives a plain user no scope, user or device controls and never sends scope=all, user or device', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Plays per day' });
    await waitFor(() => expect(api.fetchMe).toHaveBeenCalled());

    expect(screen.queryByRole('radio', { name: 'Everybody' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Only mine' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'User' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Device' })).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: '90 days' }));
    fireEvent.click(screen.getByRole('radio', { name: 'All time' }));
    await waitFor(() => expect(statsCalls().length).toBeGreaterThanOrEqual(3));
    const all = [...statsCalls(), ...vi.mocked(api.fetchRecentPlays).mock.calls.map((c) => c[0])];
    for (const q of all) {
      expect(q.scope).toBe('me');
      expect(q).not.toHaveProperty('user');
      expect(q).not.toHaveProperty('device');
    }
  });

  it('treats an unknown viewer (/api/me failed) as a plain user', async () => {
    vi.mocked(api.fetchMe).mockRejectedValue(new Error('offline'));
    renderPage();
    await screen.findByRole('heading', { name: 'Plays per day' });
    expect(screen.queryByRole('radio', { name: 'Everybody' })).toBeNull();
    expect(statsCalls().every((q) => q.scope === 'me')).toBe(true);
  });

  it('lets an admin widen to everybody, then pick a user and a device', async () => {
    vi.mocked(api.fetchMe).mockResolvedValue(ADMIN);
    renderPage();
    await screen.findByRole('heading', { name: 'Plays per day' });

    const everybody = await screen.findByRole('radio', { name: 'Everybody' });
    expect(screen.getByRole('radio', { name: 'Only mine' })).toBeChecked();
    expect(screen.queryByRole('combobox', { name: 'User' })).toBeNull(); // only with "Everybody"

    fireEvent.click(everybody);
    await waitFor(() => expect(lastCall()).toMatchObject({ scope: 'all' }));
    expect(screen.getByText('Everybody’s listening')).toBeInTheDocument();
    // The recent list now says whose play each one is.
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'User' })).toBeInTheDocument());

    const user = screen.getByRole('combobox', { name: 'User' });
    expect(within(user).getAllByRole('option').map((o) => o.textContent)).toEqual(['All users', 'Michele', 'Archimede']);
    fireEvent.change(user, { target: { value: 'archi' } });
    await waitFor(() => expect(lastCall()).toMatchObject({ scope: 'all', user: 'archi' }));
    expect(screen.getByText('Listening of Archimede')).toBeInTheDocument();

    // Devices come from the answer; the filter keeps its options after it narrows the result.
    const device = screen.getByRole('combobox', { name: 'Device' });
    expect(within(device).getAllByRole('option').map((o) => o.textContent)).toEqual(['All devices', 'iPhone di Michele', 'web']);
    fireEvent.change(device, { target: { value: 'web' } });
    await waitFor(() => expect(lastCall()).toMatchObject({ scope: 'all', user: 'archi', device: 'web' }));
    vi.mocked(api.fetchListeningStats).mockResolvedValue({ ...STATS, perDevice: [{ device: 'web', plays: 12 }] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'By device' })).queryByText('iPhone di Michele')).toBeNull());
    expect(within(screen.getByRole('combobox', { name: 'Device' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['All devices', 'iPhone di Michele', 'web']);
  });

  it('drops the user filter when the admin goes back to "Only mine"', async () => {
    vi.mocked(api.fetchMe).mockResolvedValue(ADMIN);
    renderPage();
    fireEvent.click(await screen.findByRole('radio', { name: 'Everybody' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'User' }), { target: { value: 'archi' } });
    await waitFor(() => expect(lastCall()).toMatchObject({ user: 'archi' }));

    fireEvent.click(screen.getByRole('radio', { name: 'Only mine' }));
    await waitFor(() => expect(lastCall()).toMatchObject({ scope: 'me' }));
    expect(lastCall()).not.toHaveProperty('user');
    expect(screen.queryByRole('combobox', { name: 'User' })).toBeNull();
  });
});
