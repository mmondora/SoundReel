/**
 * The phones that asked to be rung (ADR-0015). The token is the key: a phone handed to somebody else simply
 * registers again under the new user. Tokens are only ever read by the announcer and never logged.
 */
import { query } from '../utils/db';
import type { PushEnvironment, PushTarget } from './apnsClient';

export async function registerPushDevice(input: {
  token: string;
  userId: string;
  environment: PushEnvironment;
  device?: string;
}): Promise<void> {
  await query(
    `INSERT INTO push_devices (token, user_id, environment, device)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE SET
       user_id = EXCLUDED.user_id, environment = EXCLUDED.environment, device = EXCLUDED.device, last_seen_at = now()`,
    [input.token, input.userId, input.environment, (input.device ?? '').slice(0, 100)],
  );
}

/** A user can only remove his own phones. `false` when that token was not his (or not there). */
export async function unregisterPushDevice(userId: string, token: string): Promise<boolean> {
  const rows = await query<{ token: string }>(
    `DELETE FROM push_devices WHERE token = $1 AND user_id = $2 RETURNING token`,
    [token, userId],
  );
  return rows.length > 0;
}

export async function devicesForUser(userId: string): Promise<PushTarget[]> {
  const rows = await query<{ token: string; environment: string }>(
    `SELECT token, environment FROM push_devices WHERE user_id = $1 ORDER BY last_seen_at DESC`,
    [userId],
  );
  return rows.map((r) => ({ token: r.token, environment: r.environment === 'development' ? 'development' : 'production' }));
}

/** Apple said the token is dead: forget it. */
export async function removePushDevice(token: string): Promise<void> {
  await query(`DELETE FROM push_devices WHERE token = $1`, [token]);
}
