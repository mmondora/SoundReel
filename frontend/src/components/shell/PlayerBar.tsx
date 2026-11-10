import { useLanguage } from '../../i18n';
import { Controls, NowPlaying, Progress, RightTools } from './playerParts';

/**
 * The player of the shell, in its usual place: a bar that is always there, at the bottom (Michele, 10 November: «si, ma spostabile»: the bottom is
 * where it starts, the user can move it, ADR-0026). It SHOWS and drives what the player context already does (it replaces the old floating mini
 * player, with the same «Sorgente» switch, the place of the file and the first-play download); it never starts anything.
 */
export function PlayerBar() {
  const { t } = useLanguage();
  return (
    <section className="shell-bar" aria-label={t.shellPlayerLabel}>
      <NowPlaying />
      <Controls />
      <Progress />
      <RightTools />
    </section>
  );
}
