/**
 * The words of the Mondrop inbox (spec IN5): the same data the Telegram reply carries (headline, summary, counts, the
 * entry's link), plus the playlist when one was chosen. Pure functions: no database, no clock, no network.
 */
import type { Entry } from '../types';
import { FAMILY_DISPLAY, type FamilyUserId } from '../utils/requestUser';
import { entryTitle } from '../utils/entryLinks';

export interface EntryCounts {
  songs: number;
  films: number;
  notes: number;
  software: number;
  links: number;
  tags: number;
}

export interface EntryDigest {
  title: string;
  summary: string | null;
  counts: EntryCounts;
  host: string | null;
}

export interface PlaylistOutcome {
  id: string;
  name: string;
  /** Songs put into the playlist by this share (0 when they were all there already). */
  added: number;
}

const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** What an entry looks like to a person: its headline, a one-line summary and what it contains. */
export function digestEntry(entry: Pick<Entry, 'caption' | 'sourceUrl' | 'results'>): EntryDigest {
  const results = entry.results as unknown as Record<string, unknown>;
  const summary = typeof results.summary === 'string' && results.summary.trim() ? results.summary.trim() : null;
  return {
    title: entryTitle({ caption: entry.caption, summary, sourceUrl: entry.sourceUrl }),
    summary,
    counts: {
      songs: len(results.songs),
      films: len(results.films),
      notes: len(results.notes),
      software: len(results.software),
      links: len(results.links),
      tags: len(results.tags),
    },
    host: hostOf(entry.sourceUrl),
  };
}

/** «2 canzoni, 1 film, 3 note, 2 software» — empty when there is nothing to count. */
export function countsLine(c: Pick<EntryCounts, 'songs' | 'films' | 'notes' | 'software'>): string {
  const parts: string[] = [];
  if (c.songs > 0) parts.push(c.songs === 1 ? '1 canzone' : `${c.songs} canzoni`);
  if (c.films > 0) parts.push(`${c.films} film`);
  if (c.notes > 0) parts.push(c.notes === 1 ? '1 nota' : `${c.notes} note`);
  if (c.software > 0) parts.push(`${c.software} software`);
  return parts.join(', ');
}

function snippet(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function playlistPhrase(p: PlaylistOutcome, songs: number): string {
  if (songs === 0) return `nessuna canzone per «${p.name}»`;
  if (p.added <= 0) return `già in «${p.name}»`;
  // all of them: «aggiunte a …»; only some (the rest was there already): say how many
  if (p.added >= songs) return `${songs === 1 ? 'aggiunta' : 'aggiunte'} a «${p.name}»`;
  return `${p.added} ${p.added === 1 ? 'aggiunta' : 'aggiunte'} a «${p.name}»`;
}

export interface ShareNotice {
  title: string;
  body: string;
  data: Record<string, unknown>;
}

/** The outcome of one of MY shares, like Telegram's reply: headline, summary, counts, and the playlist if chosen. */
export function composeShareResult(digest: EntryDigest, playlist: PlaylistOutcome | null = null): ShareNotice {
  const counts = countsLine(digest.counts);
  const lines: string[] = [];
  if (digest.summary && digest.summary !== digest.title) lines.push(snippet(digest.summary, 160));
  const tail = [counts, playlist ? playlistPhrase(playlist, digest.counts.songs) : ''].filter(Boolean).join(' · ');
  if (tail) lines.push(tail);
  if (lines.length === 0) lines.push('Salvato in libreria.');
  return {
    title: digest.title,
    body: lines.join('\n'),
    data: {
      songs: digest.counts.songs,
      films: digest.counts.films,
      notes: digest.counts.notes,
      software: digest.counts.software,
      tags: digest.counts.tags,
      ...(playlist ? { playlist: { id: playlist.id, name: playlist.name, added: playlist.added } } : {}),
    },
  };
}

/** The notice to somebody an entry was shared with. */
export function composeShareReceived(from: string, digest: EntryDigest): ShareNotice {
  const name = FAMILY_DISPLAY[from as FamilyUserId] ?? from;
  const counts = countsLine(digest.counts);
  return {
    title: `${name} ha condiviso con te`,
    body: [digest.title, counts].filter(Boolean).join('\n'),
    data: { from, songs: digest.counts.songs, films: digest.counts.films, notes: digest.counts.notes, software: digest.counts.software },
  };
}

export type ShareErrorReason =
  | 'analysis_failed'
  | 'instagram_session'
  | 'ai_output_unusable'
  | 'shazam_unreadable'
  | 'playlist_not_found'
  | 'playlist_dynamic'
  | 'playlist_read_only';

/** What the share carried: sending the same link again with these reproduces it, from any device. */
export interface ShareOptions {
  playlistId?: string;
  shareWith?: string[];
  comment?: string;
}

export interface ShareErrorContext {
  sourceUrl: string;
  host?: string | null;
  options?: ShareOptions;
  /** The server keeps trying by itself: the error closes when the link finally goes through. */
  retrying?: boolean;
}

const PLAYLIST_TAIL = 'Il link è comunque in libreria.';

/** An error stays until the user removes it or the same link later succeeds, so the words must say what to do. */
export function composeShareError(reason: ShareErrorReason, ctx: ShareErrorContext): ShareNotice {
  const where = ctx.host ? ` (${ctx.host})` : '';
  let title: string;
  let body: string;
  switch (reason) {
    case 'instagram_session':
      title = 'Instagram non risponde';
      body = "Instagram richiede una nuova autorizzazione. Riprovo da solo: può volerci un po'.";
      break;
    case 'ai_output_unusable':
      title = 'Analisi non riuscita';
      body = `Non sono riuscito a leggere il contenuto${where}. Puoi riprovare.`;
      break;
    case 'shazam_unreadable':
      title = 'Shazam non leggibile';
      body = 'Non riesco a leggere la pagina di Shazam. Rimanda il link per riprovare.';
      break;
    case 'playlist_not_found':
      title = 'Playlist non valida';
      body = `La playlist scelta non esiste più. ${PLAYLIST_TAIL}`;
      break;
    case 'playlist_dynamic':
      title = 'Playlist non valida';
      body = `La playlist scelta è dinamica: non accetta brani a mano. ${PLAYLIST_TAIL}`;
      break;
    case 'playlist_read_only':
      title = 'Playlist non valida';
      body = `La playlist scelta non è tua: è in sola lettura. ${PLAYLIST_TAIL}`;
      break;
    default:
      title = 'Analisi non riuscita';
      body = `Non sono riuscito a leggere il link${where}. Puoi riprovare.`;
  }
  const options = ctx.options && Object.keys(ctx.options).length > 0 ? ctx.options : undefined;
  return {
    title,
    body,
    data: {
      reason,
      sourceUrl: ctx.sourceUrl,
      ...(ctx.retrying ? { retrying: true } : {}),
      ...(options ? { options } : {}),
    },
  };
}
