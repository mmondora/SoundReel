/**
 * Dynamic playlist rules (docs/mondrop-stats.md §4): the form model of the rule editor, the conversion to and
 * from the wire rule, validation, and a readable summary. Pure, so the rules of the dialog are unit-tested
 * without rendering it.
 */
import type { DynamicOrder, DynamicRule } from '../types';

export const PERIOD_CHOICES = ['7', '30', '90', '365', 'all'] as const;
export const ORDERS: readonly DynamicOrder[] = ['most_played', 'least_played', 'recent', 'never_played'];
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 200;
export const DEFAULT_LIMIT = 50;
export const NAME_MAX = 80;

export interface RuleForm {
  /** Only used when creating (the name of an existing dynamic playlist cannot change). */
  name: string;
  scope: 'me' | 'family';
  /** '7' | '30' | '90' | '365' | 'all', or any other number of days a preset brought in. */
  period: string;
  windowEnabled: boolean;
  /** "HH:MM", local time of the listening. */
  from: string;
  to: string;
  /** ISO weekdays 1 = Monday … 7 = Sunday; empty = every day. */
  days: number[];
  genres: string[];
  order: DynamicOrder;
  /** Text field contents. */
  limit: string;
  minPlays: string;
  downloadedOnly: boolean;
}

export const DEFAULT_FORM: RuleForm = {
  name: '',
  scope: 'me',
  period: '30',
  windowEnabled: false,
  from: '07:00',
  to: '08:00',
  days: [],
  genres: [],
  order: 'most_played',
  limit: String(DEFAULT_LIMIT),
  minPlays: '1',
  downloadedOnly: false,
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isTime = (value: string): boolean => TIME_RE.test(value);

/** A window with `from` later than `to` runs through midnight (night: 22:00 → 06:00). */
export function crossesMidnight(from: string, to: string): boolean {
  return isTime(from) && isTime(to) && from > to;
}

function clampInt(text: string, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(text));
  if (!Number.isFinite(n) || text.trim() === '') return fallback;
  return Math.min(max, Math.max(min, n));
}

const uniqueSortedDays = (days: readonly number[]): number[] =>
  [...new Set(days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b);

export function ruleToForm(rule: DynamicRule | null | undefined, name = ''): RuleForm {
  if (!rule) return { ...DEFAULT_FORM, name };
  const window = rule.window;
  return {
    name,
    scope: rule.scope === 'family' ? 'family' : 'me',
    period: rule.period === 'all' ? 'all' : String(rule.period?.days ?? 30),
    windowEnabled: !!window,
    from: window?.from ?? DEFAULT_FORM.from,
    to: window?.to ?? DEFAULT_FORM.to,
    days: window?.days ? uniqueSortedDays(window.days) : [],
    genres: [...(rule.genres ?? [])],
    order: ORDERS.includes(rule.order) ? rule.order : 'most_played',
    limit: String(rule.limit ?? DEFAULT_LIMIT),
    minPlays: String(rule.minPlays ?? 1),
    downloadedOnly: rule.downloadedOnly === true,
  };
}

export function formToRule(form: RuleForm): DynamicRule {
  const rule: DynamicRule = {
    v: 1,
    scope: form.scope,
    period: form.period === 'all' ? 'all' : { days: clampInt(form.period, 1, 3650, 30) },
    order: form.order,
    limit: clampInt(form.limit, LIMIT_MIN, LIMIT_MAX, DEFAULT_LIMIT),
    minPlays: clampInt(form.minPlays, 0, 100000, 1),
    downloadedOnly: form.downloadedOnly,
  };
  // "never played" ignores the time window (the songs have no listening to place in a window).
  if (form.windowEnabled && form.order !== 'never_played') {
    const days = uniqueSortedDays(form.days);
    rule.window = { from: form.from, to: form.to, ...(days.length > 0 && days.length < 7 ? { days } : {}) };
  }
  if (form.genres.length > 0) rule.genres = [...form.genres];
  return rule;
}

export type RuleIssueCode = 'nameRequired' | 'nameTooLong' | 'limitRange' | 'minPlaysRange' | 'windowTime' | 'windowEmpty';

export interface RuleIssue {
  code: RuleIssueCode;
}

export function validateForm(form: RuleForm, opts: { needsName: boolean }): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (opts.needsName) {
    const name = form.name.trim();
    if (!name) issues.push({ code: 'nameRequired' });
    else if (name.length > NAME_MAX) issues.push({ code: 'nameTooLong' });
  }
  const limit = Number(form.limit);
  if (form.limit.trim() === '' || !Number.isInteger(limit) || limit < LIMIT_MIN || limit > LIMIT_MAX) {
    issues.push({ code: 'limitRange' });
  }
  const minPlays = Number(form.minPlays);
  if (form.order !== 'never_played' && (form.minPlays.trim() === '' || !Number.isInteger(minPlays) || minPlays < 0)) {
    issues.push({ code: 'minPlaysRange' });
  }
  if (form.windowEnabled && form.order !== 'never_played') {
    if (!isTime(form.from) || !isTime(form.to)) issues.push({ code: 'windowTime' });
    else if (form.from === form.to) issues.push({ code: 'windowEmpty' });
  }
  return issues;
}

/** Words the summary is built from (the dialog passes the translated ones). */
export interface RuleLabels {
  orders: Record<DynamicOrder, string>;
  /** "last {n} days" / "all time". */
  lastDays: (n: number) => string;
  allTime: string;
  /** Monday … Sunday. */
  daysShort: readonly string[];
  family: string;
  max: (n: number) => string;
  downloadedOnly: string;
  midnight: string;
}

/** One-line summary of a rule ("Più ascoltate · 07:00–08:00 · lun–ven · ultimi 30 giorni"), like the backend's. */
export function describeRule(rule: DynamicRule, l: RuleLabels): string {
  const parts: string[] = [l.orders[rule.order]];
  if (rule.window && rule.order !== 'never_played') {
    const { from, to, days } = rule.window;
    parts.push(`${from}–${to}${crossesMidnight(from, to) ? ` (${l.midnight})` : ''}`);
    if (days && days.length > 0 && days.length < 7) parts.push(uniqueSortedDays(days).map((d) => l.daysShort[d - 1]).join(' '));
  }
  parts.push(rule.period === 'all' ? l.allTime : l.lastDays(rule.period.days));
  if (rule.genres && rule.genres.length > 0) parts.push(rule.genres.join(', '));
  if (rule.scope === 'family') parts.push(l.family);
  if (rule.downloadedOnly) parts.push(l.downloadedOnly);
  parts.push(l.max(rule.limit));
  return parts.join(' · ');
}

/** The period values the select offers: the usual ones plus a preset's unusual one. */
export function periodOptions(current: string): string[] {
  const base: string[] = [...PERIOD_CHOICES];
  return base.includes(current) ? base : [...base.slice(0, -1), current, 'all'].sort(periodOrder);
}

function periodOrder(a: string, b: string): number {
  if (a === 'all') return 1;
  if (b === 'all') return -1;
  return Number(a) - Number(b);
}
