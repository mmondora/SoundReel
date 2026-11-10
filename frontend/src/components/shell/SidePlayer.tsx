import { interpolate, useLanguage } from '../../i18n';
import { usePlayer } from '../../player/PlayerContext';
import { computeQueueWindow } from '../../player/queueWindow';
import { Controls, NowPlaying, Progress, RightTools } from './playerParts';

// The Player in a panel on the right (look and feel P4, L3: «a destra (pannello con copertina e coda)»): the cover, what plays, the progress, the
// controls, the «Sorgente» switch, and the queue: the song that plays and the ones after it (at most 20, like the list of the Player page, which
// is windowed the same way). It shows and drives what the player context does; it starts nothing by itself.

export function SidePlayer() {
  const { t } = useLanguage();
  const player = usePlayer();
  const window = computeQueueWindow(player.queue.length, player.index);
  // «in coda» = what plays now and what follows (the songs already played are not part of it)
  const upNext = window.indices.filter((i) => i >= player.index);

  return (
    <aside className="shell-side" aria-label={t.shellPlayerLabel}>
      <NowPlaying />
      <Progress />
      <Controls />
      <RightTools />

      <h3 className="shell-side-title">{t.sideQueue}</h3>
      {upNext.length === 0 ? (
        <p className="shell-side-empty">{t.sideQueueEmpty}</p>
      ) : (
        <ol className="shell-side-queue" aria-label={t.sideQueue}>
          {upNext.map((i) => {
            const song = player.queue[i];
            return (
              <li key={`${i}:${song.songKey}`}>
                <button
                  type="button"
                  className="shell-side-song"
                  aria-current={i === player.index ? 'true' : undefined}
                  onClick={() => player.playSong(song.songKey, player.queue, player.queueLabel)}
                >
                  <span className="shell-side-song-title">{song.title}</span>
                  <span className="shell-side-song-artist">{song.artist || '—'}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {window.hiddenAhead > 0 && <p className="shell-side-more">{interpolate(t.sideQueueMore, { count: window.hiddenAhead })}</p>}
    </aside>
  );
}
