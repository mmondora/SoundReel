import { Link } from 'react-router-dom';
import { useLanguage } from '../i18n';
import type { SongVersionOf as VersionOf } from '../types';

/** Where the link to an original goes: the Songs page, filtered on its title. */
export function songSearchLink(title: string): string {
  return `/songs?q=${encodeURIComponent(title)}`;
}

/**
 * "Versione di «Titolo» · Slowed + Reverb": this song is a version of another one (instrumental, slowed, live, a remix…)
 * and stays its own card (spec 2026-11-08-no-duplicates-and-post-links §7, D5). The title links to the original when the
 * journal has exactly one; otherwise it is only a label. Renders nothing for a song that is not a version.
 */
export function SongVersionOf({ versionOf }: { versionOf: VersionOf | undefined }) {
  const { t } = useLanguage();
  if (!versionOf) return null;
  const labels = versionOf.labels.filter((label) => label.trim().length > 0);
  return (
    <div className="song-version-of" data-testid="song-version-of">
      <span>{t.versionOf} </span>
      {versionOf.songKey ? (
        <Link to={songSearchLink(versionOf.title)} title={versionOf.artist ?? undefined}>
          «{versionOf.title}»
        </Link>
      ) : (
        <span>«{versionOf.title}»</span>
      )}
      {labels.length > 0 && <span className="song-version-labels"> · {labels.join(' · ')}</span>}
    </div>
  );
}
