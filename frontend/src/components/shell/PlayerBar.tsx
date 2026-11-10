import { Link } from 'react-router-dom';
import { usePlayer } from '../../player/PlayerContext';
import { useLanguage } from '../../i18n';
import { DownloadChip } from '../manager/DownloadChip';
import { LocationBadge } from '../LocationBadge';
import { PlayingFrom } from '../player/PlayingFrom';
import { SourceSwitch } from '../player/SourceSwitch';
import { songLocationIn } from '../../utils/songLocation';

/** A length unknown to the player: written so, never as «0:00» (that would be a lie about a song that is playing). */
const UNKNOWN_TIME = '–:––';

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The player of the shell: a bar that is always there, at the bottom (Michele, 10 November: «si, ma spostabile»: the bottom is where it
 * starts, the configuration of the user will move it, ADR-0026). It SHOWS and drives what the player context already does (it replaces the
 * old floating mini player, with the same «Sorgente» switch, the place of the file and the first-play download); it never starts anything.
 */
export function PlayerBar() {
  const { t } = useLanguage();
  const player = usePlayer();
  const { current, playing, currentTime, duration } = player;
  const has = current !== null;
  const known = has && Number.isFinite(duration) && duration > 0;
  const cover = current?.meta?.coverUrl;

  return (
    <section className="shell-bar" aria-label={t.shellPlayerLabel}>
      <div className="shell-np">
        <span className="shell-art" aria-hidden="true">
          {cover ? <img src={cover} alt="" /> : null}
        </span>
        {current ? (
          <span className="shell-np-text">
            <span className="shell-np-title">{current.title}</span>
            <span className="shell-np-sub">
              {[current.artist || '—', player.queueLabel].filter(Boolean).join(' · ')}
              <LocationBadge location={songLocationIn(current, player.locationOverrides)} />
              <PlayingFrom compact />
              <DownloadChip state={player.currentDownload ?? undefined} compact />
              <span className="sr-only" role="status">{player.loading ? t.playerLoading : ''}</span>
            </span>
          </span>
        ) : (
          <span className="shell-np-text">
            <span className="shell-np-sub">{t.shellNothingPlaying}</span>
          </span>
        )}
      </div>

      <div className="shell-ctl">
        <button type="button" className="shell-ib" aria-label={t.shellPrevious} disabled={!has} onClick={() => player.previous()}>
          <svg className="shell-ic" viewBox="0 0 24 24" aria-hidden="true"><polygon points="19 20 9 12 19 4 19 20" /><path d="M5 19V5" /></svg>
        </button>
        <button
          type="button"
          className="shell-play"
          aria-label={playing ? t.shellPause : t.shellPlay}
          aria-busy={player.loading}
          title={player.loading ? t.playerLoading : undefined}
          disabled={!has}
          onClick={() => player.toggle()}
        >
          {player.loading ? (
            '…'
          ) : playing ? (
            <svg className="shell-ic shell-ic-solid" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
          ) : (
            <svg className="shell-ic shell-ic-solid" viewBox="0 0 24 24" aria-hidden="true"><polygon points="7 3 20 12 7 21 7 3" /></svg>
          )}
        </button>
        <button type="button" className="shell-ib" aria-label={t.shellNext} disabled={!has} onClick={() => player.next()}>
          <svg className="shell-ic" viewBox="0 0 24 24" aria-hidden="true"><polygon points="5 4 15 12 5 20 5 4" /><path d="M19 5v14" /></svg>
        </button>
      </div>

      <div className="shell-prog">
        <span className="shell-time">{formatTime(currentTime)}</span>
        <input
          type="range"
          className="shell-seek"
          aria-label={t.shellSeek}
          min={0}
          max={known ? Math.floor(duration) : 0}
          step={1}
          value={known ? Math.min(Math.floor(currentTime), Math.floor(duration)) : 0}
          disabled={!known}
          onChange={(e) => player.seek(Number(e.target.value))}
        />
        <span className="shell-time">{known ? formatTime(duration) : UNKNOWN_TIME}</span>
      </div>

      <div className="shell-right">
        <SourceSwitch variant="compact" />
        <Link to="/player" className="shell-ib" aria-label={t.shellOpenPlayer}>
          <svg className="shell-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
        </Link>
      </div>
    </section>
  );
}
