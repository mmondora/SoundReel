/**
 * How an entry is named and linked to the people who read about it (Telegram, the Mondrop inbox).
 * One place, so the headline of a Telegram message and the title of an inbox item can never drift apart.
 */

/** The page of one entry on the SoundReel site. */
export function entryUrl(entryId: string): string {
  const base = process.env.FRONTEND_URL || 'https://soundreel.casamon.dev';
  return `${base.replace(/\/$/, '')}/?entry=${entryId}`;
}

export interface TitleSource {
  caption?: string | null;
  /** The AI summary (any length: the title takes its start). */
  summary?: string | null;
  sourceUrl?: string | null;
}

/**
 * The headline of an entry: the first line of its caption, else the start of the summary, else the site it came
 * from, else "SoundReel". Same rule the Telegram reply has always used.
 */
export function entryTitle(source: TitleSource): string {
  const caption = source.caption?.split(/\r?\n/)[0]?.trim();
  if (caption && caption.length > 0) return caption.slice(0, 90);
  if (source.summary) return source.summary.slice(0, 80);
  if (source.sourceUrl) {
    try {
      return new URL(source.sourceUrl).hostname.replace(/^www\./, '');
    } catch {
      return 'SoundReel';
    }
  }
  return 'SoundReel';
}
