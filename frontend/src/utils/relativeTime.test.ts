import { describe, expect, it } from 'vitest';
import { relativeTime } from './relativeTime';
import { translations } from '../i18n/translations';

// The «2 hours ago» of the cards (it used to live inside CompactCard; the wall of the posts needs it too).
const t = translations.en;
const NOW = Date.parse('2026-11-10T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
  it('under a minute is «just now»', () => {
    expect(relativeTime(ago(30_000), t, NOW)).toBe(t.justNow);
    expect(relativeTime(ago(0), t, NOW)).toBe(t.justNow);
  });

  it('minutes, then hours, then «yesterday», then days', () => {
    expect(relativeTime(ago(MIN), t, NOW)).toBe(t.minutesAgo.replace('{count}', '1'));
    expect(relativeTime(ago(59 * MIN), t, NOW)).toBe(t.minutesAgo.replace('{count}', '59'));
    expect(relativeTime(ago(HOUR), t, NOW)).toBe(t.hoursAgo.replace('{count}', '1'));
    expect(relativeTime(ago(23 * HOUR), t, NOW)).toBe(t.hoursAgo.replace('{count}', '23'));
    expect(relativeTime(ago(DAY), t, NOW)).toBe(t.yesterday);
    expect(relativeTime(ago(2 * DAY), t, NOW)).toBe(t.daysAgo.replace('{count}', '2'));
    expect(relativeTime(ago(29 * DAY), t, NOW)).toBe(t.daysAgo.replace('{count}', '29'));
  });

  it('a month or more is the date', () => {
    const old = ago(45 * DAY);
    expect(relativeTime(old, t, NOW)).toBe(old.toLocaleDateString());
    expect(relativeTime(ago(30 * DAY), t, NOW)).toBe(ago(30 * DAY).toLocaleDateString());
  });
});
