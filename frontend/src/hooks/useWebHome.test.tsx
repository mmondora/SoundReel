import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebHome } from './useWebHome';
import * as api from '../services/api';
import type { WebHomeResponse } from '../types';

vi.mock('../services/api', () => ({ fetchWebHome: vi.fn() }));

const fetchHome = vi.mocked(api.fetchWebHome);
const HOME: WebHomeResponse = { sections: [{ id: 'films', total: 1, items: [{ filmKey: 'dune::2021', title: 'Dune', year: '2021', posterUrl: null, imdbUrl: null, entryId: 'e1', sourceUrl: null, createdAt: '2026-11-10T10:00:00.000Z' }] }] };

beforeEach(() => { fetchHome.mockReset(); });

describe('useWebHome', () => {
  it('asks once and gives the sections', async () => {
    fetchHome.mockResolvedValue(HOME);
    const { result } = renderHook(() => useWebHome());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sections).toEqual(HOME.sections);
    expect(result.current.error).toBe(false);
    expect(fetchHome).toHaveBeenCalledTimes(1);
  });

  it('a Home that cannot be read is an error, and «reload» tries again', async () => {
    fetchHome.mockRejectedValueOnce(new Error('home failed')).mockResolvedValueOnce(HOME);
    const { result } = renderHook(() => useWebHome());
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.sections).toEqual([]);
    act(() => result.current.reload());
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBe(false);
    await waitFor(() => expect(result.current.sections).toEqual(HOME.sections));
    expect(fetchHome).toHaveBeenCalledTimes(2);
  });

  it('an answer that comes after the page is gone is dropped (no update of an unmounted page)', async () => {
    let answer!: (r: WebHomeResponse) => void;
    fetchHome.mockReturnValue(new Promise<WebHomeResponse>((resolve) => { answer = resolve; }));
    const { unmount } = renderHook(() => useWebHome());
    unmount();
    await act(async () => { answer(HOME); });
    expect(fetchHome).toHaveBeenCalledTimes(1);
  });

  it('a slow first answer does not replace the answer of a reload made after it', async () => {
    let first!: (r: WebHomeResponse) => void;
    fetchHome.mockReturnValueOnce(new Promise<WebHomeResponse>((resolve) => { first = resolve; })).mockResolvedValueOnce(HOME);
    const { result } = renderHook(() => useWebHome());
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.sections).toEqual(HOME.sections));
    await act(async () => { first({ sections: [] }); });
    expect(result.current.sections).toEqual(HOME.sections);
  });
});
