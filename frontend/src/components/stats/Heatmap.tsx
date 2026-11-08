import { interpolate, useLanguage } from '../../i18n';
import { heatLevel, heatmapPeak, maxOf } from '../../utils/statsView';

const CELL = 22;
const GAP = 2;
const LEFT = 34;
const TOP = 18;

const hourLabel = (h: number): string => `${String(h).padStart(2, '0')}:00`;

/** 7 weekdays × 24 local hours. Colour = number of plays; the numbers are in the table behind it. */
export function Heatmap({ grid }: { grid: readonly (readonly number[])[] }) {
  const { t } = useLanguage();
  const max = maxOf(grid.flat());
  const peak = heatmapPeak(grid);
  const width = LEFT + 24 * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);
  const summary = peak
    ? interpolate(t.statsHeatmapSummary, { day: t.dynDaysLong[peak.weekday], hour: hourLabel(peak.hour), n: peak.plays })
    : t.statsHeatmapNone;

  return (
    <section className="stats-card" aria-labelledby="stats-heatmap-title">
      <h2 id="stats-heatmap-title">{t.statsHeatmap}</h2>
      <p className="stats-caption" aria-hidden>{summary}</p>
      <div className="stats-chart-scroll" role="group" aria-label={t.statsHeatmap} tabIndex={0}>
      <svg className="stats-chart stats-heatmap" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
        {Array.from({ length: 8 }, (_, i) => i * 3).filter((h) => h < 24).map((h) => (
          <text key={h} className="stats-axis" x={LEFT + h * (CELL + GAP)} y={TOP - 6}>{String(h).padStart(2, '0')}</text>
        ))}
        {grid.slice(0, 7).map((row, d) => (
          <g key={d}>
            <text className="stats-axis" x={LEFT - 6} y={TOP + d * (CELL + GAP) + CELL / 2 + 3} textAnchor="end">{t.dynDaysShort[d]}</text>
            {row.slice(0, 24).map((value, h) => (
              <rect
                key={h}
                className={value > 0 ? 'stats-cell on' : 'stats-cell'}
                x={LEFT + h * (CELL + GAP)}
                y={TOP + d * (CELL + GAP)}
                width={CELL}
                height={CELL}
                rx={3}
                fillOpacity={value > 0 ? heatLevel(value, max) : 1}
              >
                <title>{interpolate(t.statsHeatmapTip, { day: t.dynDaysLong[d], hour: hourLabel(h), n: value })}</title>
              </rect>
            ))}
          </g>
        ))}
      </svg>
      </div>
      <details className="stats-table-toggle">
        <summary>{t.statsTable}</summary>
        <div className="stats-table-wrap">
          <table className="stats-table stats-table-heat">
            <caption className="sr-only">{t.statsHeatmap}</caption>
            <thead>
              <tr>
                <td />
                {Array.from({ length: 24 }, (_, h) => <th key={h} scope="col">{String(h).padStart(2, '0')}</th>)}
              </tr>
            </thead>
            <tbody>
              {grid.slice(0, 7).map((row, d) => (
                <tr key={d}>
                  <th scope="row">{t.dynDaysLong[d]}</th>
                  {row.slice(0, 24).map((v, h) => <td key={h}>{v}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
