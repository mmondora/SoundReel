import { describe, expect, it, vi } from 'vitest';
import {
  errorMessage,
  executeCopy,
  executeMove,
  executeRemove,
  executeUndo,
  hasProblems,
  moveBlock,
  planCopy,
  runBatch,
} from './managerOps';
import type { PlaylistApi, Progress } from './managerOps';
import type { PlaylistDetail } from '../types';

/** In-memory backend: playlists as ordered key lists; individual calls can be made to fail. */
function fakeApi(initial: Record<string, string[]>, failing: Array<{ call: 'add' | 'remove' | 'reorder'; playlist?: string; key?: string }> = []) {
  const lists: Record<string, string[]> = JSON.parse(JSON.stringify(initial)) as Record<string, string[]>;
  const calls: string[] = [];
  const detail = (id: string): PlaylistDetail => ({
    id, name: id, songCount: lists[id].length, createdAt: '', updatedAt: '', songKeys: [...lists[id]],
  });
  const shouldFail = (call: 'add' | 'remove' | 'reorder', playlist: string, key?: string) =>
    failing.some((f) => f.call === call && (f.playlist === undefined || f.playlist === playlist) && (f.key === undefined || f.key === key));
  const api: PlaylistApi = {
    add: vi.fn(async (id, key) => {
      calls.push(`add ${id} ${key}`);
      if (shouldFail('add', id, key)) throw new Error(JSON.stringify({ error: 'playlist add song failed' }));
      if (!lists[id].includes(key)) lists[id].push(key);
      return detail(id);
    }),
    remove: vi.fn(async (id, key) => {
      calls.push(`remove ${id} ${key}`);
      if (shouldFail('remove', id, key)) throw new Error('HTTP 500');
      lists[id] = lists[id].filter((k) => k !== key);
      return detail(id);
    }),
    reorder: vi.fn(async (id, keys) => {
      calls.push(`reorder ${id} ${keys.join(',')}`);
      if (shouldFail('reorder', id)) throw new Error('HTTP 500');
      lists[id] = [...keys];
      return detail(id);
    }),
  };
  return { api, lists, calls };
}

describe('errorMessage', () => {
  it('unwraps the backend JSON error and truncates long text', () => {
    expect(errorMessage(new Error('{"error":"playlist not found"}'))).toBe('playlist not found');
    expect(errorMessage(new Error('HTTP 500'))).toBe('HTTP 500');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(new Error('x'.repeat(300))).length).toBeLessThanOrEqual(160);
  });
});

describe('planCopy', () => {
  it('splits new songs from the ones already there and drops duplicates in the request', () => {
    expect(planCopy(['a', 'b', 'a', 'c'], ['b', 'z'])).toEqual({ toAdd: ['a', 'c'], alreadyThere: ['b'] });
    expect(planCopy([], ['b'])).toEqual({ toAdd: [], alreadyThere: [] });
  });
});

describe('moveBlock', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('moves a single song up and down', () => {
    expect(moveBlock(order, new Set(['c']), -1)).toEqual(['a', 'c', 'b', 'd', 'e']);
    expect(moveBlock(order, new Set(['c']), 1)).toEqual(['a', 'b', 'd', 'c', 'e']);
  });

  it('stops at the edges', () => {
    expect(moveBlock(order, new Set(['a']), -1)).toEqual(order);
    expect(moveBlock(order, new Set(['e']), 1)).toEqual(order);
  });

  it('moves a block of marked songs together, keeping their relative order', () => {
    expect(moveBlock(order, new Set(['b', 'c']), -1)).toEqual(['b', 'c', 'a', 'd', 'e']);
    expect(moveBlock(order, new Set(['b', 'd']), 1)).toEqual(['a', 'c', 'b', 'e', 'd']);
    expect(moveBlock(order, new Set(['a', 'c']), -1)).toEqual(['a', 'c', 'b', 'd', 'e']);
  });

  it('does not mutate its input', () => {
    moveBlock(order, new Set(['c']), -1);
    expect(order).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('runBatch', () => {
  const okDetail = {} as PlaylistDetail;

  it('runs sequentially and reports every key', async () => {
    const order: string[] = [];
    const res = await runBatch(['a', 'b', 'c'], async (k) => { order.push(k); return okDetail; });
    expect(order).toEqual(['a', 'b', 'c']);
    expect(res).toMatchObject({ ok: ['a', 'b', 'c'], failed: [], notAttempted: [] });
  });

  it('collects failures with their reason and keeps going', async () => {
    const res = await runBatch(['a', 'b', 'c'], async (k) => {
      if (k === 'b') throw new Error('{"error":"nope"}');
      return okDetail;
    });
    expect(res.ok).toEqual(['a', 'c']);
    expect(res.failed).toEqual([{ key: 'b', error: 'nope' }]);
  });

  it('aborts after repeated failures and reports the rest as not attempted', async () => {
    const worker = vi.fn(async () => { throw new Error('down'); });
    const res = await runBatch(['1', '2', '3', '4', '5', '6', '7'], worker, { maxConsecutiveFailures: 3 });
    expect(worker).toHaveBeenCalledTimes(3);
    expect(res.failed.map((f) => f.key)).toEqual(['1', '2', '3']);
    expect(res.notAttempted).toEqual(['4', '5', '6', '7']);
  });

  it('a success resets the failure streak', async () => {
    const res = await runBatch(['1', '2', '3', '4', '5', '6'], async (k) => {
      if (['1', '2', '4', '5'].includes(k)) throw new Error('x');
      return okDetail;
    }, { maxConsecutiveFailures: 3 });
    expect(res.notAttempted).toEqual([]);
    expect(res.ok).toEqual(['3', '6']);
  });

  it('reports progress after each key', async () => {
    const seen: Array<[number, string]> = [];
    await runBatch(['a', 'b'], async () => okDetail, { onStep: (n, k) => seen.push([n, k]) });
    expect(seen).toEqual([[1, 'a'], [2, 'b']]);
  });
});

describe('executeCopy', () => {
  it('adds only what is missing and builds an undo that removes exactly those', async () => {
    const { api, lists } = fakeApi({ target: ['b'] });
    const progress: Progress[] = [];
    const out = await executeCopy(api, { targetId: 'target', keys: ['a', 'b', 'c'], targetKeys: ['b'], onProgress: (p) => progress.push(p) });
    expect(out).toMatchObject({ op: 'copy', requested: 3, added: ['a', 'c'], alreadyThere: ['b'], removed: [], failed: [], targetId: 'target' });
    expect(lists.target).toEqual(['b', 'a', 'c']);
    expect(out.target?.songKeys).toEqual(['b', 'a', 'c']);
    expect(out.undo).toEqual({ steps: [{ kind: 'remove', playlistId: 'target', keys: ['a', 'c'] }] });
    expect(progress.map((p) => [p.op, p.done, p.total])).toEqual([['copy', 1, 2], ['copy', 2, 2]]);
  });

  it('a partial failure is reported per song and the undo only covers what succeeded', async () => {
    const { api } = fakeApi({ target: [] }, [{ call: 'add', key: 'b' }]);
    const out = await executeCopy(api, { targetId: 'target', keys: ['a', 'b', 'c'], targetKeys: [] });
    expect(out.added).toEqual(['a', 'c']);
    expect(out.failed).toEqual([{ key: 'b', error: 'playlist add song failed', step: 'add' }]);
    expect(out.retryKeys).toEqual(['b']);
    expect(out.undo).toEqual({ steps: [{ kind: 'remove', playlistId: 'target', keys: ['a', 'c'] }] });
    expect(hasProblems(out)).toBe(true);
  });

  it('nothing to add → no calls, no undo', async () => {
    const { api, calls } = fakeApi({ target: ['a'] });
    const out = await executeCopy(api, { targetId: 'target', keys: ['a'], targetKeys: ['a'] });
    expect(calls).toEqual([]);
    expect(out).toMatchObject({ added: [], alreadyThere: ['a'], undo: null });
    expect(hasProblems(out)).toBe(false);
  });
});

describe('executeMove', () => {
  it('copies, then removes from the source only what is safely in the target', async () => {
    const { api, lists, calls } = fakeApi({ src: ['a', 'b', 'c'], dst: ['b'] });
    const out = await executeMove(api, { sourceId: 'src', targetId: 'dst', keys: ['a', 'b'], sourceKeys: ['a', 'b', 'c'], targetKeys: ['b'] });
    expect(out).toMatchObject({ op: 'move', added: ['a'], alreadyThere: ['b'], removed: ['a', 'b'], failed: [] });
    expect(lists).toEqual({ src: ['c'], dst: ['b', 'a'] });
    expect(calls).toEqual(['add dst a', 'remove src a', 'remove src b']);
    expect(out.source?.songKeys).toEqual(['c']);
    expect(out.target?.songKeys).toEqual(['b', 'a']);
  });

  it('never removes a song from the source when adding it to the target failed', async () => {
    const { api, lists } = fakeApi({ src: ['a', 'b'], dst: [] }, [{ call: 'add', key: 'b' }]);
    const out = await executeMove(api, { sourceId: 'src', targetId: 'dst', keys: ['a', 'b'], sourceKeys: ['a', 'b'], targetKeys: [] });
    expect(lists).toEqual({ src: ['b'], dst: ['a'] });
    expect(out.removed).toEqual(['a']);
    expect(out.failed).toEqual([{ key: 'b', error: 'playlist add song failed', step: 'add' }]);
    expect(out.retryKeys).toEqual(['b']);
  });

  it('reports a failed removal after a successful add (the song is then in both playlists)', async () => {
    const { api, lists } = fakeApi({ src: ['a'], dst: [] }, [{ call: 'remove', playlist: 'src', key: 'a' }]);
    const out = await executeMove(api, { sourceId: 'src', targetId: 'dst', keys: ['a'], sourceKeys: ['a'], targetKeys: [] });
    expect(lists).toEqual({ src: ['a'], dst: ['a'] });
    expect(out.added).toEqual(['a']);
    expect(out.removed).toEqual([]);
    expect(out.failed).toEqual([{ key: 'a', error: 'HTTP 500', step: 'remove' }]);
  });

  it('undo puts everything back, including the source order', async () => {
    const { api, lists } = fakeApi({ src: ['a', 'b', 'c'], dst: [] });
    const out = await executeMove(api, { sourceId: 'src', targetId: 'dst', keys: ['b'], sourceKeys: ['a', 'b', 'c'], targetKeys: [] });
    expect(lists).toEqual({ src: ['a', 'c'], dst: ['b'] });
    const undone = await executeUndo(api, out.undo!);
    expect(undone.failed).toEqual([]);
    expect(lists).toEqual({ src: ['a', 'b', 'c'], dst: [] });
  });
});

describe('executeRemove', () => {
  it('removes and offers an order-preserving undo', async () => {
    const { api, lists } = fakeApi({ p: ['a', 'b', 'c', 'd'] });
    const out = await executeRemove(api, { playlistId: 'p', keys: ['b', 'c'], sourceKeys: ['a', 'b', 'c', 'd'] });
    expect(out).toMatchObject({ op: 'remove', removed: ['b', 'c'], failed: [] });
    expect(lists.p).toEqual(['a', 'd']);
    await executeUndo(api, out.undo!);
    expect(lists.p).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reports the songs it could not remove', async () => {
    const { api } = fakeApi({ p: ['a', 'b'] }, [{ call: 'remove', key: 'b' }]);
    const out = await executeRemove(api, { playlistId: 'p', keys: ['a', 'b'], sourceKeys: ['a', 'b'] });
    expect(out.removed).toEqual(['a']);
    expect(out.failed).toEqual([{ key: 'b', error: 'HTTP 500', step: 'remove' }]);
    expect(out.retryKeys).toEqual(['b']);
  });
});

describe('executeUndo', () => {
  it('reports a failed order restore without hiding the rest', async () => {
    const { api } = fakeApi({ p: ['a'] }, [{ call: 'reorder' }]);
    const out = await executeUndo(api, { steps: [{ kind: 'add', playlistId: 'p', keys: ['b'], restoreOrder: ['b', 'a'] }] });
    expect(out.failed).toEqual([{ key: '(order)', error: 'HTTP 500', step: 'reorder' }]);
    expect(out.details.p.songKeys).toEqual(['a', 'b']);
  });

  it('reports progress over all steps', async () => {
    const { api } = fakeApi({ p: ['a', 'b'], q: [] });
    const seen: Array<[number, number]> = [];
    await executeUndo(
      api,
      { steps: [{ kind: 'remove', playlistId: 'p', keys: ['a', 'b'] }, { kind: 'add', playlistId: 'q', keys: ['z'] }] },
      (p) => seen.push([p.done, p.total]),
    );
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]]);
  });
});
