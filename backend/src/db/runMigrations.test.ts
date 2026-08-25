import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../utils/db', () => ({ query: (...a: unknown[]) => queryMock(...a) }));

describe('runMigrations', () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    queryMock.mockResolvedValue([]);
  });

  async function withFiles(names: string[], contents: Record<string, string> = {}) {
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        promises: {
          ...actual.promises,
          readdir: vi.fn(async () => names),
          readFile: vi.fn(async (p: string) => contents[String(p).split('/').pop() ?? ''] ?? 'SELECT 1;'),
        },
      };
    });
    const { runMigrations } = await import('./runMigrations');
    return runMigrations();
  }

  it('applies migrations in filename order, not directory order', async () => {
    const applied = await withFiles(['010_b.sql', '002_a.sql', '009_c.sql']);
    expect(applied).toEqual(['002_a.sql', '009_c.sql', '010_b.sql']);
  });

  it('ignores files that are not .sql', async () => {
    const applied = await withFiles(['001_a.sql', 'README.md', '.keep']);
    expect(applied).toEqual(['001_a.sql']);
  });

  it('returns an empty list when the directory is missing', async () => {
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        promises: { ...actual.promises, readdir: vi.fn(async () => { throw new Error('ENOENT'); }) },
      };
    });
    const { runMigrations } = await import('./runMigrations');
    await expect(runMigrations()).resolves.toEqual([]);
  });

  it('throws on a failing migration rather than continuing', async () => {
    queryMock.mockRejectedValueOnce(new Error('syntax error'));
    await expect(withFiles(['001_broken.sql'])).rejects.toThrow(/001_broken\.sql/);
  });

  it('stops at the first failure instead of applying later ones', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));
    await expect(withFiles(['001_a.sql', '002_b.sql'])).rejects.toThrow();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
