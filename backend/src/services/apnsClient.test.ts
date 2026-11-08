import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import {
  APNS_HOSTS,
  PROVIDER_TOKEN_TTL_MS,
  createApnsSender,
  createProviderToken,
  isDeviceToken,
  loadApnsConfig,
  type ApnsConfig,
  type ApnsRequest,
  type ApnsResponse,
} from './apnsClient';

// A throw-away P-256 key, the curve Apple's .p8 files use. Never a real credential.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TOKEN = 'a1'.repeat(32);

const env = { APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: '5NZADC9YQ2', APNS_KEY_FILE: '/run/secrets/apns/AuthKey_ABC123DEFG.p8' };
const cfg: ApnsConfig = { keyId: 'ABC123DEFG', teamId: '5NZADC9YQ2', topic: 'it.mikesoft.mondrop', privateKey };

describe('loadApnsConfig', () => {
  it('is off (null) until all three settings exist', () => {
    const read = vi.fn(() => PEM);
    expect(loadApnsConfig({}, read)).toBeNull();
    expect(loadApnsConfig({ ...env, APNS_KEY_ID: '' }, read)).toBeNull();
    expect(loadApnsConfig({ ...env, APNS_TEAM_ID: undefined }, read)).toBeNull();
    expect(loadApnsConfig({ ...env, APNS_KEY_FILE: '  ' }, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('loads the key from the configured file and defaults to the Mondrop bundle id', () => {
    const read = vi.fn(() => PEM);
    const loaded = loadApnsConfig(env, read);
    expect(read).toHaveBeenCalledWith(env.APNS_KEY_FILE);
    expect(loaded).toMatchObject({ keyId: 'ABC123DEFG', teamId: '5NZADC9YQ2', topic: 'it.mikesoft.mondrop' });
    expect(loadApnsConfig({ ...env, APNS_TOPIC: 'it.example.other' }, read)?.topic).toBe('it.example.other');
  });

  it('stays off, without throwing, when the file is missing or is not a key', () => {
    expect(loadApnsConfig(env, () => { throw new Error('ENOENT'); })).toBeNull();
    expect(loadApnsConfig(env, () => 'not a pem')).toBeNull();
  });
});

describe('createProviderToken', () => {
  const decode = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

  it('is an ES256 JWT naming the key and the team, with a raw 64-byte signature', () => {
    const jwt = createProviderToken(cfg, 1_794_000_000);
    const [header, claims, signature] = jwt.split('.');
    expect(decode(header)).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(decode(claims)).toEqual({ iss: '5NZADC9YQ2', iat: 1_794_000_000 });
    expect(jwt).not.toMatch(/[=+/]/); // base64url, no padding
    const raw = Buffer.from(signature, 'base64url');
    expect(raw.length).toBe(64);
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(true);
  });

  it('does not verify against a different key', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
    const [header, claims, signature] = createProviderToken(cfg, 1).split('.');
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: other, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(false);
  });
});

describe('isDeviceToken', () => {
  it('accepts hex only, so nothing hostile reaches the request path', () => {
    expect(isDeviceToken(TOKEN)).toBe(true);
    expect(isDeviceToken('xyz')).toBe(false);
    expect(isDeviceToken('a1'.repeat(8))).toBe(false); // too short
    expect(isDeviceToken(`${TOKEN}/../x`)).toBe(false);
    expect(isDeviceToken(42)).toBe(false);
  });
});

describe('the sender', () => {
  const payload = { aps: { alert: { title: 'Ciao', body: 'Corpo' } }, inboxId: 'i1' };
  const answer = (status: number, reason: string | null = null): ApnsResponse => ({ status, reason });

  it('sends to the sandbox for a development token and to production for a production one', async () => {
    const transport = vi.fn(async (_req: ApnsRequest) => answer(200));
    const send = createApnsSender(cfg, transport);
    expect(await send({ token: TOKEN, environment: 'development' }, payload)).toBe('sent');
    expect(await send({ token: TOKEN, environment: 'production' }, payload)).toBe('sent');
    expect(transport.mock.calls[0][0].host).toBe(APNS_HOSTS.development);
    expect(transport.mock.calls[1][0].host).toBe(APNS_HOSTS.production);
  });

  it('builds the request Apple expects', async () => {
    const transport = vi.fn(async (_req: ApnsRequest) => answer(200));
    await createApnsSender(cfg, transport, () => 1_794_000_000_000)({ token: TOKEN, environment: 'production' }, payload);
    const req = transport.mock.calls[0][0];
    expect(req.path).toBe(`/3/device/${TOKEN}`);
    expect(req.headers).toMatchObject({
      'apns-topic': 'it.mikesoft.mondrop',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });
    expect(req.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(req.body)).toEqual(payload);
  });

  it('forgets a token the phone no longer wants', async () => {
    for (const res of [answer(410, 'Unregistered'), answer(400, 'BadDeviceToken'), answer(400, 'DeviceTokenNotForTopic')]) {
      const send = createApnsSender(cfg, async () => res);
      expect(await send({ token: TOKEN, environment: 'production' }, payload)).toBe('invalid_token');
    }
  });

  it('reports a plain failure (and keeps the token) for anything else', async () => {
    for (const res of [answer(400, 'PayloadEmpty'), answer(429, 'TooManyRequests'), answer(500, 'InternalServerError'), answer(503)]) {
      const send = createApnsSender(cfg, async () => res);
      expect(await send({ token: TOKEN, environment: 'production' }, payload)).toBe('failed');
    }
  });

  it('never throws when the network does', async () => {
    const send = createApnsSender(cfg, async () => { throw new Error('socket hang up'); });
    expect(await send({ token: TOKEN, environment: 'production' }, payload)).toBe('failed');
  });

  it('refuses a token that is not hex without calling Apple', async () => {
    const transport = vi.fn(async () => answer(200));
    expect(await createApnsSender(cfg, transport)({ token: '../etc/passwd', environment: 'production' }, payload)).toBe('invalid_token');
    expect(transport).not.toHaveBeenCalled();
  });

  it('signs a new provider token and retries once when Apple says ours expired', async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(answer(403, 'ExpiredProviderToken'))
      .mockResolvedValueOnce(answer(200));
    const send = createApnsSender(cfg, transport, () => 1_794_000_000_000);
    expect(await send({ token: TOKEN, environment: 'production' }, payload)).toBe('sent');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('gives up after that one retry', async () => {
    const transport = vi.fn(async () => answer(403, 'InvalidProviderToken'));
    expect(await createApnsSender(cfg, transport)({ token: TOKEN, environment: 'production' }, payload)).toBe('failed');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('reuses its provider token for 50 minutes, then signs a new one', async () => {
    let t = 1_794_000_000_000;
    const auth: string[] = [];
    const transport = vi.fn(async (req: ApnsRequest) => { auth.push(req.headers.authorization); return answer(200); });
    const send = createApnsSender(cfg, transport, () => t);
    await send({ token: TOKEN, environment: 'production' }, payload);
    t += PROVIDER_TOKEN_TTL_MS - 1000;
    await send({ token: TOKEN, environment: 'production' }, payload);
    t += 2000;
    await send({ token: TOKEN, environment: 'production' }, payload);
    expect(auth[1]).toBe(auth[0]);
    expect(auth[2]).not.toBe(auth[0]);
  });
});
