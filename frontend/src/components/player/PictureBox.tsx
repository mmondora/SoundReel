import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaBoxMode } from '../../player/mediaBox';
import { pickCover } from '../../player/mediaBox';
import '../../styles/player.css';

export interface PictureBoxProps {
  /** What to show now (decided by player/mediaBox): the video or the album cover. */
  mode: MediaBoxMode;
  /** Cover candidates in order (song cover → entry thumbnail); the placeholder comes after the last. */
  candidates: readonly string[];
  /** The song, to forget which covers failed to load when it changes. */
  songKey: string | null;
  /** Accessible title of the YouTube iframe. */
  videoTitle: string;
  /** The context's mount registration for the single YouTube player. */
  onYtMount: (el: HTMLDivElement | null) => void;
}

/**
 * The picture at the top of the player (rule W4): ONE fixed box with two layers. The video layer hosts the one and
 * only YouTube iframe of the app (it is never moved or re-created: swapping is a CSS visibility toggle, so the
 * layout does not shift, no second iframe exists and the focus is not touched); the cover layer shows the album
 * cover, or a neutral placeholder so the box is never empty.
 */
export function PictureBox({ mode, candidates, songKey, videoTitle, onYtMount }: PictureBoxProps) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const slotRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setFailed(new Set()); }, [songKey]);

  const setSlot = useCallback((el: HTMLDivElement | null) => {
    slotRef.current = el;
    onYtMount(el);
  }, [onYtMount]);

  // The IFrame API creates the iframe after the slot exists (and may re-create it): give it its title every time.
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return undefined;
    const apply = () => slot.querySelectorAll('iframe').forEach((f) => f.setAttribute('title', videoTitle));
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(slot, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [videoTitle]);

  const cover = pickCover(candidates, failed);

  return (
    <div className={`player-car-picture${mode === 'video' ? ' is-video' : ' is-cover'}`} data-mode={mode}>
      <div className={`player-car-picture-cover${cover ? '' : ' empty'}`} aria-hidden>
        {cover ? (
          <img
            src={cover}
            alt=""
            onError={() => setFailed((prev) => new Set(prev).add(cover))}
          />
        ) : (
          <span>🎵</span>
        )}
      </div>
      <div
        className="player-yt-slot player-car-picture-video"
        ref={setSlot}
        aria-hidden={mode !== 'video'}
      />
    </div>
  );
}
