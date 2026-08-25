import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

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

  /**
   * The runner's own doc says a silent no-op is worse than having no runner.
   * These two pin the only way that no-op can happen in a built image: the
   * default path and the Dockerfile COPY destination drifting apart. They did —
   * files at /app/migrations, runner looking in /app/dist/db/migrations — and
   * only MIGRATIONS_DIR in docker-compose.yml hid it, so a hand-run container
   * booted green against a schema with no `kind`, `priority` or `reanalyze`.
   */
  describe('finds its files without being told where they are', () => {
    it('defaults to the directory beside the compiled runner', async () => {
      delete process.env.MIGRATIONS_DIR;
      const seen: string[] = [];
      vi.doMock('fs', async () => {
        const actual = await vi.importActual<typeof import('fs')>('fs');
        return {
          ...actual,
          promises: {
            ...actual.promises,
            readdir: vi.fn(async (p: string) => { seen.push(String(p)); return []; }),
          },
        };
      });
      const { runMigrations } = await import('./runMigrations');
      await runMigrations();
      expect(seen).toEqual([path.join(__dirname, 'migrations')]);
    });

    it('the image ships the .sql files exactly where that default looks', () => {
      const dockerfile = readFileSync(path.join(__dirname, '../../../Dockerfile'), 'utf8');
      const copy = dockerfile
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('#'))
        .find((l) => l.includes('backend/src/db/migrations'));
      expect(copy).toBeDefined();
      // WORKDIR is /app and the compiled runner is dist/db/runMigrations.js,
      // so __dirname there is /app/dist/db.
      expect(copy).toMatch(/COPY\s+backend\/src\/db\/migrations\s+\.\/dist\/db\/migrations\s*$/);
    });

    it('does not depend on MIGRATIONS_DIR being set in compose', () => {
      const compose = readFileSync(path.join(__dirname, '../../../docker-compose.yml'), 'utf8');
      expect(compose).not.toMatch(/^\s*MIGRATIONS_DIR:/m);
    });
  });

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
