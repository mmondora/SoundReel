/**
 * The RULE of a dynamic playlist: its shape, validation, readable summary and presets. Pure (no database), so the
 * playlist service can use it without pulling in the evaluator. Contract: docs/mondrop-stats.md §4, ADR-0008.
 */
import { canonicalGenres } from '../utils/genres';

/**
 * `newest` is the odd one out: it does not look at what was HEARD, only at the library: the songs that match (the genre, if the rule has one),
 * the last added first. It is what the automatic playlist of a genre is («Soul da ascoltare» = every song with the tag soul; Michele, 10
 * November, ADR-0024); the other orders rank by listening.
 */
export type DynamicOrder = 'most_played' | 'least_played' | 'recent' | 'never_played' | 'newest';
export type DynamicScope = 'me' | 'family';

export interface DynamicWindow {
  /** "HH:MM", local time of the listening. from > to crosses midnight; from === to means the whole day. */
  from: string;
  to: string;
  /** ISO weekdays (1 = Monday … 7 = Sunday) of the listening itself; absent = every day. */
  days?: number[];
}

export interface DynamicRule {
  v: 1;
  scope: DynamicScope;
  period: { days: number } | 'all';
  window?: DynamicWindow;
  order: DynamicOrder;
  limit: number;
  minPlays: number;
  /** Canonical genre names ("tipo" of music). */
  genres?: string[];
  downloadedOnly: boolean;
}

export type RuleResult = { ok: true; rule: DynamicRule } | { ok: false; error: string };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ORDERS: ReadonlySet<string> = new Set(['most_played', 'least_played', 'recent', 'never_played', 'newest']);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Validate a rule from a client and fill in the defaults. Errors are `invalid_rule:<field>`. */
export function parseRule(raw: unknown): RuleResult {
  const fail = (field: string): RuleResult => ({ ok: false, error: `invalid_rule:${field}` });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'rule_required' };
  const o = raw as Record<string, unknown>;

  if (o.v !== undefined && o.v !== 1) return fail('v');
  const scope = o.scope === undefined ? 'me' : o.scope;
  if (scope !== 'me' && scope !== 'family') return fail('scope');

  let period: DynamicRule['period'] = { days: 30 };
  if (o.period !== undefined) {
    if (o.period === 'all') period = 'all';
    else if (o.period && typeof o.period === 'object' && isInt((o.period as { days?: unknown }).days, 1, 3650)) {
      period = { days: (o.period as { days: number }).days };
    } else return fail('period');
  }

  let window: DynamicWindow | undefined;
  if (o.window !== undefined && o.window !== null) {
    const w = o.window as Record<string, unknown>;
    if (typeof o.window !== 'object' || Array.isArray(o.window)) return fail('window');
    if (typeof w.from !== 'string' || !TIME_RE.test(w.from)) return fail('window.from');
    if (typeof w.to !== 'string' || !TIME_RE.test(w.to)) return fail('window.to');
    let days: number[] | undefined;
    if (w.days !== undefined && w.days !== null) {
      if (!Array.isArray(w.days) || !w.days.every((d) => isInt(d, 1, 7))) return fail('window.days');
      days = [...new Set(w.days as number[])].sort((a, b) => a - b);
      if (days.length === 0 || days.length === 7) days = undefined; // none given / every day = no restriction
    }
    // a window that is the whole day and every day restricts nothing
    window = w.from === w.to && !days ? undefined : { from: w.from, to: w.to, ...(days ? { days } : {}) };
  }

  const order = o.order === undefined ? 'most_played' : o.order;
  if (typeof order !== 'string' || !ORDERS.has(order)) return fail('order');
  const limit = o.limit === undefined ? 50 : o.limit;
  if (!isInt(limit, 1, 200)) return fail('limit');
  const minPlays = o.minPlays === undefined ? 1 : o.minPlays;
  if (!isInt(minPlays, 1, 1000)) return fail('minPlays');

  let genres: string[] | undefined;
  if (o.genres !== undefined && o.genres !== null) {
    if (!Array.isArray(o.genres) || o.genres.length > 20 || !o.genres.every((g) => typeof g === 'string' && g.trim().length <= 60)) {
      return fail('genres');
    }
    const canon = canonicalGenres(o.genres as string[]);
    genres = canon.length > 0 ? canon : undefined;
  }
  const downloadedOnly = o.downloadedOnly === undefined ? false : o.downloadedOnly;
  if (typeof downloadedOnly !== 'boolean') return fail('downloadedOnly');

  return {
    ok: true,
    rule: {
      v: 1,
      scope,
      period,
      ...(window ? { window } : {}),
      order: order as DynamicOrder,
      limit,
      minPlays,
      ...(genres ? { genres } : {}),
      downloadedOnly,
    },
  };
}

// ---------------------------------------------------------------------------
// Readable summary
// ---------------------------------------------------------------------------

const ORDER_LABEL: Record<DynamicOrder, string> = {
  most_played: 'Più ascoltate',
  least_played: 'Meno ascoltate',
  recent: 'Ascoltate di recente',
  never_played: 'Mai ascoltate',
  newest: 'Aggiunte di recente',
};
const DAY_SHORT = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];

function daysLabel(days: number[]): string {
  const key = days.join(',');
  if (key === '1,2,3,4,5') return 'lun–ven';
  if (key === '6,7') return 'weekend';
  return days.map((d) => DAY_SHORT[d - 1]).join(', ');
}

/** "Più ascoltate · 07:00–08:00 (lun–ven) · ultimi 30 giorni · Rock, Jazz · max 50" */
export function ruleSummary(rule: DynamicRule): string {
  if (rule.order === 'newest') {
    // it does not look at what was heard: no window, no period, no family in the words
    return [ORDER_LABEL.newest, rule.genres?.length ? rule.genres.join(', ') : '', rule.downloadedOnly ? 'solo scaricate' : '', `max ${rule.limit}`]
      .filter(Boolean)
      .join(' · ');
  }
  const parts: string[] = [ORDER_LABEL[rule.order]];
  if (rule.order !== 'never_played' && rule.window) {
    const w = rule.window;
    const time = w.from === w.to ? '' : `${w.from}–${w.to}`;
    const days = w.days ? daysLabel(w.days) : '';
    parts.push([time, days && (time ? `(${days})` : days)].filter(Boolean).join(' '));
  }
  parts.push(rule.period === 'all' ? 'da sempre' : rule.period.days === 1 ? 'ultime 24 ore' : `ultimi ${rule.period.days} giorni`);
  if (rule.scope === 'family') parts.push('tutta la famiglia');
  if (rule.genres?.length) parts.push(rule.genres.join(', '));
  if (rule.downloadedOnly) parts.push('solo scaricate');
  parts.push(`max ${rule.limit}`);
  return parts.filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const base = { v: 1 as const, scope: 'me' as const, minPlays: 1, downloadedOnly: false };

export const PRESETS: ReadonlyArray<{ id: string; label: string; rule: DynamicRule }> = [
  { id: 'night', label: 'Più ascoltate di notte', rule: { ...base, period: { days: 90 }, window: { from: '22:00', to: '06:00' }, order: 'most_played', limit: 50 } },
  { id: 'morning', label: 'Mattina (7–8)', rule: { ...base, period: { days: 30 }, window: { from: '07:00', to: '08:00' }, order: 'most_played', limit: 50 } },
  { id: 'lunch', label: 'Pausa pranzo (12–14)', rule: { ...base, period: { days: 60 }, window: { from: '12:00', to: '14:00' }, order: 'most_played', limit: 50 } },
  { id: 'evening', label: 'Sera (18–22)', rule: { ...base, period: { days: 60 }, window: { from: '18:00', to: '22:00' }, order: 'most_played', limit: 50 } },
  { id: 'weekend', label: 'Weekend', rule: { ...base, period: { days: 60 }, window: { from: '00:00', to: '00:00', days: [6, 7] }, order: 'most_played', limit: 50 } },
  { id: 'last-month', label: 'Più ascoltate dell’ultimo mese', rule: { ...base, period: { days: 30 }, order: 'most_played', limit: 50 } },
  { id: 'recent', label: 'Ascoltate di recente', rule: { ...base, period: { days: 14 }, order: 'recent', limit: 30 } },
  { id: 'never-played', label: 'Mai ascoltate', rule: { ...base, period: 'all', order: 'never_played', limit: 100 } },
  { id: 'family-week', label: 'Famiglia: top della settimana', rule: { ...base, scope: 'family', period: { days: 7 }, order: 'most_played', limit: 50 } },
];
