import { describe, expect, it } from 'vitest';
import { formatPlaylistDate, fullPlaylistDate } from './playlistDate';

const labels = { today: 'Oggi', yesterday: 'ieri' };
const now = new Date('2026-11-10T12:00:00');

describe('the creation date beside the name of a playlist', () => {
  it('says «oggi» and «ieri» (in the case of a sentence, whatever the label was)', () => {
    expect(formatPlaylistDate('2026-11-10T08:30:00', 'it', labels, now)).toBe('oggi');
    expect(formatPlaylistDate('2026-11-09T23:59:00', 'it', labels, now)).toBe('ieri');
  });

  it('writes day and month for this year, and the year too for an older one', () => {
    expect(formatPlaylistDate('2026-11-05T10:00:00', 'it', labels, now)).toBe('5 nov');
    expect(formatPlaylistDate('2025-12-24T10:00:00', 'it', labels, now)).toBe('24 dic 2025');
    expect(formatPlaylistDate('2026-11-05T10:00:00', 'en', { today: 'Today', yesterday: 'yesterday' }, now)).toBe('Nov 5');
  });

  it('an unreadable or missing date is no text, never «Invalid Date»', () => {
    expect(formatPlaylistDate('', 'it', labels, now)).toBe('');
    expect(formatPlaylistDate(undefined, 'it', labels, now)).toBe('');
    expect(formatPlaylistDate('not a date', 'it', labels, now)).toBe('');
    expect(fullPlaylistDate('not a date', 'it')).toBe('');
  });

  it('the tooltip has the full date and the hour', () => {
    expect(fullPlaylistDate('2026-11-05T10:15:00', 'it')).toMatch(/5 novembre 2026/);
  });
});
