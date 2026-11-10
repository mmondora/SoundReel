import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlayerBar } from './PlayerBar';
import { LanguageProvider } from '../../i18n';
import { setStoredLanguage } from '../../i18n/translations';

// The player of the shell: a bar that is always there, at the bottom (Michele, 10 November: «si, ma spostabile»: the bottom is the
// default, ADR-0026 will move it). It only SHOWS and drives what the player context already does; it never starts anything itself.

const player = {
  current: null as null | { songKey: string; title: string; artist: string },
  playing: false,
  currentTime: 0,
  duration: 0,
  queueLabel: null as string | null,
  loading: false,
  locationOverrides: {},
  currentDownload: null,
  toggle: vi.fn(),
  next: vi.fn(),
  previous: vi.fn(),
  seek: vi.fn(),
};
vi.mock('../../player/PlayerContext', () => ({ usePlayer: () => player }));
// the pieces that have their own tests (the «Sorgente» switch, the badge of the place, «da dove suona», the first-play download)
vi.mock('../player/SourceSwitch', () => ({ SourceSwitch: () => <span data-testid="source-switch" /> }));
vi.mock('../player/PlayingFrom', () => ({ PlayingFrom: () => <span data-testid="playing-from" /> }));
vi.mock('../manager/DownloadChip', () => ({ DownloadChip: () => <span data-testid="download-chip" /> }));
vi.mock('../LocationBadge', () => ({ LocationBadge: () => <span data-testid="location-badge" /> }));

const SONG = { songKey: 'kavinsky::nightcall', title: 'Nightcall', artist: 'Kavinsky' };

function renderBar() {
  return render(
    <LanguageProvider>
      <MemoryRouter>
        <PlayerBar />
      </MemoryRouter>
    </LanguageProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setStoredLanguage('it');
  Object.assign(player, { current: SONG, playing: false, currentTime: 83, duration: 258, queueLabel: 'Synthwave da ascoltare', loading: false });
});

describe('PlayerBar', () => {
  it('shows what is loaded: title, artist, the name of the queue and the times as 1:23 / 4:18', () => {
    renderBar();
    expect(screen.getByText('Nightcall')).toBeInTheDocument();
    expect(screen.getByText(/Kavinsky/)).toBeInTheDocument();
    expect(screen.getByText(/Synthwave da ascoltare/)).toBeInTheDocument();
    expect(screen.getByText('1:23')).toBeInTheDocument();
    expect(screen.getByText('4:18')).toBeInTheDocument();
  });

  it('the play button asks the player to toggle, and says «Pausa» while it plays', () => {
    const { rerender } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Riproduci' }));
    expect(player.toggle).toHaveBeenCalledTimes(1);
    player.playing = true;
    rerender(
      <LanguageProvider>
        <MemoryRouter>
          <PlayerBar />
        </MemoryRouter>
      </LanguageProvider>,
    );
    expect(screen.getByRole('button', { name: 'Pausa' })).toBeInTheDocument();
  });

  it('next and previous call the player', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Brano successivo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Brano precedente' }));
    expect(player.next).toHaveBeenCalledTimes(1);
    expect(player.previous).toHaveBeenCalledTimes(1);
  });

  it('the progress is a slider over the length of the song and moving it seeks', () => {
    renderBar();
    const slider = screen.getByRole('slider', { name: 'Posizione nel brano' });
    expect(slider).toHaveAttribute('min', '0');
    expect(slider).toHaveAttribute('max', '258');
    expect(slider).toHaveValue('83');
    fireEvent.change(slider, { target: { value: '120' } });
    expect(player.seek).toHaveBeenCalledWith(120);
  });

  it('a position past the end (a stale value) is held at the end, and the seconds are always two digits: 1:05', () => {
    Object.assign(player, { currentTime: 300, duration: 258 });
    const first = renderBar();
    expect(screen.getByRole('slider', { name: 'Posizione nel brano' })).toHaveValue('258');
    first.unmount();
    Object.assign(player, { currentTime: 65, duration: 258 });
    renderBar();
    expect(screen.getByText('1:05')).toBeInTheDocument();
  });

  it('with nothing loaded it says so and the controls are off', () => {
    Object.assign(player, { current: null, currentTime: 0, duration: 0, queueLabel: null });
    renderBar();
    expect(screen.getByText('Niente in riproduzione')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Riproduci' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Brano successivo' })).toBeDisabled();
    expect(screen.getByRole('slider', { name: 'Posizione nel brano' })).toBeDisabled();
  });

  it('a song with no known length has a slider that cannot be moved and times that do not lie', () => {
    Object.assign(player, { currentTime: 12, duration: 0 });
    renderBar();
    expect(screen.getByRole('slider', { name: 'Posizione nel brano' })).toBeDisabled();
    expect(screen.getByText('0:12')).toBeInTheDocument();
    expect(screen.getByText('–:––')).toBeInTheDocument();
  });

  it('keeps what the old mini player had: the «Sorgente» switch, the place of the file, where it plays from and the download', () => {
    renderBar();
    expect(screen.getByTestId('source-switch')).toBeInTheDocument();
    expect(screen.getByTestId('location-badge')).toBeInTheDocument();
    expect(screen.getByTestId('playing-from')).toBeInTheDocument();
    expect(screen.getByTestId('download-chip')).toBeInTheDocument();
  });

  it('while it loads the play button says so (a dotted button, busy) and a screen reader hears it', () => {
    player.loading = true;
    renderBar();
    const play = screen.getByRole('button', { name: 'Riproduci' });
    expect(play).toHaveTextContent('…');
    expect(play).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(/Sto caricando/);
  });

  it('opens the full Player from the bar', () => {
    renderBar();
    expect(screen.getByRole('link', { name: 'Apri il Player' })).toHaveAttribute('href', '/player');
  });

  it('never starts playback by itself: mounting and re-rendering do not toggle', () => {
    const { rerender } = renderBar();
    rerender(
      <LanguageProvider>
        <MemoryRouter>
          <PlayerBar />
        </MemoryRouter>
      </LanguageProvider>,
    );
    expect(player.toggle).not.toHaveBeenCalled();
    expect(player.next).not.toHaveBeenCalled();
  });
});
