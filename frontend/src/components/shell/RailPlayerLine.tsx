import { useLanguage } from '../../i18n';
import { useUiPrefs } from '../../hooks/useUiPrefs';
import { usePlayer } from '../../player/PlayerContext';
import { Controls, OpenPlayerLink } from './playerParts';

/**
 * The Player when it is hidden (look and feel P4, L3: «nascosto (una riga nel menu a sinistra)»): the bar is gone, and in the left menu there is one
 * line with what plays, play or pause, next, the link to the Player page, and a button that brings the bar back (it writes the bottom as the place
 * of the Player). It shows and drives what the player context does; it starts nothing by itself.
 */
export function RailPlayerLine() {
  const { t } = useLanguage();
  const player = usePlayer();
  const { update } = useUiPrefs();
  const { current } = player;
  const cover = current?.meta?.coverUrl;
  return (
    <div className="shell-rail-player" role="group" aria-label={t.shellPlayerLabel}>
      <span className="shell-art" aria-hidden="true">{cover ? <img src={cover} alt="" /> : null}</span>
      <span className="shell-np-text">
        {current ? (
          <>
            <span className="shell-np-title">{current.title}</span>
            <span className="shell-np-sub">{current.artist || '—'}</span>
          </>
        ) : (
          <span className="shell-np-sub">{t.shellNothingPlaying}</span>
        )}
      </span>
      <span className="shell-rail-player-btns">
        <Controls previous={false} />
        <OpenPlayerLink />
        <button type="button" className="shell-ib" aria-label={t.dockShowBar} title={t.dockShowBar} onClick={() => { void update({ player: { dock: 'bottom' } }); }}>
          <svg className="shell-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="m8 9 4-4 4 4" /></svg>
        </button>
      </span>
    </div>
  );
}
