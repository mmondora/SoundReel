import { useLanguage } from '../../i18n';
import type { RecentPlay } from '../../types';
import { formatClock } from '../../utils/statsView';

/** The latest plays: when, what, who, on which device, how long, and whether it counted or was a skip. */
export function RecentPlays({ plays, showUser }: { plays: readonly RecentPlay[]; showUser: boolean }) {
  const { t, language } = useLanguage();
  const locale = language === 'it' ? 'it-IT' : 'en-GB';
  const when = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
  };
  return (
    <section className="stats-card stats-card-wide" aria-labelledby="stats-recent-title">
      <h2 id="stats-recent-title">{t.statsRecent}</h2>
      {plays.length === 0 ? (
        <p className="stats-empty-line">{t.statsRankEmpty}</p>
      ) : (
        <div className="stats-table-wrap">
          <table className="stats-table stats-recent">
            <thead>
              <tr>
                <th scope="col">{t.statsColWhen}</th>
                <th scope="col">{t.statsColSong}</th>
                {showUser && <th scope="col">{t.statsColUser}</th>}
                <th scope="col">{t.statsColDevice}</th>
                <th scope="col">{t.statsColListened}</th>
                <th scope="col">{t.statsColCounts}</th>
              </tr>
            </thead>
            <tbody>
              {plays.map((p) => (
                <tr key={p.id}>
                  <td>{when(p.startedAt)}</td>
                  <td>{p.title}{p.artist ? ` — ${p.artist}` : ''}</td>
                  {showUser && <td>{p.user ?? '—'}</td>}
                  <td>{p.device ?? p.origin ?? '—'}</td>
                  <td>{formatClock(p.listenedMs)}</td>
                  <td>{p.counted === null ? '—' : p.counted ? t.statsCounted : t.statsSkipped}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
