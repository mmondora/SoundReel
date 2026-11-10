import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The nightly pass of the collections (ADR-0022) runs inside the server: it is started once at the boot (the first pass about ten minutes later, never
// at the boot itself) and stopped when the server stops. COLLECTIONS_AUTO=0 makes `startNightlyConsolidation()` start nothing (collectionsNightly.test.ts).

const raw = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
// comments do not count: a start that is commented out is no start
const server = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('server.ts and the nightly pass of the collections', () => {
  it('imports it from its own file', () => {
    expect(server).toContain("import { startNightlyConsolidation } from './services/collectionsNightly';");
  });

  it('starts it exactly once, with the real dependencies', () => {
    expect(server.match(/startNightlyConsolidation\(\)/g)).toHaveLength(1);
    expect(server).toMatch(/const nightlyCollections = startNightlyConsolidation\(\);/);
  });

  it('stops it when the server stops, once', () => {
    expect(server.match(/nightlyCollections\.stop\(\);/g)).toHaveLength(1);
    expect(server.indexOf('nightlyCollections.stop();')).toBeGreaterThan(server.indexOf('const shutdown'));
  });

  it('starts it after the queue of the analyses (what it reads is made by them)', () => {
    expect(server.indexOf('startNightlyConsolidation()')).toBeGreaterThan(server.indexOf('startJobQueueWorker()'));
  });

  it('says in the log when it will run first', () => {
    expect(raw).toMatch(/Collections nightly pass scheduled \(first run in about 10 minutes, then every 24 hours\)/);
  });
});
