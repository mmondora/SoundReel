import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/db', () => ({
  query: vi.fn(),
  pool: { query: vi.fn() },
  getEntry: vi.fn(),
  addEntryShares: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import type { Entry } from '../types';
import type { InboxItem, NewInboxItem } from './inbox';
import type { ShareIntent } from './shareIntents';
import {
  checkPlaylist,
  completeIntent,
  STUCK_AFTER_MS,
  onAnalysisFinished,
  onAnalysisRetrying,
  onEntrySongsAvailable,
  parseShareOptions,
  recordShareError,
  registerShare,
  resolveStuckIntents,
  songKeysOf,
  type FlowDeps,
  type ShareRequestOptions,
} from './shareFlow';

const NOW = new Date('2026-11-08T08:00:00Z');

const song = (title: string, artist = 'Bishop Briggs') => ({ title, artist, album: null, source: 'spotify_link', spotifyUri: null, spotifyUrl: null, youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false });

const entry = (over: Partial<Entry> & { songs?: unknown[]; summary?: string | null } = {}): Entry => ({
  id: 'e1',
  sourceUrl: 'https://open.spotify.com/track/abc',
  sourcePlatform: 'spotify',
  inputChannel: 'ios',
  inputUser: 'mike',
  ownerUser: 'mike',
  caption: 'Bishop Briggs – White Flag',
  thumbnailUrl: null,
  mediaUrl: null,
  status: 'completed',
  createdAt: '2026-11-08T07:00:00Z',
  actionLog: [],
  results: { songs: over.songs ?? [song('White Flag')], films: [], notes: [], links: [], tags: [], summary: over.summary ?? null },
  ...over,
} as unknown as Entry);

function makeDeps(over: Partial<FlowDeps> = {}) {
  const items: Array<NewInboxItem & { id: string }> = [];
  const rung: string[] = [];
  const closed: Array<[string, string]> = [];
  const finished: Array<[string, string, Record<string, unknown>]> = [];
  const intents: ShareIntent[] = [];
  const events: string[] = [];
  let seq = 0;
  const deps: FlowDeps = {
    getEntry: vi.fn(async () => entry()),
    addEntryShares: vi.fn(async (_id, users) => users),
    notifiedRecipients: vi.fn(async () => []),
    getPlaylist: vi.fn(async (id) => ({ id, name: 'Road trip', kind: 'static' as const, ownerUser: 'mike' })),
    addSongsToPlaylist: vi.fn(async (_id, keys) => keys.length),
    createInboxItem: vi.fn(async (item: NewInboxItem) => {
      events.push(`create:${item.level ?? 'info'}:${item.kind}`);
      const created = { ...item, id: `item${(seq += 1)}` };
      items.push(created);
      return { ...created, level: item.level ?? 'info', body: item.body ?? '', entryId: item.entryId ?? null, url: null, linkKey: item.linkKey ?? null, data: item.data ?? {}, createdAt: '', updatedAt: '', readAt: item.read ? 'now' : null, expiresAt: null } as InboxItem;
    }),
    closeErrorsForLink: vi.fn(async (user: string, link: string) => { events.push('close'); closed.push([user, link]); return []; }),
    announce: vi.fn(async (item: InboxItem) => { rung.push(`${item.userId}:${item.id}`); }),
    upsertPendingIntent: vi.fn(async (input) => {
      const intent: ShareIntent = { id: `intent${intents.length + 1}`, entryId: input.entryId, userId: input.userId, sourceUrl: input.sourceUrl, playlistId: input.playlistId ?? null, shareWith: input.shareWith ?? [], notifyWith: input.notifyWith ?? [], comment: input.comment ?? null, status: 'pending' };
      intents.push(intent);
      return intent;
    }),
    pendingIntentsForEntry: vi.fn(async () => intents.filter((i) => i.status === 'pending')),
    stuckIntents: vi.fn(async () => intents.filter((i) => i.status === 'pending')),
    finishIntent: vi.fn(async (id, status, result) => {
      const intent = intents.find((i) => i.id === id);
      if (!intent || intent.status !== 'pending') return false;
      intent.status = status;
      finished.push([id, status, result]);
      return true;
    }),
    ...over,
  };
  return { deps, items, rung, closed, finished, intents, events };
}

const noOptions: ShareRequestOptions = { playlistId: null, recipients: [], rejected: [] };
const withOptions = (o: Partial<ShareRequestOptions>): ShareRequestOptions => ({ ...noOptions, ...o });

beforeEach(() => vi.clearAllMocks());

describe('parseShareOptions', () => {
  it('asks for nothing by default', () => {
    expect(parseShareOptions({}, 'mike')).toEqual({ playlistId: null, recipients: [], rejected: [] });
    expect(parseShareOptions(undefined, 'mike')).toEqual({ playlistId: null, recipients: [], rejected: [] });
  });

  it('takes a trimmed playlist id and ignores anything that is not text', () => {
    expect(parseShareOptions({ playlistId: '  p1 ' }, 'mike').playlistId).toBe('p1');
    expect(parseShareOptions({ playlistId: '   ' }, 'mike').playlistId).toBeNull();
    expect(parseShareOptions({ playlistId: 42 }, 'mike').playlistId).toBeNull();
  });

  it('accepts family members, lowercased and once each', () => {
    expect(parseShareOptions({ shareWith: ['Archi', 'SARA', 'archi'] }, 'mike')).toMatchObject({ recipients: ['archi', 'sara'], rejected: [] });
  });

  it('never shares with the sender and reports why', () => {
    expect(parseShareOptions({ shareWith: ['archi', 'sara'] }, 'archi')).toEqual({
      playlistId: null,
      recipients: ['sara'],
      rejected: [{ user: 'archi', reason: 'self' }],
    });
  });

  it('refuses people outside the family', () => {
    expect(parseShareOptions({ shareWith: ['sara', 'mario', 'anonymous'] }, 'mike')).toMatchObject({
      recipients: ['sara'],
      rejected: [{ user: 'mario', reason: 'unknown_user' }, { user: 'anonymous', reason: 'unknown_user' }],
    });
  });

  it('a key with no user shares with nobody', () => {
    expect(parseShareOptions({ shareWith: ['archi'] }, 'anonymous')).toMatchObject({ recipients: [], rejected: [{ user: 'archi', reason: 'sender_unknown' }] });
  });

  it('ignores non-text entries and a list that is not a list', () => {
    expect(parseShareOptions({ shareWith: ['sara', 7, null, {}] }, 'mike').recipients).toEqual(['sara']);
    expect(parseShareOptions({ shareWith: 'sara' }, 'mike').recipients).toEqual([]);
  });

  it('looks at no more than ten names', () => {
    const many = Array.from({ length: 30 }, (_, i) => `u${i}`);
    const parsed = parseShareOptions({ shareWith: many }, 'mike');
    expect(parsed.rejected).toHaveLength(10);
  });
});

describe('checkPlaylist', () => {
  const found = (over: Record<string, unknown>) => ({ getPlaylist: vi.fn(async () => ({ id: 'p1', name: 'Road trip', kind: 'static' as const, ownerUser: 'mike', ...over })) });

  it('accepts a static playlist of the sender', async () => {
    expect(await checkPlaylist('p1', 'mike', found({}))).toEqual({ ok: true, id: 'p1', name: 'Road trip' });
  });
  it('refuses one that does not exist (or is not visible to him)', async () => {
    expect(await checkPlaylist('p1', 'mike', { getPlaylist: vi.fn(async () => null) })).toEqual({ ok: false, id: 'p1', error: 'not_found' });
  });
  it('refuses a dynamic one: it is a rule, not a list', async () => {
    expect(await checkPlaylist('p1', 'mike', found({ kind: 'dynamic' }))).toEqual({ ok: false, id: 'p1', error: 'dynamic' });
  });
  it('refuses one only shared with him: read-only', async () => {
    expect(await checkPlaylist('p1', 'archi', found({ ownerUser: 'mike' }))).toEqual({ ok: false, id: 'p1', error: 'read_only' });
  });
});

describe('songKeysOf', () => {
  it('gives one key per song with a title, once, trimmed and lowercased', () => {
    const keys = songKeysOf(entry({ songs: [song('White Flag'), song(' white  flag '), song(''), song('Dream', ' Bishop  Briggs'), null as never] }));
    expect(keys).toEqual(['bishop briggs::white flag', 'bishop briggs::dream']);
  });
  it('is empty for an entry with no songs', () => {
    expect(songKeysOf(entry({ songs: [] }))).toEqual([]);
    expect(songKeysOf({ results: {} } as never)).toEqual([]);
  });
});

describe('registerShare: a generic link waits for its analysis', () => {
  it('records the intent and creates nothing yet', async () => {
    const { deps, items, intents } = makeDeps();
    const res = await registerShare({ entry: entry({ sourcePlatform: 'instagram', songs: [] }), sender: 'mike', kind: 'generic', options: noOptions, comment: '#tesla' }, deps, NOW);
    expect(res).toEqual({ playlist: null, sharedWith: [] });
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ userId: 'mike', playlistId: null, comment: '#tesla', status: 'pending' });
    expect(items).toHaveLength(0);
    expect(deps.addSongsToPlaylist).not.toHaveBeenCalled();
  });

  it('answers "pending" for a valid playlist and fills it later', async () => {
    const { deps, intents } = makeDeps();
    const res = await registerShare({ entry: entry({ sourcePlatform: 'instagram', songs: [] }), sender: 'mike', kind: 'generic', options: withOptions({ playlistId: 'p1' }), comment: null }, deps, NOW);
    expect(res.playlist).toEqual({ id: 'p1', name: 'Road trip', added: 'pending' });
    expect(intents[0].playlistId).toBe('p1');
    expect(deps.addSongsToPlaylist).not.toHaveBeenCalled();
  });

  it('shares with the family right away, so they see the entry at once, and remembers who to ring', async () => {
    const { deps, intents, items } = makeDeps({ notifiedRecipients: vi.fn(async () => ['archi']) }); // archi was told before
    const res = await registerShare({ entry: entry({ songs: [] }), sender: 'mike', kind: 'generic', options: withOptions({ recipients: ['archi', 'sara'] }), comment: null }, deps, NOW);
    expect(deps.addEntryShares).toHaveBeenCalledWith('e1', ['archi', 'sara'], 'mike');
    expect(res.sharedWith).toEqual(['archi', 'sara']);
    expect(intents[0]).toMatchObject({ shareWith: ['archi', 'sara'], notifyWith: ['sara'] });
    expect(items).toHaveLength(0); // the notices wait for the analysis (title, summary and counts are not known yet)
  });
});

describe('registerShare: a Spotify or Shazam link completes at once', () => {
  it('fills the playlist now and answers with the number added', async () => {
    const { deps, items, rung, closed } = makeDeps();
    const res = await registerShare({ entry: entry(), sender: 'mike', kind: 'spotify', options: withOptions({ playlistId: 'p1' }), comment: null }, deps, NOW);
    expect(deps.addSongsToPlaylist).toHaveBeenCalledWith('p1', ['bishop briggs::white flag'], 'mike');
    expect(res.playlist).toEqual({ id: 'p1', name: 'Road trip', added: 1 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ userId: 'mike', kind: 'share_result', read: true, entryId: 'e1', linkKey: 'https://open.spotify.com/track/abc' });
    expect(items[0].body).toContain('aggiunta a «Road trip»');
    expect(rung).toEqual([]); // he just saw it in the sheet: no doorbell
    expect(closed).toEqual([['mike', 'https://open.spotify.com/track/abc']]); // errors of the same link close
  });

  it('answers 0 added when the songs were all there already', async () => {
    const { deps, items } = makeDeps({ addSongsToPlaylist: vi.fn(async () => 0) });
    const res = await registerShare({ entry: entry(), sender: 'mike', kind: 'shazam', options: withOptions({ playlistId: 'p1' }), comment: null }, deps, NOW);
    expect(res.playlist).toEqual({ id: 'p1', name: 'Road trip', added: 0 });
    expect(items[0].body).toContain('già in «Road trip»');
  });

  it('with no playlist asked, no playlist is touched or reported', async () => {
    const { deps } = makeDeps();
    const res = await registerShare({ entry: entry(), sender: 'mike', kind: 'spotify', options: noOptions, comment: null }, deps, NOW);
    expect(res.playlist).toBeNull();
    expect(deps.addSongsToPlaylist).not.toHaveBeenCalled();
  });

  it('rings the people never told about it, and only them', async () => {
    const { deps, items, rung } = makeDeps({ notifiedRecipients: vi.fn(async () => ['archi']) }); // archi was told already
    await registerShare({ entry: entry(), sender: 'mike', kind: 'spotify', options: withOptions({ recipients: ['archi', 'sara'] }), comment: null }, deps, NOW);
    const received = items.filter((i) => i.kind === 'share_received');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ userId: 'sara', entryId: 'e1' });
    expect(received[0].title).toBe('Michele ha condiviso con te');
    expect(rung).toHaveLength(1);
    expect(rung[0].startsWith('sara:')).toBe(true);
  });

  it('a Spotify link whose tracks are not known yet stays pending', async () => {
    const { deps, items } = makeDeps();
    const res = await registerShare({ entry: entry({ songs: [] }), sender: 'mike', kind: 'spotify', options: withOptions({ playlistId: 'p1' }), comment: null }, deps, NOW);
    expect(res.playlist).toEqual({ id: 'p1', name: 'Road trip', added: 'pending' });
    expect(items).toHaveLength(0);
    expect(deps.finishIntent).not.toHaveBeenCalled();
  });
});

describe('registerShare: who gets the notice', () => {
  it('a share that failed the first time and works the second tells the recipients the second time', async () => {
    const m = makeDeps({ getEntry: vi.fn(async () => entry({ sourcePlatform: 'instagram', songs: [song('Dream')] })) });
    // first attempt: the analysis fails for good, nobody is told (the recipients already HAVE the entry)
    await registerShare({ entry: entry({ songs: [] }), sender: 'mike', kind: 'generic', options: withOptions({ recipients: ['archi', 'sara'] }), comment: null }, m.deps, NOW);
    await onAnalysisFinished('e1', { ok: false, reason: 'ai_output_unusable' }, m.deps, NOW);
    expect(m.items.filter((i) => i.kind === 'share_received')).toHaveLength(0);
    // second attempt: addEntryShares inserts nothing new, and still the recipients were never told
    await registerShare({ entry: entry({ songs: [] }), sender: 'mike', kind: 'generic', options: withOptions({ recipients: ['archi', 'sara'] }), comment: null }, m.deps, NOW);
    await onAnalysisFinished('e1', { ok: true }, m.deps, NOW);
    expect(m.items.filter((i) => i.kind === 'share_received').map((i) => i.userId).sort()).toEqual(['archi', 'sara']);
  });

  it('asks who was told about THIS entry among THESE recipients, and rings only the others', async () => {
    const m = makeDeps({ notifiedRecipients: vi.fn(async () => ['sara']) });
    await registerShare({ entry: entry(), sender: 'mike', kind: 'spotify', options: withOptions({ recipients: ['archi', 'sara'] }), comment: null }, m.deps, NOW);
    expect(m.deps.notifiedRecipients).toHaveBeenCalledWith('e1', ['archi', 'sara']);
    expect(m.items.filter((i) => i.kind === 'share_received').map((i) => i.userId)).toEqual(['archi']);
  });

  it('asks nothing when nobody is shared with', async () => {
    const m = makeDeps();
    await registerShare({ entry: entry(), sender: 'mike', kind: 'spotify', options: noOptions, comment: null }, m.deps, NOW);
    expect(m.deps.notifiedRecipients).not.toHaveBeenCalled();
    expect(m.deps.addEntryShares).not.toHaveBeenCalled();
  });
});

describe('registerShare: a playlist that cannot be used', () => {
  it.each([
    ['not_found', null, 'playlist_not_found'],
    ['dynamic', { id: 'p1', name: 'Dyn', kind: 'dynamic' as const, ownerUser: 'mike' }, 'playlist_dynamic'],
    ['read_only', { id: 'p1', name: 'Altrui', kind: 'static' as const, ownerUser: 'sara' }, 'playlist_read_only'],
  ])('%s: the link is saved anyway, the sheet is told, and the inbox keeps an error', async (error, found, reason) => {
    const { deps, items, intents } = makeDeps({ getPlaylist: vi.fn(async () => found) });
    const res = await registerShare({ entry: entry(), sender: 'mike', kind: 'spotify', options: withOptions({ playlistId: 'p1', recipients: ['sara'] }), comment: '#x' }, deps, NOW);
    expect(res.playlist).toEqual({ id: 'p1', error });
    expect(intents[0].playlistId).toBe('p1'); // kept as asked: completion looks again, and the retry options carry it
    expect(deps.addSongsToPlaylist).not.toHaveBeenCalled();
    const errors = items.filter((i) => i.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ userId: 'mike', read: true, linkKey: 'https://open.spotify.com/track/abc' });
    expect((errors[0].data as { reason: string }).reason).toBe(reason);
    // the retry options hold what was ASKED for, so the user can send it again with another playlist
    expect((errors[0].data as { options: unknown }).options).toEqual({ playlistId: 'p1', shareWith: ['sara'], comment: '#x' });
    expect(items.some((i) => i.level !== 'error' && i.kind === 'share_result')).toBe(true); // and the library result is there
  });

  it('a playlist that vanished between share and completion becomes an error, not a lost share', async () => {
    const { deps, items } = makeDeps({ addSongsToPlaylist: vi.fn(async () => null) });
    const res = await registerShare({ entry: entry(), sender: 'mike', kind: 'spotify', options: withOptions({ playlistId: 'p1' }), comment: null }, deps, NOW);
    expect(res.playlist).toEqual({ id: 'p1', error: 'not_found' });
    expect(items.filter((i) => i.level === 'error')).toHaveLength(1);
    expect(items.filter((i) => i.level !== 'error')).toHaveLength(1);
  });

  it('a playlist that became dynamic meanwhile is reported as dynamic', async () => {
    const { deps, items } = makeDeps({ addSongsToPlaylist: vi.fn(async () => { throw new Error('playlist_is_dynamic'); }) });
    await registerShare({ entry: entry(), sender: 'mike', kind: 'spotify', options: withOptions({ playlistId: 'p1' }), comment: null }, deps, NOW);
    expect((items.find((i) => i.level === 'error')!.data as { reason: string }).reason).toBe('playlist_dynamic');
  });
});

describe('registerShare: the playlist error is raised AFTER the errors of the link were closed', () => {
  it('an error raised before would be closed by the very completion that follows: it must come after', async () => {
    const { deps, events } = makeDeps({ getPlaylist: vi.fn(async () => null) });
    await registerShare({ entry: entry(), sender: 'mike', kind: 'spotify', options: withOptions({ playlistId: 'p1' }), comment: null }, deps, NOW);
    expect(events.indexOf('close')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('create:error:share_result')).toBeGreaterThan(events.indexOf('close'));
  });

  it('for a link that waits for its analysis: nothing at share time (the sheet already said), the error when it ends', async () => {
    const m = makeDeps({ getPlaylist: vi.fn(async () => ({ id: 'p1', name: 'Dyn', kind: 'dynamic' as const, ownerUser: 'mike' })), getEntry: vi.fn(async () => entry({ sourcePlatform: 'instagram', songs: [song('Dream')] })) });
    const res = await registerShare({ entry: entry({ songs: [] }), sender: 'mike', kind: 'generic', options: withOptions({ playlistId: 'p1' }), comment: null }, m.deps, NOW);
    expect(res.playlist).toEqual({ id: 'p1', error: 'dynamic' });
    expect(m.items).toHaveLength(0);
    await onAnalysisFinished('e1', { ok: true }, m.deps, NOW);
    const errors = m.items.filter((i) => i.level === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0].data as { reason: string }).reason).toBe('playlist_dynamic');
    expect(errors[0].read).toBe(true); // he was told in the sheet
    const resultItem = m.items.find((i) => i.level !== 'error' && i.kind === 'share_result')!;
    expect(m.rung).toContain(`mike:${resultItem.id}`); // the outcome came later: it rings
    expect(m.rung).not.toContain(`mike:${errors[0].id}`); // the playlist error does not: the sheet said it
    expect(m.events.indexOf('create:error:share_result')).toBeGreaterThan(m.events.indexOf('close'));
    expect(m.deps.addSongsToPlaylist).not.toHaveBeenCalled();
  });

  it('a later good playlist for the same link closes the old playlist error', async () => {
    const m = makeDeps();
    m.intents.push({ id: 'intent1', entryId: 'e1', userId: 'mike', sourceUrl: 'https://open.spotify.com/track/abc', playlistId: 'p1', shareWith: [], notifyWith: [], comment: null, status: 'pending' });
    await completeIntent(m.intents[0], entry(), { immediate: true }, m.deps, NOW);
    expect(m.closed).toEqual([['mike', 'https://open.spotify.com/track/abc']]);
    expect(m.items.filter((i) => i.level === 'error')).toHaveLength(0);
  });
});

describe('completeIntent', () => {
  const intent = (over: Partial<ShareIntent> = {}): ShareIntent => ({ id: 'intent1', entryId: 'e1', userId: 'mike', sourceUrl: 'https://open.spotify.com/track/abc', playlistId: null, shareWith: [], notifyWith: [], comment: null, status: 'pending', ...over });

  it('announces once: a second run on the same intent stays silent', async () => {
    const { deps, items, intents } = makeDeps();
    intents.push(intent());
    const first = await completeIntent(intents[0], entry(), { immediate: false }, deps, NOW);
    const second = await completeIntent({ ...intents[0], status: 'pending' }, entry(), { immediate: false }, deps, NOW);
    expect(first.announced).toBe(true);
    expect(second.announced).toBe(false);
    expect(items.filter((i) => i.kind === 'share_result')).toHaveLength(1);
  });

  it('an outcome that arrives later is unread and rings the sender', async () => {
    const { deps, items, rung, intents } = makeDeps();
    const i = intent();
    intents.push(i);
    await completeIntent(i, entry(), { immediate: false }, deps, NOW);
    expect(items[0].read).toBe(false);
    expect(rung).toHaveLength(1);
  });

  it('the notice says what Telegram says: headline, summary, counts', async () => {
    const { deps, items, intents } = makeDeps();
    const i = intent();
    intents.push(i);
    await completeIntent(i, entry({ summary: 'Una canzone rock.', songs: [song('White Flag'), song('Dream')] }), { immediate: false }, deps, NOW);
    expect(items[0].title).toBe('Bishop Briggs – White Flag');
    expect(items[0].body).toBe('Una canzone rock.\n2 canzoni');
    expect(items[0].data).toMatchObject({ songs: 2, films: 0 });
  });

  it('never rings a recipient who is the sender', async () => {
    const { deps, items, intents } = makeDeps();
    const i = intent({ notifyWith: ['mike', 'sara'] });
    intents.push(i);
    await completeIntent(i, entry(), { immediate: true }, deps, NOW);
    expect(items.filter((i) => i.kind === 'share_received').map((i) => i.userId)).toEqual(['sara']);
  });
});

describe('onAnalysisFinished', () => {
  const pending = (deps: ReturnType<typeof makeDeps>, over: Partial<ShareIntent> = {}) =>
    deps.intents.push({ id: 'intent1', entryId: 'e1', userId: 'mike', sourceUrl: 'https://www.instagram.com/reel/abc', playlistId: 'p1', shareWith: ['archi'], notifyWith: ['archi'], comment: '#tesla', status: 'pending', ...over });

  it('does nothing for an entry nobody shared from the app (repairs, Telegram)', async () => {
    const m = makeDeps();
    await onAnalysisFinished('e1', { ok: true }, m.deps, NOW);
    expect(m.deps.getEntry).not.toHaveBeenCalled();
    expect(m.items).toHaveLength(0);
  });

  it('completes the waiting share: playlist, outcome for the sender, notice for the recipient', async () => {
    const m = makeDeps({ getEntry: vi.fn(async () => entry({ sourcePlatform: 'instagram', sourceUrl: 'https://www.instagram.com/reel/abc', summary: 'Un reel.', songs: [song('Dream'), song('Flag')] })) });
    pending(m);
    await onAnalysisFinished('e1', { ok: true }, m.deps, NOW);
    expect(m.deps.addSongsToPlaylist).toHaveBeenCalledWith('p1', ['bishop briggs::dream', 'bishop briggs::flag'], 'mike');
    expect(m.items.map((i) => `${i.userId}:${i.kind}:${i.read ?? false}`)).toEqual(['mike:share_result:false', 'archi:share_received:false']);
    expect(m.items[0].body).toContain('aggiunte a «Road trip»');
    expect(m.rung).toHaveLength(2);
    expect(m.finished[0][1]).toBe('done');
  });

  it('a failure with no retry left becomes an error that carries the options to try again', async () => {
    const m = makeDeps();
    pending(m);
    await onAnalysisFinished('e1', { ok: false, reason: 'ai_output_unusable' }, m.deps, NOW);
    expect(m.items).toHaveLength(1);
    expect(m.items[0]).toMatchObject({ userId: 'mike', level: 'error', kind: 'share_result' });
    expect(m.items[0].data).toMatchObject({ reason: 'ai_output_unusable', options: { playlistId: 'p1', shareWith: ['archi'], comment: '#tesla' } });
    expect(m.finished[0][1]).toBe('failed');
    expect(m.rung).toHaveLength(1);
    expect(m.deps.addSongsToPlaylist).not.toHaveBeenCalled();
    // the recipient is not told about a share that did not work
    expect(m.items.some((i) => i.kind === 'share_received')).toBe(false);
  });

  it('a newer error replaces the older one for the same link', async () => {
    const m = makeDeps();
    pending(m);
    await onAnalysisFinished('e1', { ok: false, reason: 'analysis_failed' }, m.deps, NOW);
    expect(m.closed).toEqual([['mike', 'https://open.spotify.com/track/abc']]);
  });

  it('never throws: the job is done whatever happens here', async () => {
    const m = makeDeps({ pendingIntentsForEntry: vi.fn(async () => { throw new Error('db down'); }) });
    await expect(onAnalysisFinished('e1', { ok: true }, m.deps, NOW)).resolves.toBeUndefined();
    const m2 = makeDeps({ createInboxItem: vi.fn(async () => { throw new Error('insert failed'); }) });
    pending(m2);
    await expect(onAnalysisFinished('e1', { ok: true }, m2.deps, NOW)).resolves.toBeUndefined();
  });
});

describe('onAnalysisRetrying', () => {
  it('tells the sender now, keeps the share open, and says the server keeps trying', async () => {
    const m = makeDeps();
    m.intents.push({ id: 'intent1', entryId: 'e1', userId: 'mike', sourceUrl: 'https://www.instagram.com/reel/abc', playlistId: null, shareWith: [], notifyWith: [], comment: null, status: 'pending' });
    await onAnalysisRetrying('e1', 'instagram_session', m.deps, NOW);
    expect(m.items).toHaveLength(1);
    expect(m.items[0]).toMatchObject({ level: 'error', userId: 'mike' });
    expect(m.items[0].data).toMatchObject({ reason: 'instagram_session', retrying: true });
    expect(m.deps.finishIntent).not.toHaveBeenCalled();
    expect(m.intents[0].status).toBe('pending');
  });

  it('is silent for an entry nobody shared from the app', async () => {
    const m = makeDeps();
    await onAnalysisRetrying('e1', 'instagram_session', m.deps, NOW);
    expect(m.items).toHaveLength(0);
  });

  it('then the success closes that same error by itself', async () => {
    const m = makeDeps();
    m.intents.push({ id: 'intent1', entryId: 'e1', userId: 'mike', sourceUrl: 'https://www.instagram.com/reel/abc', playlistId: null, shareWith: [], notifyWith: [], comment: null, status: 'pending' });
    await onAnalysisRetrying('e1', 'instagram_session', m.deps, NOW);
    m.closed.length = 0;
    await onAnalysisFinished('e1', { ok: true }, m.deps, NOW);
    expect(m.closed).toEqual([['mike', 'https://open.spotify.com/track/abc']]);
  });
});

describe('onEntrySongsAvailable', () => {
  it('waits while the entry has no song, then completes the share', async () => {
    let songs: unknown[] = [];
    const m = makeDeps({ getEntry: vi.fn(async () => entry({ songs })) });
    m.intents.push({ id: 'intent1', entryId: 'e1', userId: 'mike', sourceUrl: 'https://open.spotify.com/track/abc', playlistId: 'p1', shareWith: [], notifyWith: [], comment: null, status: 'pending' });
    await onEntrySongsAvailable('e1', m.deps, NOW);
    expect(m.items).toHaveLength(0);
    songs = [song('White Flag')];
    await onEntrySongsAvailable('e1', m.deps, NOW);
    expect(m.deps.addSongsToPlaylist).toHaveBeenCalledWith('p1', ['bishop briggs::white flag'], 'mike');
    expect(m.items).toHaveLength(1);
    expect(m.items[0].read).toBe(false); // it came later: news
  });
});

describe('recordShareError', () => {
  it('stores an error that stays, already read (the sheet showed it), replacing the older one for the link', async () => {
    const m = makeDeps();
    await recordShareError({ userId: 'mike', entry: { id: 'e3', sourceUrl: 'https://www.shazam.com/track/1' }, reason: 'shazam_unreadable', options: { playlistId: 'p1' } }, m.deps, NOW);
    expect(m.closed).toEqual([['mike', 'https://www.shazam.com/track/1']]);
    expect(m.items[0]).toMatchObject({ level: 'error', read: true, entryId: 'e3', linkKey: 'https://www.shazam.com/track/1' });
    expect(m.items[0].data).toMatchObject({ reason: 'shazam_unreadable', options: { playlistId: 'p1' } });
  });
});

describe('resolveStuckIntents: the safety net that makes the flow restart-safe', () => {
  const open = (m: ReturnType<typeof makeDeps>, over: Partial<ShareIntent> = {}) =>
    m.intents.push({ id: `intent${m.intents.length + 1}`, entryId: 'e1', userId: 'mike', sourceUrl: 'https://www.instagram.com/reel/abc', playlistId: 'p1', shareWith: [], notifyWith: [], comment: null, status: 'pending', ...over });

  it('asks only for intents older than 10 minutes', async () => {
    const m = makeDeps();
    await resolveStuckIntents(m.deps, NOW);
    expect(m.deps.stuckIntents).toHaveBeenCalledWith(new Date(NOW.getTime() - STUCK_AFTER_MS));
    expect(STUCK_AFTER_MS).toBe(10 * 60 * 1000);
  });

  it('completes a share whose analysis ended before (or without) anyone announcing it', async () => {
    const m = makeDeps({ getEntry: vi.fn(async () => entry({ sourcePlatform: 'instagram', songs: [song('Dream')] })) });
    open(m);
    expect(await resolveStuckIntents(m.deps, NOW)).toBe(1);
    expect(m.deps.addSongsToPlaylist).toHaveBeenCalledWith('p1', ['bishop briggs::dream'], 'mike');
    expect(m.items.filter((i) => i.kind === 'share_result' && !i.level)).toHaveLength(1);
    expect(m.intents[0].status).toBe('done');
  });

  it('fails a share whose entry ended in error', async () => {
    const m = makeDeps({ getEntry: vi.fn(async () => entry({ status: 'error' } as never)) });
    open(m);
    expect(await resolveStuckIntents(m.deps, NOW)).toBe(1);
    expect(m.items[0]).toMatchObject({ level: 'error', userId: 'mike' });
    expect((m.items[0].data as { reason: string }).reason).toBe('analysis_failed');
    expect(m.intents[0].status).toBe('failed');
  });

  it('leaves alone an entry that is still being worked on (it has no job but is not done yet)', async () => {
    const m = makeDeps({ getEntry: vi.fn(async () => entry({ status: 'processing' } as never)) });
    open(m);
    expect(await resolveStuckIntents(m.deps, NOW)).toBe(0);
    expect(m.items).toHaveLength(0);
    expect(m.intents[0].status).toBe('pending');
  });

  it('skips an entry that is gone, and one bad share does not stop the others', async () => {
    const m = makeDeps();
    open(m, { entryId: 'gone' });
    open(m, { entryId: 'e2', id: 'intentB' });
    open(m, { entryId: 'e3', id: 'intentC' });
    vi.mocked(m.deps.getEntry).mockImplementation(async (id: string) => {
      if (id === 'gone') return null;
      if (id === 'e2') throw new Error('db hiccup');
      return entry({ id });
    });
    expect(await resolveStuckIntents(m.deps, NOW)).toBe(1);
    expect(m.intents.find((i) => i.id === 'intentC')!.status).toBe('done');
  });

  it('never throws, even when the intents cannot be read', async () => {
    const m = makeDeps({ stuckIntents: vi.fn(async () => { throw new Error('db down'); }) });
    await expect(resolveStuckIntents(m.deps, NOW)).resolves.toBe(0);
  });

  it('a share announced meanwhile is not announced again (the gate)', async () => {
    const m = makeDeps();
    open(m);
    await onAnalysisFinished('e1', { ok: true }, m.deps, NOW);
    const before = m.items.length;
    m.intents[0].status = 'pending'; // a stale list that still shows it open
    vi.mocked(m.deps.finishIntent).mockResolvedValueOnce(false);
    await resolveStuckIntents(m.deps, NOW);
    expect(m.items.length).toBe(before);
  });
});
