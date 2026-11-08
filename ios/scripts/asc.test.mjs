// node --test ios/scripts/asc.test.mjs   (no network: a fake fetch, a throw-away key)
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { createClient, createToken, describeErrors, findApp, groupsNamed, loadConfig, parseEnvFile, statusReport } from './asc.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const cfg = { keyId: 'ABC123DEFG', issuerId: '57246542-96fe-1a63-e053-0824d011072a', keyPath: '/k.p8' };
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

test('the config file is KEY=VALUE, with comments and quotes, and the environment wins', () => {
  assert.deepEqual(parseEnvFile('# c\nASC_KEY_ID=ABC\nASC_ISSUER_ID="uuid"\n\nASC_KEY_PATH=\'/k.p8\'\nbroken\n'), { ASC_KEY_ID: 'ABC', ASC_ISSUER_ID: 'uuid', ASC_KEY_PATH: '/k.p8' });
  const file = 'ASC_KEY_ID=FROMFILE\nASC_ISSUER_ID=i\nASC_KEY_PATH=/k.p8\n';
  const c = loadConfig({ ASC_KEY_ID: 'FROMENV' }, '/f', () => file, () => true);
  assert.equal(c.keyId, 'FROMENV');
  assert.equal(c.issuerId, 'i');
});

test('a missing setting is named, a value never is', () => {
  assert.throws(() => loadConfig({}, '/nope', () => '', () => false), /missing ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH/);
  assert.throws(() => loadConfig({ ASC_KEY_ID: 'SECRETISH' }, '/nope', () => '', () => false), (e) => !/SECRETISH/.test(e.message) && /ASC_ISSUER_ID/.test(e.message));
});

test('the token is an ES256 JWT for the App Store Connect audience, valid 15 minutes, with a raw signature', () => {
  const jwt = createToken(cfg, privateKey, 1_794_000_000);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(decode(h), { alg: 'ES256', kid: 'ABC123DEFG', typ: 'JWT' });
  assert.deepEqual(decode(p), { iss: cfg.issuerId, iat: 1_794_000_000, exp: 1_794_000_900, aud: 'appstoreconnect-v1' });
  assert.equal(Buffer.from(s, 'base64url').length, 64);
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.ok(!/[=+/]/.test(jwt));
});

test('API errors are one readable line each, nothing else', () => {
  assert.equal(describeErrors(403, { errors: [{ code: 'FORBIDDEN_ERROR', title: 'This request is forbidden for security reasons', detail: 'The API key in use does not allow this request' }] }),
    'HTTP 403 FORBIDDEN_ERROR This request is forbidden for security reasons: The API key in use does not allow this request');
  assert.equal(describeErrors(500, null), 'HTTP 500');
});

function fake(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, auth: init.headers.authorization });
    const path = String(url).replace('https://api.appstoreconnect.apple.com', '');
    const hit = routes.find(([re]) => re.test(path));
    if (!hit) return { ok: false, status: 404, text: async () => JSON.stringify({ errors: [{ title: 'Not found', detail: path }] }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(hit[1]) };
  };
  return { client: createClient(cfg, { fetchImpl, readKey: () => PEM, now: () => 1_794_000_000 }), calls };
}

test('every call carries a bearer token; a failed call throws the API message', async () => {
  const { client, calls } = fake([]);
  await assert.rejects(client.get('/v1/apps'), /HTTP 404 Not found: \/v1\/apps/);
  assert.match(calls[0].auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
});

test('lists follow links.next and merge included', async () => {
  const { client, calls } = fake([
    [/page=2/, { data: [{ id: '3' }], included: [{ id: 'x2' }] }],
    [/^\/v1\/things/, { data: [{ id: '1' }, { id: '2' }], included: [{ id: 'x1' }], links: { next: 'https://api.appstoreconnect.apple.com/v1/things?page=2' } }],
  ]);
  const r = await client.list('/v1/things?limit=2');
  assert.deepEqual(r.data.map((d) => d.id), ['1', '2', '3']);
  assert.deepEqual(r.included.map((d) => d.id), ['x1', 'x2']);
  assert.equal(calls.length, 2);
});

test('findApp asks for the Mondrop bundle id; no record is null', async () => {
  const { client, calls } = fake([[/filter\[bundleId\]=it\.mikesoft\.mondrop/, { data: [] }]]);
  assert.equal(await findApp(client), null);
  assert.match(calls[0].url, /filter\[bundleId\]=it\.mikesoft\.mondrop/);
});

test('status: the app, its builds with the version they belong to, its groups and their testers', async () => {
  const { client } = fake([
    [/^\/v1\/apps\?filter/, { data: [{ id: 'A1', attributes: { name: 'Mondrop', bundleId: 'it.mikesoft.mondrop' } }] }],
    [/^\/v1\/builds/, { data: [{ id: 'B1', attributes: { version: '7', processingState: 'VALID', expired: false, uploadedDate: '2026-11-08T10:00:00Z' }, relationships: { preReleaseVersion: { data: { id: 'V1' } } } }], included: [{ type: 'preReleaseVersions', id: 'V1', attributes: { version: '1.6.0' } }] }],
    [/^\/v1\/apps\/A1\/betaGroups/, { data: [{ id: 'G1', attributes: { name: 'Family', isInternalGroup: false } }] }],
    [/^\/v1\/betaGroups\/G1\/betaTesters/, { data: [{ id: 'T1', attributes: { email: 'sara@example.com', firstName: 'Sara', lastName: 'S', state: 'INSTALLED' } }] }],
  ]);
  const report = await statusReport(client);
  assert.deepEqual(report.app, { id: 'A1', name: 'Mondrop', bundleId: 'it.mikesoft.mondrop' });
  assert.deepEqual(report.builds.map((b) => [b.version, b.state]), [['1.6.0 (7)', 'VALID']]);
  assert.deepEqual(report.groups, [{ name: 'Family', internal: false, testers: [{ email: 'sara@example.com', name: 'Sara S', state: 'INSTALLED' }] }]);
});

test('groups by name: across the whole team, with the app each belongs to', async () => {
  const { client } = fake([
    [/^\/v1\/betaGroups\?filter\[name\]=Family/, { data: [{ id: 'G9', attributes: { name: 'Family', isInternalGroup: false }, relationships: { app: { data: { id: 'A9' } } } }], included: [{ type: 'apps', id: 'A9', attributes: { name: 'Mneme' } }] }],
    [/^\/v1\/betaGroups\/G9\/betaTesters/, { data: [{ id: 'T1', attributes: { email: 'archi@example.com', firstName: 'Archi' } }] }],
  ]);
  const [g] = await groupsNamed(client, 'Family');
  assert.equal(g.app, 'Mneme');
  assert.deepEqual(g.testers.map((t) => t.email), ['archi@example.com']);
});
