import { useLanguage } from '../../i18n';
import type { ListeningStats } from '../../types';
import { formatListened } from '../../utils/statsView';

/** The headline numbers. A real description list: each tile is a term and its value. */
export function StatsTotals({ stats }: { stats: ListeningStats }) {
  const { t } = useLanguage();
  const { totals } = stats;
  const tiles: Array<{ id: string; label: string; value: string; hint?: string }> = [
    { id: 'plays', label: t.statsPlays, value: String(totals.plays) },
    { id: 'skips', label: t.statsSkips, value: String(totals.skips) },
    { id: 'listened', label: t.statsListened, value: formatListened(totals.listenedMs) },
    { id: 'songs', label: t.statsSongs, value: String(totals.songs) },
    { id: 'artists', label: t.statsArtists, value: String(totals.artists) },
    { id: 'devices', label: t.statsDevices, value: String(totals.devices) },
    { id: 'never', label: t.statsNeverPlayed, value: String(stats.neverPlayed), hint: t.statsNeverPlayedHint },
  ];
  return (
    <section aria-labelledby="stats-totals-title">
      <h2 id="stats-totals-title" className="sr-only">{t.statsTotals}</h2>
      <dl className="stats-tiles">
        {tiles.map((tile) => (
          <div key={tile.id} className="stats-tile" data-tile={tile.id}>
            <dt>{tile.label}</dt>
            <dd>{tile.value}</dd>
            {tile.hint && <dd className="stats-tile-hint">{tile.hint}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}
