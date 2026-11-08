import { useLanguage } from '../../i18n';
import type { ListeningRank } from '../../types';
import { countLabel } from '../../utils/managerSongs';
import { formatListened, maxOf } from '../../utils/statsView';

export interface RankListProps {
  title: string;
  items: readonly ListeningRank[];
  /** How many rows to show (the backend may send more). */
  limit?: number;
  /** Turns a raw key (an origin id) into words. */
  labelOf?: (item: ListeningRank) => string;
}

/** A ranked list with a bar behind each row. It is a real <ol>, so it reads fine without the bars. */
export function RankList({ title, items, limit = 10, labelOf }: RankListProps) {
  const { t } = useLanguage();
  const shown = items.slice(0, limit);
  const max = maxOf(shown.map((i) => i.plays));
  return (
    <section className="stats-card" aria-label={title}>
      <h2>{title}</h2>
      {shown.length === 0 ? (
        <p className="stats-empty-line">{t.statsRankEmpty}</p>
      ) : (
        <ol className="stats-rank">
          {shown.map((item) => (
            <li key={item.key}>
              <div className="stats-rank-text">
                <span className="stats-rank-label">{labelOf ? labelOf(item) : item.label}</span>
                {item.sublabel && <span className="stats-rank-sub"> — {item.sublabel}</span>}
              </div>
              <span className="stats-rank-value">
                {countLabel(item.plays, t.statsPlaysCount, t.statsPlaysOne)}
                {item.listenedMs ? ` · ${formatListened(item.listenedMs)}` : ''}
              </span>
              <span className="stats-rank-bar" aria-hidden>
                <span style={{ width: `${max > 0 ? Math.max(2, (item.plays / max) * 100) : 0}%` }} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
