import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { SegmentedControl } from '../components/SegmentedControl';
import { Heatmap } from '../components/stats/Heatmap';
import { PlaysPerDayChart } from '../components/stats/PlaysPerDayChart';
import { RankList } from '../components/stats/RankList';
import { RecentPlays } from '../components/stats/RecentPlays';
import { StatsTotals } from '../components/stats/Totals';
import { useListeningStats } from '../hooks/useListeningStats';
import { interpolate, useLanguage } from '../i18n';
import { fetchMe } from '../services/api';
import type { ListeningRank, MeResponse } from '../types';
import {
  buildStatsQuery,
  DEFAULT_STATS_FILTERS,
  isEmptyStats,
  PERIODS,
  statsScopeOptions,
} from '../utils/statsView';
import type { StatsFilters, StatsPeriod, StatsViewer } from '../utils/statsView';
import '../styles/stats.css';

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Global listening dashboard (spec 2026-11-07, §6). Everybody sees their own numbers; an admin can widen it. */
export function StatsPage() {
  const { t } = useLanguage();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [filters, setFilters] = useState<StatsFilters>(DEFAULT_STATS_FILTERS);
  const [knownDevices, setKnownDevices] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((m) => {
        if (!cancelled) setMe(m);
      })
      .catch(() => undefined); // anonymous or offline: the page works as a plain user
    return () => {
      cancelled = true;
    };
  }, []);

  const viewer = useMemo<StatsViewer | null>(() => (me ? { user: me.user, isAdmin: me.isAdmin } : null), [me]);
  const isAdmin = viewer?.isAdmin === true;
  const tz = useMemo(browserTimeZone, []);
  // `new Date()` is read when the filters change: "today" is the day the filters were set.
  const query = useMemo(() => buildStatsQuery(filters, viewer, new Date(), tz), [filters, viewer, tz]);
  const { stats, recent, loading, error, reload } = useListeningStats(query);

  // Remember the devices ever seen so the device filter keeps its options after it narrows the result.
  useEffect(() => {
    if (!stats) return;
    const seen = stats.perDevice.map((d) => d.key).filter((k) => k !== '');
    if (seen.length === 0) return;
    setKnownDevices((prev) => {
      const merged = Array.from(new Set([...prev, ...seen])).sort((a, b) => a.localeCompare(b));
      return merged.length === prev.length && merged.every((d, i) => d === prev[i]) ? prev : merged;
    });
  }, [stats]);

  const users = useMemo(() => {
    if (!me) return [];
    const list = [{ id: me.user, displayName: me.displayName }, ...me.family];
    const seen = new Set<string>();
    return list.filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)));
  }, [me]);

  const scopeOptions = statsScopeOptions(viewer);
  const showAll = isAdmin && filters.scope === 'all';
  const deviceChoices = filters.device && !knownDevices.includes(filters.device) ? [...knownDevices, filters.device] : knownDevices;

  const subtitle = showAll
    ? filters.user
      ? interpolate(t.statsSubtitleUser, { user: users.find((u) => u.id === filters.user)?.displayName ?? filters.user })
      : t.statsSubtitleAll
    : t.statsSubtitleMe;

  const originLabel = (item: ListeningRank): string => {
    switch (item.key) {
      case 'local': return t.statsOriginLocal;
      case 'stream': return t.statsOriginStream;
      case 'web': return t.statsOriginWeb;
      default: return item.label;
    }
  };

  return (
    <div className="list-page stats-page">
      <main className="stats-content" aria-busy={loading}>
        <div className="list-page-header">
          <Link to="/" className="list-page-back">{t.back}</Link>
          <h1>{t.statsTitle}</h1>
        </div>
        <p className="stats-subtitle">{subtitle}</p>

        <div className="stats-controls">
          <SegmentedControl<StatsPeriod>
            label={t.statsPeriod}
            showLabel
            value={filters.period}
            options={PERIODS.map((p) => ({
              value: p,
              label: p === 'all' ? t.statsPeriodAll : interpolate(t.statsPeriodDays, { n: p }),
            }))}
            onChange={(period) => setFilters((f) => ({ ...f, period }))}
          />

          {scopeOptions.length > 1 && (
            <SegmentedControl<'me' | 'all'>
              label={t.statsScope}
              showLabel
              value={filters.scope}
              options={[
                { value: 'me', label: t.statsScopeMe },
                { value: 'all', label: t.statsScopeAll },
              ]}
              onChange={(scope) => setFilters((f) => ({ ...f, scope, user: scope === 'all' ? f.user : '' }))}
            />
          )}

          {isAdmin && showAll && (
            <label className="stats-field">
              <span>{t.statsUser}</span>
              <select value={filters.user} onChange={(e) => setFilters((f) => ({ ...f, user: e.target.value }))}>
                <option value="">{t.statsAllUsers}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.displayName}</option>
                ))}
              </select>
            </label>
          )}

          {isAdmin && (
            <label className="stats-field">
              <span>{t.statsDevice}</span>
              <select value={filters.device} onChange={(e) => setFilters((f) => ({ ...f, device: e.target.value }))}>
                <option value="">{t.statsAllDevices}</option>
                {deviceChoices.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </label>
          )}

          <button type="button" className="stats-reload" onClick={() => void reload()} disabled={loading}>
            {t.statsReload}
          </button>
        </div>

        <div className="stats-status" role="status" aria-live="polite">
          {loading && !stats ? <><span className="spinner" aria-hidden /> {t.statsLoading}</> : null}
        </div>

        {error && (
          <div className="stats-error" role="alert">
            <strong>{t.statsError}</strong>
            <span>{error}</span>
            <button type="button" className="stats-reload" onClick={() => void reload()}>{t.statsReload}</button>
          </div>
        )}

        {stats && isEmptyStats(stats) && (
          <section className="stats-empty" aria-labelledby="stats-empty-title">
            <h2 id="stats-empty-title">{t.statsEmptyTitle}</h2>
            <p>{t.statsEmptyBody}</p>
            {stats.neverPlayed > 0 && <p className="stats-empty-never">{interpolate(t.statsEmptyNever, { n: stats.neverPlayed })}</p>}
          </section>
        )}

        {stats && !isEmptyStats(stats) && (
          <div className={`stats-body${loading ? ' stats-stale' : ''}`}>
            <StatsTotals stats={stats} />
            <div className="stats-grid-2">
              <PlaysPerDayChart days={stats.perDay} />
              <Heatmap grid={stats.heatmap} />
            </div>
            <div className="stats-grid-3">
              <RankList title={t.statsTopSongs} items={stats.topSongs} />
              <RankList title={t.statsTopArtists} items={stats.topArtists} />
              <RankList title={t.statsTopGenres} items={stats.topGenres} />
            </div>
            <div className="stats-grid-2">
              <RankList title={t.statsPerDevice} items={stats.perDevice} />
              <RankList title={t.statsPerOrigin} items={stats.perOrigin} labelOf={originLabel} />
            </div>
            <RecentPlays plays={recent} showUser={showAll} />
          </div>
        )}
      </main>
    </div>
  );
}
