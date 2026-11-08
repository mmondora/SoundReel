/**
 * Apple Push Notification service, from Node's own `crypto` and `http2` (no dependency; ADR-0015).
 *
 * Dormant until the APNs auth key exists: without `APNS_KEY_ID`, `APNS_TEAM_ID` and a readable `APNS_KEY_FILE` the
 * sender is `null` and nothing is ever sent. The key (`AuthKey_<KeyID>.p8`) lives outside the repository
 * (`~/.config/soundreel/apns/`, 0600, like the FRITZ credentials); only its path is configured, and neither the key
 * nor a device token is ever logged.
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';
import { logInfo, logWarning } from '../utils/logger';

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** The app's bundle id. */
  topic: string;
  privateKey: KeyObject;
}

export type PushEnvironment = 'development' | 'production';

export interface PushTarget {
  token: string;
  environment: PushEnvironment;
}

export type PushOutcome = 'sent' | 'invalid_token' | 'failed';

export interface ApnsRequest {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface ApnsResponse {
  status: number;
  /** Apple's reason string for a refusal (`BadDeviceToken`, `ExpiredProviderToken`, …). */
  reason: string | null;
}

export type ApnsTransport = (req: ApnsRequest) => Promise<ApnsResponse>;

export const APNS_HOSTS: Record<PushEnvironment, string> = {
  development: 'api.sandbox.push.apple.com',
  production: 'api.push.apple.com',
};

/** Apple asks for a new provider token no more than every 20 minutes and none older than 60: refresh at 50. */
export const PROVIDER_TOKEN_TTL_MS = 50 * 60_000;
export const DEFAULT_TOPIC = 'it.mikesoft.mondrop';

/** A device token is hex; refusing anything else keeps a hostile string out of the request path. */
export const isDeviceToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-fA-F]{32,200}$/.test(value);

type Env = Record<string, string | undefined>;

export function loadApnsConfig(env: Env = process.env, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const file = env.APNS_KEY_FILE?.trim();
  if (!keyId || !teamId || !file) return null;
  try {
    return { keyId, teamId, topic: env.APNS_TOPIC?.trim() || DEFAULT_TOPIC, privateKey: createPrivateKey(read(file)) };
  } catch (err) {
    // The message of a key parse error never contains the key; the path is not a secret.
    logWarning('APNs key not readable: push stays off', { file, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/** The ES256 JWT that proves to APNs who is sending (`kid` = key id, `iss` = team id). */
export function createProviderToken(cfg: Pick<ApnsConfig, 'keyId' | 'teamId' | 'privateKey'>, nowSec: number): string {
  const signingInput = `${b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }))}.${b64url(JSON.stringify({ iss: cfg.teamId, iat: nowSec }))}`;
  const signature = sign('sha256', Buffer.from(signingInput), { key: cfg.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}

/** One HTTP/2 session per push: a handful a day, so a pool would only add things to go wrong. */
export const http2Transport: ApnsTransport = (req) =>
  new Promise((resolve, reject) => {
    const session = http2.connect(`https://${req.host}`);
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      session.close();
      fn();
    };
    session.on('error', (err) => done(() => reject(err)));
    const stream = session.request({ ':method': 'POST', ':path': req.path, ...req.headers });
    let status = 0;
    let data = '';
    stream.on('response', (headers) => {
      status = Number(headers[':status']);
    });
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      data += chunk;
    });
    stream.on('end', () => {
      let reason: string | null = null;
      try {
        const parsed = JSON.parse(data) as { reason?: unknown };
        reason = typeof parsed.reason === 'string' ? parsed.reason : null;
      } catch {
        /* an empty body is the normal answer to a 200 */
      }
      done(() => resolve({ status, reason }));
    });
    stream.on('error', (err) => done(() => reject(err)));
    stream.setTimeout(15_000, () => {
      stream.close();
      done(() => reject(new Error('APNs timeout')));
    });
    stream.end(req.body);
  });

export type ApnsSender = (target: PushTarget, payload: Record<string, unknown>) => Promise<PushOutcome>;

export function createApnsSender(cfg: ApnsConfig, transport: ApnsTransport = http2Transport, now: () => number = Date.now): ApnsSender {
  let cached: { value: string; at: number } | null = null;
  const providerToken = (): string => {
    if (!cached || now() - cached.at > PROVIDER_TOKEN_TTL_MS) {
      cached = { value: createProviderToken(cfg, Math.floor(now() / 1000)), at: now() };
    }
    return cached.value;
  };

  return async (target, payload) => {
    if (!isDeviceToken(target.token)) return 'invalid_token';
    const body = JSON.stringify(payload);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let res: ApnsResponse;
      try {
        res = await transport({
          host: APNS_HOSTS[target.environment],
          path: `/3/device/${target.token}`,
          headers: {
            authorization: `bearer ${providerToken()}`,
            'apns-topic': cfg.topic,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'content-type': 'application/json',
          },
          body,
        });
      } catch (err) {
        logWarning('APNs request failed', { error: err instanceof Error ? err.message : String(err) });
        return 'failed';
      }
      if (res.status === 200) return 'sent';
      // Our provider token went stale: sign a new one and try once more.
      if (res.status === 403 && /ProviderToken/.test(res.reason ?? '') && attempt === 0) {
        cached = null;
        continue;
      }
      // The phone no longer wants this token (app removed, token rotated, wrong environment): forget it.
      if (res.status === 410 || (res.status === 400 && /BadDeviceToken|DeviceTokenNotForTopic|Unregistered/.test(res.reason ?? ''))) {
        return 'invalid_token';
      }
      logWarning('APNs refused a push', { status: res.status, reason: res.reason });
      return 'failed';
    }
    return 'failed';
  };
}

let sender: ApnsSender | null | undefined;

/** The process-wide sender, or `null` while the key is missing (read once). */
export function getApnsSender(): ApnsSender | null {
  if (sender === undefined) {
    const cfg = loadApnsConfig();
    sender = cfg ? createApnsSender(cfg) : null;
    logInfo(sender ? 'APNs push is on' : 'APNs push is off (no key configured)');
  }
  return sender;
}

/** Tests only. */
export function resetApnsSenderForTests(next?: ApnsSender | null): void {
  sender = next;
}
