import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSearch } from './useSearch';
import * as api from '../services/api';

vi.mock('../services/api', () => ({
  searchEntries: vi.fn(),
}));

const mockResults = [
  {
    id: '1',
    sourceUrl: 'https://a.com',
    sourcePlatform: 'youtube',
    caption: null,
    thumbnailUrl: null,
    results: { songs: [], films: [], notes: [], tags: [], summary: 'test' },
    createdAt: '2026-06-23T00:00:00Z',
    rank: 0.9,
  },
];

describe('useSearch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns initial state for short query', () => {
    const { result } = renderHook(() => useSearch('a'));
    expect(result.current.results).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('returns initial state for empty query', () => {
    const { result } = renderHook(() => useSearch(''));
    expect(result.current.results).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('sets loading true while fetching', async () => {
    vi.useFakeTimers();
    vi.mocked(api.searchEntries).mockResolvedValue({ results: mockResults, expandedTerms: [], total: 1 });
    const { result } = renderHook(() => useSearch('spotify'));
    // The hook sets loading:true immediately (before the debounce timer fires)
    expect(result.current.loading).toBe(true);
    // Fire the debounce and flush all pending microtasks
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(result.current.loading).toBe(false);
    vi.useRealTimers();
  });

  it('returns results after debounce', async () => {
    vi.useFakeTimers();
    vi.mocked(api.searchEntries).mockResolvedValue({ results: mockResults, expandedTerms: ['music'], total: 1 });
    const { result } = renderHook(() => useSearch('spotify'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(result.current.results).toHaveLength(1);
    expect(result.current.expandedTerms).toEqual(['music']);
    vi.useRealTimers();
  });

  it('does not fetch before debounce delay', async () => {
    vi.useFakeTimers();
    renderHook(() => useSearch('spotify'));
    act(() => { vi.advanceTimersByTime(300); });
    expect(api.searchEntries).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('sets error on fetch failure', async () => {
    vi.useFakeTimers();
    vi.mocked(api.searchEntries).mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useSearch('spotify'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(result.current.error).not.toBeNull();
    expect(result.current.error).toContain('network error');
    vi.useRealTimers();
  });
});
