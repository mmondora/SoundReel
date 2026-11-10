import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollections } from './useCollections';
import * as api from '../services/api';
import type { CollectionListItem } from '../types';

vi.mock('../services/api', () => ({ fetchCollections: vi.fn() }));

const fetchAll = vi.mocked(api.fetchCollections);
const item = (id: string, name: string): CollectionListItem => ({ id, name, kind: 'theme', group: null, parentId: null, count: 5, isNew: false, thumbs: [], views: ['grid'], defaultView: 'grid' });

beforeEach(() => { fetchAll.mockReset(); });

describe('useCollections', () => {
  it('asks once and gives the collections in the order the server decided', async () => {
    fetchAll.mockResolvedValue([item('b', 'Vino'), item('a', 'Casa')]);
    const { result } = renderHook(() => useCollections());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.collections.map((c) => c.name)).toEqual(['Vino', 'Casa']);
    expect(result.current.failed).toBe(false);
    expect(fetchAll).toHaveBeenCalledTimes(1);
    expect(fetchAll).toHaveBeenCalledWith('active');
  });

  it('a state can be asked for (the hidden ones)', async () => {
    fetchAll.mockResolvedValue([]);
    const { result } = renderHook(() => useCollections('hidden'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchAll).toHaveBeenCalledWith('hidden');
  });

  it('a failure is «failed», not a crash, and the list is empty; reload tries again', async () => {
    fetchAll.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([item('a', 'Vino')]);
    const { result } = renderHook(() => useCollections());
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.collections).toEqual([]);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.collections).toHaveLength(1));
    expect(result.current.failed).toBe(false);
  });

  it('an answer that arrives after the page is gone, or after a newer one, is dropped', async () => {
    let first!: (v: CollectionListItem[]) => void;
    fetchAll.mockReturnValueOnce(new Promise((resolve) => { first = resolve; })).mockResolvedValueOnce([item('n', 'Nuova')]);
    const { result } = renderHook(() => useCollections());
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.collections.map((c) => c.name)).toEqual(['Nuova']));
    await act(async () => { first([item('o', 'Vecchia')]); });
    expect(result.current.collections.map((c) => c.name)).toEqual(['Nuova']);
  });

  it('an empty library is an empty list, not a failure', async () => {
    fetchAll.mockResolvedValue([]);
    const { result } = renderHook(() => useCollections());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ collections: [], failed: false });
  });
});
