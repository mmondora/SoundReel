/**
 * Issue / rotate per-user API keys for the Mondrop app.
 *
 * One live key per (user, device label). Asking again for the same slot
 * revokes the previous key — that is what "Rinnova API key" means. Keys of
 * other devices of the same user are untouched.
 *
 * Storage: raw key in `config.apiKeys.keys` (what `authenticateApiKey` checks),
 * owner bookkeeping in `config.apiKeys.meta[apiKeyId(key)]`.
 */
import { randomBytes } from 'node:crypto';
import { getApiKeysConfig, updateApiKeysConfig, type ApiKeyMeta } from '../utils/db';
import { apiKeyId } from '../utils/apiKeyAuth';

/** Live keys kept per user. Beyond this the oldest is revoked (renamed devices would pile up otherwise). */
export const MAX_KEYS_PER_USER = 8;

export interface IssuedApiKey {
  key: string;
  user: string;
  device: string;
  /** True when a previous key of the same user + device was revoked. */
  replaced: boolean;
}

/** Strip control chars, collapse whitespace, cap at 60 chars; fall back when empty. */
export function normalizeDeviceLabel(raw: unknown, fallback = 'device'): string {
  const text = typeof raw === 'string' ? raw : '';
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return cleaned || fallback;
}

/** Best-effort label when the client did not send one (plain browser flow). */
export function guessDeviceLabel(userAgent: string | string[] | undefined): string {
  const ua = String(Array.isArray(userAgent) ? userAgent[0] : userAgent ?? '');
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Android/i.test(ua)) return 'Android';
  return 'browser';
}

// Config is one JSON row (read-modify-write): serialize issuers inside this process.
let tail: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn);
  tail = run.catch(() => undefined);
  return run;
}

export function issueUserApiKey(user: string, device: string): Promise<IssuedApiKey> {
  return serialize(async () => {
    const cfg = await getApiKeysConfig();
    const keys = (cfg.keys ?? []).filter((k): k is string => typeof k === 'string');
    const meta: Record<string, ApiKeyMeta> = { ...(cfg.meta ?? {}) };

    // Forget bookkeeping of keys that no longer exist (e.g. removed by hand).
    const live = new Set(keys.map(apiKeyId));
    for (const id of Object.keys(meta)) {
      if (!live.has(id)) delete meta[id];
    }

    const ownMeta = (k: string): ApiKeyMeta | undefined => {
      const m = meta[apiKeyId(k)];
      return m && m.user === user ? m : undefined;
    };
    const slot = device.toLowerCase();
    const sameSlot = (k: string): boolean => ownMeta(k)?.device.toLowerCase() === slot;

    const replaced = keys.some(sameSlot);
    let next = keys.filter((k) => !sameSlot(k));

    // Cap: make room for the new key by revoking this user's oldest ones.
    const mine = next
      .map((k) => ({ k, at: ownMeta(k)?.createdAt }))
      .filter((x): x is { k: string; at: string } => typeof x.at === 'string')
      .sort((a, b) => a.at.localeCompare(b.at));
    const overflow = Math.max(0, mine.length - (MAX_KEYS_PER_USER - 1));
    const dropped = new Set(mine.slice(0, overflow).map((x) => x.k));
    next = next.filter((k) => !dropped.has(k));

    // Drop bookkeeping of everything revoked above.
    const kept = new Set(next);
    for (const k of keys) {
      if (!kept.has(k)) delete meta[apiKeyId(k)];
    }

    const key = `sr_${randomBytes(24).toString('base64url')}`;
    next.push(key);
    meta[apiKeyId(key)] = { user, device, createdAt: new Date().toISOString() };
    await updateApiKeysConfig({ keys: next, meta });
    return { key, user, device, replaced };
  });
}
