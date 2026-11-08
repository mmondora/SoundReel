import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveMock = vi.hoisted(() => vi.fn());
vi.mock('./dynamicPlaylists', () => ({ resolveDynamicSongKeys: resolveMock }));

import { invalidateDynamicPlaylists, resolveDetail, resolveSongKeys, resolveSummaries } from './playlistResolver';
import { PRESETS } from './dynamicRules';

const NOW = new Date('2026-11-08T08:00:00Z');
const rule = PRESETS.find((p) => p.id === 'night')!.rule;
const stat = { id: 's1', name: 'Auto', songCount: 2, createdAt: '', updatedAt: '', kind: 'static', songKeys: ['a::b', 'c::d'] } as never;
const dyn = { id: 'd1', name: 'Notte', songCount: 0, createdAt: '', updatedAt: '', kind: 'dynamic', rule, songKeys: [] } as never;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateDynamicPlaylists();
  resolveMock.mockResolvedValue(['x::one', 'y::two', 'z::three']);
});

describe('what a playlist contains right now', () => {
  it('a static playlist is its stored songs and never touches the evaluator', async () => {
    expect(await resolveSongKeys(stat, { userId: 'mike' }, NOW)).toEqual({ songKeys: ['a::b', 'c::d'] });
    expect(await resolveDetail(stat, { userId: 'mike' }, NOW)).toBe(stat);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('a dynamic playlist is what its rule selects for THIS viewer, with the time it was computed', async () => {
    const out = await resolveDetail(dyn, { userId: 'sara' }, NOW);
    expect(out).toMatchObject({ songKeys: ['x::one', 'y::two', 'z::three'], songCount: 3, generatedAt: NOW.toISOString() });
    expect(resolveMock).toHaveBeenCalledWith(rule, { userId: 'sara' }, NOW);
  });

  it('is cached for 60 s per playlist and viewer (a client polling during sync must not re-aggregate each time)', async () => {
    await resolveSongKeys(dyn, { userId: 'mike' }, NOW);
    await resolveSongKeys(dyn, { userId: 'mike' }, new Date(NOW.getTime() + 59_000));
    expect(resolveMock).toHaveBeenCalledTimes(1);
    await resolveSongKeys(dyn, { userId: 'sara' }, NOW); // another viewer sees their own selection
    expect(resolveMock).toHaveBeenCalledTimes(2);
    await resolveSongKeys(dyn, { userId: 'mike' }, new Date(NOW.getTime() + 61_000));
    expect(resolveMock).toHaveBeenCalledTimes(3);
  });

  it('a stored rule that does not parse gives an empty playlist, not an error', async () => {
    const broken = { ...(dyn as object), rule: { order: 'loudest' } } as never;
    expect(await resolveSongKeys(broken, { userId: 'mike' }, NOW)).toMatchObject({ songKeys: [] });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('a list gets the live count only on its dynamic playlists', async () => {
    const out = await resolveSummaries([stat, dyn], { userId: 'mike' }, NOW);
    expect(out[0]).toBe(stat);
    expect(out[1]).toMatchObject({ id: 'd1', songCount: 3, generatedAt: NOW.toISOString() });
  });
});
