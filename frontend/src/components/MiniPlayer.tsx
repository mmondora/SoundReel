import { Link, useLocation } from 'react-router-dom';
import { usePlayer } from '../player/PlayerContext';
import { useLanguage } from '../i18n';
import { DownloadChip } from './manager/DownloadChip';
import { LocationBadge } from './LocationBadge';
import { PlayingFrom } from './player/PlayingFrom';
import { SourceSwitch } from './player/SourceSwitch';
import { songLocationIn } from '../utils/songLocation';

export function MiniPlayer() {
  const { t } = useLanguage();
  const location = useLocation();
  const player = usePlayer();

  if (!player.current) return null;
  if (location.pathname === '/player') return null;

  const { current, playing } = player;
  const cover = current.meta?.coverUrl;

  return (
    <div className="mini-player" role="region" aria-label={t.playerNowPlaying}>
      <Link to="/player" className="mini-player-main">
        <span className="mini-player-art" aria-hidden>
          {cover ? <img src={cover} alt="" /> : '🎵'}
        </span>
        <span className="mini-player-text">
          <span className="mini-player-title">{current.title}</span>
          <span className="mini-player-artist">
            {current.artist || '—'}
            <LocationBadge location={songLocationIn(current, player.locationOverrides)} />
            <PlayingFrom compact />
            <DownloadChip state={player.currentDownload ?? undefined} compact />
            <span className="sr-only" role="status">{player.loading ? t.playerLoading : ''}</span>
          </span>
        </span>
      </Link>
      <SourceSwitch variant="compact" />
      <button
        type="button"
        className="mini-player-toggle"
        aria-label={playing ? 'Pause' : 'Play'}
        aria-busy={player.loading}
        title={player.loading ? t.playerLoading : undefined}
        onClick={(e) => {
          e.preventDefault();
          player.toggle();
        }}
      >
        {player.loading ? '…' : playing ? '⏸' : '▶'}
      </button>
      <button
        type="button"
        className="mini-player-next"
        aria-label="Next"
        onClick={(e) => {
          e.preventDefault();
          player.next();
        }}
      >
        ⏭
      </button>
    </div>
  );
}
