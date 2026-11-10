import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Look and feel (spec 2026-11-10-web-look-and-feel-rethink-design.md): every page lives in ONE shell (top bar, menu, player bar) and no
// page draws a header of its own any more. A route outside the shell would open unframed; a page with its own header would show two.

const SRC = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(SRC, 'App.tsx'), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

describe('the shell wraps every page', () => {
  it('every route sits inside the AppShell layout route', () => {
    const open = APP.indexOf('<Route element={<AppShell />}>');
    expect(open, 'App.tsx has no AppShell layout route').toBeGreaterThan(-1);
    const close = APP.indexOf('</Route>', open);
    expect(close).toBeGreaterThan(open);
    const routes = [...APP.matchAll(/<Route path=/g)].map((m) => m.index ?? -1);
    expect(routes.length).toBeGreaterThanOrEqual(15);
    for (const at of routes) {
      expect(at > open && at < close, `a <Route path=…> is outside the AppShell (offset ${at})`).toBe(true);
    }
  });

  it('the old floating mini player is gone: the player bar of the shell is the only player', () => {
    expect(APP).not.toMatch(/MiniPlayer/);
    expect(existsSync(join(SRC, 'components/MiniPlayer.tsx'))).toBe(false);
  });
});

describe('no page draws a header of its own', () => {
  it('the old Header component is gone and nobody imports it', () => {
    expect(existsSync(join(SRC, 'components/Header.tsx'))).toBe(false);
    const importers = sourceFiles(SRC).filter((f) => /from ['"][./]+\/components\/Header['"]|from ['"]\.\/Header['"]/.test(readFileSync(f, 'utf8')));
    expect(importers.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });

  it('no component renders the classes of the old header', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => /sr-header|sr-nav-link|sr-brand/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});
