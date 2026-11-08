/**
 * Shared SoundReel API-key check (`X-SoundReel-Key`).
 * Used by /api/share and /api/mondrop/* until Authelia OIDC Bearer lands.
 *
 * Keys issued through `/mondrop/connect` are bound to the Authelia user that
 * asked for them (`config.apiKeys.meta`, keyed by `apiKeyId`). Legacy keys
 * (`/api/share/mint-key`, hand-made) have no owner: the caller keeps choosing
 * the user via body/query/header, exactly as before.
 */
import { timingSafeEqual, createHash } from 'node:crypto';
import { getApiKeysConfig } from './db';

function safeEqualString(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Stable, non-reversible id of a key — used as the `meta` map key (never store the key twice). */
export function apiKeyId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

export interface ApiKeyOwner {
  /** Authelia id the key is bound to (`mike` | `archi` | `sara`). */
  user: string;
  /** Device label the key was issued for. */
  device: string;
}

export interface ApiKeyAuth {
  /** `null` for legacy keys that are not bound to a user. */
  owner: ApiKeyOwner | null;
}

/**
 * Validate the presented key. Returns `null` when missing/invalid, otherwise the
 * bound owner (if any). One config read per request.
 */
export async function authenticateApiKey(
  header: string | string[] | undefined,
): Promise<ApiKeyAuth | null> {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || !raw.trim()) return null;
  const presented = raw.trim();
  const cfg = await getApiKeysConfig();
  const keys = (cfg.keys ?? []).filter((k) => typeof k === 'string' && k.length >= 16);
  const stored = keys.find((k) => safeEqualString(k, presented));
  if (!stored) return null;
  const meta = cfg.meta?.[apiKeyId(stored)];
  return { owner: meta ? { user: meta.user, device: meta.device } : null };
}

export async function authorizeApiKey(
  header: string | string[] | undefined,
): Promise<boolean> {
  return (await authenticateApiKey(header)) !== null;
}
