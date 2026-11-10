/**
 * The creation date of a playlist, as it is written beside its name (ADR-0023, Michele: «di fianco al nome la data di creazione»):
 * «oggi», «ieri», «10 nov» for this year, «10 nov 2025» for an older one. An unreadable date is no text at all, never «Invalid Date».
 */
export function formatPlaylistDate(
  iso: string | null | undefined,
  language: string,
  labels: { today: string; yesterday: string },
  now: Date = new Date(),
): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (date.toDateString() === now.toDateString()) return labels.today.toLowerCase();
  const before = new Date(now);
  before.setDate(before.getDate() - 1);
  if (date.toDateString() === before.toDateString()) return labels.yesterday.toLowerCase();
  return date.toLocaleDateString(language === 'it' ? 'it-IT' : 'en-US', {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

/** The full date, for the tooltip of the short one. */
export function fullPlaylistDate(iso: string | null | undefined, language: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(language === 'it' ? 'it-IT' : 'en-US', { dateStyle: 'long', timeStyle: 'short' });
}
