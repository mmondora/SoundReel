import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Rule P (ADR-0018, spec 2026-11-08-mondrop-search-spotify-style-design.md S9/S11): the clients talk only to SoundReel. Which
// network a request comes from, where a song's file is and what plays are the SERVER's to decide: the web player asks
// `GET /api/songs/:key/play?prefer=…` and follows the answer. This scan keeps the old logic from growing back into the
// browser: no call of the old network route, no function that resolves the "Sorgente" switch by itself, and no address or
// protocol of the home network. Every non-test .ts/.tsx under src is read, comments included (a comment that names one of
// these is a sign the code still knows about it); the match ignores the case.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every .ts / .tsx file under `dir` that is not a test. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const FILES = sourceFiles(SRC).map((full) => ({ name: relative(SRC, full), lines: readFileSync(full, 'utf8').split('\n') }));

/** Where `token` shows up (file:line), ignoring the case. */
function offenders(token: string): string[] {
  const needle = token.toLowerCase();
  return FILES.flatMap(({ name, lines }) =>
    lines.flatMap((line, i) => (line.toLowerCase().includes(needle) ? [`${name}:${i + 1}`] : [])),
  );
}

const FORBIDDEN: Array<[token: string, why: string]> = [
  ['/api/net', 'the network is the server’s to see: the browser learns it from the play plan, not from a route of its own'],
  ['fetchNetwork', 'a network test in the browser'],
  ['effectiveSource', 'the browser resolving the switch: the server does it (play plan)'],
  ['sourceChoiceFor', 'the browser resolving the switch: the server does it (play plan)'],
  ['192.168.', 'an address of the home network'],
  ['49152', 'a port of the media server'],
  ['49200', 'a port of the media server'],
  ['DLNA', 'the media server protocol is the server’s business'],
  ['UPnP', 'the media server protocol is the server’s business'],
];

describe('rule P: the browser makes no network test and no source choice', () => {
  it('the scan sees the player and the API client (it cannot pass by reading nothing)', () => {
    const names = FILES.map((f) => f.name.split('\\').join('/'));
    expect(names.length).toBeGreaterThan(50);
    expect(names).toContain('player/PlayerContext.tsx');
    expect(names).toContain('player/playbackSource.ts');
    expect(names).toContain('services/api.ts');
    expect(names.some((n) => /\.test\.tsx?$/.test(n))).toBe(false);
  });

  it.each(FORBIDDEN)('no "%s" in the sources of the browser (%s)', (token) => {
    expect(offenders(token)).toEqual([]);
  });

  it('the one question the player asks about where to play from is the play plan', () => {
    const player = FILES.find((f) => f.name.split('\\').join('/') === 'player/PlayerContext.tsx');
    const text = (player?.lines ?? []).join('\n');
    expect(text).toContain('fetchPlayPlan');
  });
});
