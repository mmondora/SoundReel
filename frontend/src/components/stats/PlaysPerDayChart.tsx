import { useEffect, useRef } from 'react';
import { interpolate, useLanguage } from '../../i18n';
import type { ListeningDay } from '../../types';
import { fillDays, formatListened, maxOf } from '../../utils/statsView';

const W = 720;
const H = 190;
const PAD = { left: 34, right: 6, top: 10, bottom: 24 };

function dayLabel(day: string, locale: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Plays per day as bars (inline SVG). The data table sits behind the chart for screen readers and for the exact numbers. */
export function PlaysPerDayChart({ days }: { days: readonly ListeningDay[] }) {
  const { t, language } = useLanguage();
  const locale = language === 'it' ? 'it-IT' : 'en-GB';
  const scrollRef = useRef<HTMLDivElement>(null);
  const filled = fillDays(days);
  // On a narrow screen the chart scrolls: show the most recent days first (the right edge).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [days]);
  const max = maxOf(filled.map((d) => d.plays));
  const total = filled.reduce((n, d) => n + d.plays, 0);
  const summary = interpolate(t.statsPerDaySummary, { days: filled.length, plays: total, max });

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const step = filled.length > 0 ? innerW / filled.length : innerW;
  const barW = Math.max(step * 0.78, 0.8);
  const ticks = filled.length === 0 ? [] : [0, Math.floor((filled.length - 1) / 2), filled.length - 1].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <section className="stats-card" aria-labelledby="stats-perday-title">
      <h2 id="stats-perday-title">{t.statsPerDay}</h2>
      <p className="stats-caption" aria-hidden>{summary}</p>
      <div ref={scrollRef} className="stats-chart-scroll" role="group" aria-label={t.statsPerDay} tabIndex={0}>
      <svg
        className="stats-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={summary}
      >
        {[0, 0.5, 1].map((f) => {
          const y = PAD.top + innerH * (1 - f);
          return (
            <g key={f}>
              <line className="stats-grid" x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} />
              {f > 0 && <text className="stats-axis" x={PAD.left - 4} y={y + 3} textAnchor="end">{Math.round(max * f)}</text>}
            </g>
          );
        })}
        <text className="stats-axis" x={PAD.left - 4} y={PAD.top + innerH + 3} textAnchor="end">0</text>
        {filled.map((d, i) => {
          const h = max > 0 ? (d.plays / max) * innerH : 0;
          if (h <= 0) return null;
          return (
            <rect
              key={d.day}
              className="stats-bar-rect"
              x={PAD.left + i * step + (step - barW) / 2}
              y={PAD.top + innerH - h}
              width={barW}
              height={h}
              rx={Math.min(2, barW / 2)}
            >
              <title>{interpolate(t.statsDayTip, { day: dayLabel(d.day, locale), plays: d.plays, time: formatListened(d.listenedMs) })}</title>
            </rect>
          );
        })}
        {ticks.map((i) => (
          <text
            key={filled[i].day}
            className="stats-axis"
            x={PAD.left + i * step + step / 2}
            y={H - 6}
            textAnchor={i === 0 ? 'start' : i === filled.length - 1 ? 'end' : 'middle'}
          >
            {dayLabel(filled[i].day, locale)}
          </text>
        ))}
      </svg>
      </div>
      <details className="stats-table-toggle">
        <summary>{t.statsTable}</summary>
        <div className="stats-table-wrap">
          <table className="stats-table">
            <caption className="sr-only">{t.statsPerDay}</caption>
            <thead>
              <tr><th scope="col">{t.statsColDay}</th><th scope="col">{t.statsPlays}</th><th scope="col">{t.statsListened}</th></tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day}><th scope="row">{d.day}</th><td>{d.plays}</td><td>{formatListened(d.listenedMs)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
