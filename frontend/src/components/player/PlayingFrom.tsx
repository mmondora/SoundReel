import { useLanguage } from '../../i18n';
import { usePlayer } from '../../player/PlayerContext';
import '../../styles/player.css';

/**
 * Where the song in play is REALLY coming from (rule W5): the media server, the home disk or Internet (YouTube).
 * Not where the file is (that is the FS/MS badge): a song that is on the media server still says "Internet" when
 * the switch asked for it. Nothing while it is being decided.
 */
export function PlayingFrom({ compact = false }: { compact?: boolean }) {
  const { t } = useLanguage();
  const { playingFrom } = usePlayer();
  if (!playingFrom) return null;
  const label =
    playingFrom === 'media-server' ? t.sourceFromMedia
      : playingFrom === 'disk' ? t.sourceFromDisk
        : t.sourceFromYoutube;
  return (
    <span className={`from-chip from-chip-${playingFrom}`} data-from={playingFrom} title={`${t.sourcePlayingFrom}: ${label}`}>
      {!compact && <span className="from-chip-k">{t.sourcePlayingFrom}</span>}
      <span className="from-chip-v">{label}</span>
    </span>
  );
}
