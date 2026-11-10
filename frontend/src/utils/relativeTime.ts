import { interpolate } from '../i18n';
import type { Translations } from '../i18n/translations';

/** «just now», «5 minutes ago», «3 hours ago», «yesterday», «4 days ago»; a month or more is the date. */
export function relativeTime(date: Date, t: Translations, now: number = Date.now()): string {
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return t.justNow;
  if (minutes < 60) return interpolate(t.minutesAgo, { count: minutes });
  if (hours < 24) return interpolate(t.hoursAgo, { count: hours });
  if (days === 1) return t.yesterday;
  if (days < 30) return interpolate(t.daysAgo, { count: days });

  return date.toLocaleDateString();
}
