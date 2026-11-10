import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SidePlayer } from './SidePlayer';
import { LanguageProvider } from '../../i18n';
import { translations } from '../../i18n/translations';

// The Player in a panel on the right (look and feel P4, L3: «a destra (pannello con copertina e coda)»): the cover, what plays, the controls,
// the progress, and the queue (the song that plays and the ones after it, as the player page shows them). It starts nothing by itself.

const song = (n: number) => ({ songKey: `a${n}::t${n}`, title: `Title ${n}`, artist: `Artist ${n}`, meta: n === 1 ? { coverUrl: 'https://img/cover1.jpg' } : null });
const player = {
  queue: [] as ReturnType<typeof song>[],
  index: 0,
  current: null as null | ReturnType<typeof song>,
  playing: false, currentTime: 83, duration: 258, queueLabel: 'Synthwave da ascoltare' as string | null, loading: false, locationOverrides: {}, currentDownload: null,
  repeat: 'off',
  toggle: vi.fn(), next: vi.fn(), previous: vi.fn(), seek: vi.fn(), playSong: vi.fn(),
};
vi.mock('../../player/PlayerContext', () => ({ usePlayer: () => player }));
vi.mock('../player/SourceSwitch', () => ({ SourceSwitch: () => <span data-testid="source-switch" /> }));
vi.mock('../player/PlayingFrom', () => ({ PlayingFrom: () => null }));
vi.mock('../manager/DownloadChip', () => ({ DownloadChip: () => null }));
vi.mock('../LocationBadge', () => ({ LocationBadge: () => null }));

const t = translations.en;

function setQueue(n: number, index = 0) {
  player.queue = Array.from({ length: n }, (_, i) => song(i + 1));
  player.index = index;
  player.current = n > 0 ? player.queue[index] : null;
}

const renderSide = () => render(<LanguageProvider><MemoryRouter><SidePlayer /></MemoryRouter></LanguageProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  setQueue(3, 0);
});

describe('the Player on the right', () => {
  it('is a panel named Player with the cover, the title, the artist and the name of the queue', () => {
    renderSide();
    const panel = screen.getByRole('complementary', { name: t.shellPlayerLabel });
    expect(panel.querySelector('img')).toHaveAttribute('src', 'https://img/cover1.jpg');
    expect(within(panel).getAllByText('Title 1').length).toBeGreaterThan(0);
    expect(panel).toHaveTextContent('Artist 1');
    expect(panel).toHaveTextContent('Synthwave da ascoltare');
  });

  it('has the controls, the progress, the «Sorgente» switch and the link to the Player page; it starts nothing', async () => {
    renderSide();
    expect(screen.getByRole('button', { name: t.shellPlay })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: t.shellSeek })).toBeInTheDocument();
    expect(screen.getByTestId('source-switch')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: t.shellOpenPlayer })).toHaveAttribute('href', '/player');
    expect(player.toggle).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: t.shellPlay }));
    expect(player.toggle).toHaveBeenCalledTimes(1);
  });

  it('nothing loaded: says so, and the controls wait', () => {
    setQueue(0);
    renderSide();
    expect(screen.getByText(t.shellNothingPlaying)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.shellPlay })).toBeDisabled();
    expect(screen.getByText(t.sideQueueEmpty)).toBeInTheDocument();
  });
});

describe('the queue', () => {
  it('lists the song that plays and the ones after it; the one that plays is marked', () => {
    setQueue(3, 1);
    renderSide();
    const list = screen.getByRole('list', { name: t.sideQueue });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining('Title 2'), expect.stringContaining('Title 3')]);
    expect(within(items[0]).getByRole('button')).toHaveAttribute('aria-current', 'true');
    expect(within(items[1]).getByRole('button')).not.toHaveAttribute('aria-current');
  });

  it('choosing a song plays it inside the same queue, with the same name', async () => {
    renderSide();
    const list = screen.getByRole('list', { name: t.sideQueue });
    await userEvent.click(within(list).getByRole('button', { name: /Title 3/ }));
    expect(player.playSong).toHaveBeenCalledWith('a3::t3', player.queue, 'Synthwave da ascoltare');
  });

  it('a long queue shows 20 songs from the one that plays, and says how many more follow', () => {
    setQueue(30, 4);
    renderSide();
    const list = screen.getByRole('list', { name: t.sideQueue });
    expect(within(list).getAllByRole('listitem')).toHaveLength(20);
    expect(within(list).getAllByRole('button')[0]).toHaveTextContent('Title 5');
    expect(screen.getByText(t.sideQueueMore.replace('{count}', '6'))).toBeInTheDocument();     // 30 - (4 played) - 20 shown
  });

  it('a queue that fits shows no «more» line', () => {
    renderSide();
    expect(screen.queryByText(/^\+\d+/)).toBeNull();
  });
});
