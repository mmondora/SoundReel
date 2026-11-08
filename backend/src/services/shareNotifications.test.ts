import { describe, expect, it } from 'vitest';
import {
  composeShareError,
  composeShareReceived,
  composeShareResult,
  countsLine,
  digestEntry,
  type EntryDigest,
  type ShareErrorReason,
} from './shareNotifications';

const entry = (over: Record<string, unknown> = {}, caption: string | null = null, sourceUrl = 'https://www.instagram.com/reel/abc') =>
  digestEntry({
    caption,
    sourceUrl,
    results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null, ...over },
  } as never);

const digest = (over: Partial<EntryDigest> = {}): EntryDigest => ({
  title: 'Cloudflare ha rilasciato una skill',
  summary: 'Una skill open source che trasforma un agente in un team di sicurezza.',
  counts: { songs: 2, films: 1, notes: 0, software: 0, links: 1, tags: 3 },
  host: 'instagram.com',
  ...over,
});

describe('digestEntry', () => {
  it('counts what the entry holds and names it like the Telegram reply does', () => {
    const d = entry(
      { songs: [{}, {}], films: [{}], notes: [{}, {}, {}], software: [{}], links: [{}], tags: ['a', 'b'], summary: ' Un riassunto. ' },
      'Prima riga\nseconda riga',
    );
    expect(d.title).toBe('Prima riga');
    expect(d.summary).toBe('Un riassunto.');
    expect(d.counts).toEqual({ songs: 2, films: 1, notes: 3, software: 1, links: 1, tags: 2 });
    expect(d.host).toBe('instagram.com');
  });

  it('falls back to the summary, then to the site, then to SoundReel', () => {
    expect(entry({ summary: 'Solo un riassunto' }).title).toBe('Solo un riassunto');
    expect(entry({}).title).toBe('instagram.com');
    expect(entry({}, null, 'not a url').title).toBe('SoundReel');
  });

  it('survives results without arrays or a summary that is not text', () => {
    const d = digestEntry({ caption: null, sourceUrl: 'https://x.it/a', results: { summary: 42 } } as never);
    expect(d.counts).toEqual({ songs: 0, films: 0, notes: 0, software: 0, links: 0, tags: 0 });
    expect(d.summary).toBeNull();
  });
});

describe('countsLine', () => {
  it.each([
    [{ songs: 1, films: 0, notes: 0, software: 0 }, '1 canzone'],
    [{ songs: 2, films: 1, notes: 0, software: 0 }, '2 canzoni, 1 film'],
    [{ songs: 0, films: 3, notes: 1, software: 2 }, '3 film, 1 nota, 2 software'],
    [{ songs: 5, films: 2, notes: 4, software: 1 }, '5 canzoni, 2 film, 4 note, 1 software'],
    [{ songs: 0, films: 0, notes: 0, software: 0 }, ''],
  ])('%j → "%s"', (counts, expected) => {
    expect(countsLine(counts)).toBe(expected);
  });
});

describe('composeShareResult', () => {
  it('says what Telegram says: headline, summary, counts', () => {
    const n = composeShareResult(digest());
    expect(n.title).toBe('Cloudflare ha rilasciato una skill');
    expect(n.body).toBe('Una skill open source che trasforma un agente in un team di sicurezza.\n2 canzoni, 1 film');
    expect(n.data).toMatchObject({ songs: 2, films: 1, notes: 0, software: 0, tags: 3 });
    expect(n.data).not.toHaveProperty('playlist');
  });

  it('adds the playlist, in the plural and in the singular', () => {
    const many = composeShareResult(digest(), { id: 'p1', name: 'Road trip', added: 2 });
    expect(many.body.split('\n').pop()).toBe('2 canzoni, 1 film · aggiunte a «Road trip»');
    expect(many.data.playlist).toEqual({ id: 'p1', name: 'Road trip', added: 2 });
    const one = composeShareResult(digest({ counts: { songs: 1, films: 0, notes: 0, software: 0, links: 0, tags: 0 } }), { id: 'p1', name: 'Road trip', added: 1 });
    expect(one.body.split('\n').pop()).toBe('1 canzone · aggiunta a «Road trip»');
  });

  it('says so when every song was already in the playlist', () => {
    const n = composeShareResult(digest(), { id: 'p1', name: 'Road trip', added: 0 });
    expect(n.body.split('\n').pop()).toBe('2 canzoni, 1 film · già in «Road trip»');
  });

  it('says so when the link held no song to put in the chosen playlist', () => {
    const none = { songs: 0, films: 1, notes: 0, software: 0, links: 0, tags: 0 };
    const n = composeShareResult(digest({ counts: none }), { id: 'p1', name: 'Road trip', added: 0 });
    expect(n.body.split('\n').pop()).toBe('1 film · nessuna canzone per «Road trip»');
  });

  it('counts the songs really added, not the ones in the link', () => {
    const three = { songs: 3, films: 0, notes: 0, software: 0, links: 0, tags: 0 };
    const n = composeShareResult(digest({ counts: three }), { id: 'p1', name: 'Road trip', added: 1 });
    expect(n.body.split('\n').pop()).toBe('3 canzoni · 1 aggiunta a «Road trip»');
  });

  it('never repeats the summary when it is the headline, and never leaves the body empty', () => {
    const same = composeShareResult(digest({ summary: 'Cloudflare ha rilasciato una skill', counts: { songs: 0, films: 0, notes: 0, software: 0, links: 0, tags: 0 } }));
    expect(same.body).toBe('Salvato in libreria.');
    const nothing = composeShareResult(digest({ summary: null, counts: { songs: 0, films: 0, notes: 0, software: 0, links: 0, tags: 0 } }));
    expect(nothing.body).toBe('Salvato in libreria.');
  });

  it('keeps a long summary to one short paragraph', () => {
    const n = composeShareResult(digest({ summary: 'x'.repeat(400) }));
    const first = n.body.split('\n')[0];
    expect(first.length).toBe(160);
    expect(first.endsWith('…')).toBe(true);
  });
});

describe('composeShareReceived', () => {
  it('names the sender with his display name and the entry with its counts', () => {
    const n = composeShareReceived('sara', digest());
    expect(n.title).toBe('Sara ha condiviso con te');
    expect(n.body).toBe('Cloudflare ha rilasciato una skill\n2 canzoni, 1 film');
    expect(n.data).toMatchObject({ from: 'sara', songs: 2, films: 1 });
  });

  it('knows the whole family and does not break on an unknown id', () => {
    expect(composeShareReceived('mike', digest()).title).toBe('Michele ha condiviso con te');
    expect(composeShareReceived('archi', digest()).title).toBe('Archimede ha condiviso con te');
    expect(composeShareReceived('qualcuno', digest()).title).toBe('qualcuno ha condiviso con te');
  });
});

describe('composeShareError', () => {
  const ctx = { sourceUrl: 'https://www.instagram.com/reel/abc', host: 'instagram.com' };

  it.each<[ShareErrorReason, string, RegExp]>([
    ['analysis_failed', 'Analisi non riuscita', /Non sono riuscito a leggere il link \(instagram\.com\)\. Puoi riprovare\./],
    ['ai_output_unusable', 'Analisi non riuscita', /Non sono riuscito a leggere il contenuto \(instagram\.com\)\. Puoi riprovare\./],
    ['instagram_session', 'Instagram non risponde', /Riprovo da solo/],
    ['shazam_unreadable', 'Shazam non leggibile', /Rimanda il link per riprovare/],
    ['playlist_not_found', 'Playlist non valida', /non esiste più\. Il link è comunque in libreria\./],
    ['playlist_dynamic', 'Playlist non valida', /dinamica.*Il link è comunque in libreria\./],
    ['playlist_read_only', 'Playlist non valida', /sola lettura.*Il link è comunque in libreria\./],
  ])('%s says what happened and what to do', (reason, title, body) => {
    const n = composeShareError(reason, ctx);
    expect(n.title).toBe(title);
    expect(n.body).toMatch(body);
    expect(n.data).toMatchObject({ reason, sourceUrl: ctx.sourceUrl });
  });

  it('carries the options the share started with, so "Riprova" works from any device', () => {
    const n = composeShareError('analysis_failed', { ...ctx, options: { playlistId: 'p1', shareWith: ['archi'], comment: '#tesla' } });
    expect(n.data.options).toEqual({ playlistId: 'p1', shareWith: ['archi'], comment: '#tesla' });
  });

  it('leaves out empty options and marks an error the server keeps retrying', () => {
    const plain = composeShareError('analysis_failed', { ...ctx, options: {} });
    expect(plain.data).not.toHaveProperty('options');
    expect(plain.data).not.toHaveProperty('retrying');
    const retrying = composeShareError('instagram_session', { ...ctx, retrying: true });
    expect(retrying.data.retrying).toBe(true);
  });

  it('does not invent a host that is not there', () => {
    expect(composeShareError('analysis_failed', { sourceUrl: 'x' }).body).toBe('Non sono riuscito a leggere il link. Puoi riprovare.');
  });
});
