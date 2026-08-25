import { promises as fs } from 'fs';
import path from 'path';
import { query } from '../utils/db';

/**
 * Apply every migration file, in filename order, at boot.
 *
 * There is no tracking table and none is needed: every migration in this
 * project is written with IF NOT EXISTS, so re-applying one is a no-op. That
 * property is what keeps this honest — the day someone writes a migration that
 * is not idempotent, this runner is the wrong tool and they must say so.
 *
 * A failure is fatal. A server that keeps running against a schema it could not
 * finish shaping will fail later, further from the cause, on a request from a
 * user rather than on a line in the boot log.
 */
export async function runMigrations(): Promise<string[]> {
  const dir = process.env.MIGRATIONS_DIR
    ?? path.join(__dirname, 'migrations');

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    // Nothing to apply: a dev checkout without the directory, or an image that
    // did not ship it. The Dockerfile COPY is what makes this branch not fire
    // in production.
    return [];
  }

  const sql = names.filter((n) => n.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const name of sql) {
    const text = await fs.readFile(path.join(dir, name), 'utf8');
    try {
      await query(text);
    } catch (err) {
      throw new Error(`migration ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    applied.push(name);
  }

  return applied;
}
