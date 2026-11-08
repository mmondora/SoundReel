// node --test ios/scripts/asc.test.mjs   (no network: a fake fetch, a throw-away key)
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { addTesters, assignBuild, createClient, createToken, describeErrors, ensureExternalGroup, findApp, findBuild, groupsNamed, inviteGroupTesters, loadConfig, parseEnvFile, statusReport, submitForReview } from './asc.mjs';

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
  assert.throws(() => loadConfig({}, '/nope', () => '', () => false), /missing ASC_KEY_ID, ASC_KEY_PATH/);
  assert.throws(() => loadConfig({ ASC_KEY_ID: 'SECRETISH' }, '/nope', () => '', () => false), (e) => !/SECRETISH/.test(e.message) && /ASC_KEY_PATH/.test(e.message));
});

test('the issuer id is optional: an individual key has none', () => {
  const c = loadConfig({ ASC_KEY_ID: 'K', ASC_KEY_PATH: '/k.p8' }, '/nope', () => '', () => false);
  assert.deepEqual(c, { keyId: 'K', issuerId: '', keyPath: '/k.p8' });
  // a commented-out issuer line in the file is not a setting
  const file = 'ASC_KEY_ID=K\n# ASC_ISSUER_ID=\nASC_KEY_PATH=/k.p8\n';
  assert.equal(loadConfig({}, '/f', () => file, () => true).issuerId, '');
});

test('an individual key signs with `sub: user` and carries no `iss`', () => {
  const jwt = createToken({ keyId: 'ABC123DEFG', issuerId: '', keyPath: '/k.p8' }, privateKey, 1_794_000_000);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(decode(p), { sub: 'user', iat: 1_794_000_000, exp: 1_794_000_900, aud: 'appstoreconnect-v1' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
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

// A fake that also records the method and the body, for the calls that CHANGE App Store Connect.
function fakeRw(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = String(url).replace('https://api.appstoreconnect.apple.com', '');
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : null });
    const hit = routes.find(([method, re]) => method === init.method && re.test(path));
    if (!hit) return { ok: false, status: 404, text: async () => JSON.stringify({ errors: [{ title: 'Not found', detail: `${init.method} ${path}` }] }) };
    return { ok: true, status: hit[3] ?? 200, text: async () => (hit[2] === undefined ? '' : JSON.stringify(hit[2])) };
  };
  return { client: createClient(cfg, { fetchImpl, readKey: () => PEM, now: () => 1_794_000_000 }), calls };
}

test('the external group: an existing external one is reused, nothing is created', async () => {
  const { client, calls } = fakeRw([['GET', /^\/v1\/apps\/A1\/betaGroups/, { data: [{ id: 'G1', attributes: { name: 'Family', isInternalGroup: false } }] }]]);
  assert.deepEqual(await ensureExternalGroup(client, 'A1', 'Family'), { id: 'G1', name: 'Family', created: false });
  assert.deepEqual(calls.map((c) => c.method), ['GET']);
});

test('the external group: an INTERNAL group with the same name is not reused; a new external one is created for the app', async () => {
  const { client, calls } = fakeRw([
    ['GET', /^\/v1\/apps\/A1\/betaGroups/, { data: [{ id: 'GI', attributes: { name: 'Family', isInternalGroup: true } }] }],
    ['POST', /^\/v1\/betaGroups$/, { data: { id: 'GNEW' } }, 201],
  ]);
  assert.deepEqual(await ensureExternalGroup(client, 'A1', 'Family'), { id: 'GNEW', name: 'Family', created: true });
  const post = calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body.data.attributes, { name: 'Family', isInternalGroup: false, publicLinkEnabled: false, feedbackEnabled: true });
  assert.deepEqual(post.body.data.relationships, { app: { data: { type: 'apps', id: 'A1' } } });
});

test('testers: one in the group is left alone, a known one is added, a new one is created in the group', async () => {
  const { client, calls } = fakeRw([
    ['GET', /^\/v1\/betaGroups\/G1\/betaTesters/, { data: [{ id: 'T0', attributes: { email: 'Already@Example.com' } }] }],
    ['GET', /filter\[email\]=known%40example\.com/, { data: [{ id: 'T1', attributes: { email: 'known@example.com' } }] }],
    ['GET', /filter\[email\]=new%40example\.com/, { data: [] }],
    ['POST', /^\/v1\/betaGroups\/G1\/relationships\/betaTesters$/, undefined, 204],
    ['POST', /^\/v1\/betaTesters$/, { data: { id: 'T2' } }, 201],
  ]);
  const out = await addTesters(client, 'G1', ['already@example.com', ' Known@example.com ', 'new@example.com']);
  assert.deepEqual(out, [
    { email: 'already@example.com', action: 'already-in-group' },
    { email: 'known@example.com', action: 'added-existing-tester' },
    { email: 'new@example.com', action: 'created' },
  ]);
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body, { data: [{ type: 'betaTesters', id: 'T1' }] });
  assert.deepEqual(posts[1].body.data, { type: 'betaTesters', attributes: { email: 'new@example.com' }, relationships: { betaGroups: { data: [{ type: 'betaGroups', id: 'G1' }] } } });
});

test('testers: running it twice changes nothing the second time, and a bad address stops everything before any change', async () => {
  const { client, calls } = fakeRw([['GET', /^\/v1\/betaGroups\/G1\/betaTesters/, { data: [{ id: 'T1', attributes: { email: 'a@example.com' } }, { id: 'T2', attributes: { email: 'b@example.com' } }] }]]);
  assert.deepEqual((await addTesters(client, 'G1', ['a@example.com', 'b@example.com'])).map((r) => r.action), ['already-in-group', 'already-in-group']);
  assert.ok(calls.every((c) => c.method === 'GET'));
  const fresh = fakeRw([]);
  await assert.rejects(addTesters(fresh.client, 'G1', ['ok@example.com', 'not-an-email']), /not an email address: not-an-email/);
  assert.equal(fresh.calls.length, 0);
});

test('invitations: only the testers never invited get one, the others are left alone, and a second run does nothing', async () => {
  const { client, calls } = fakeRw([
    ['GET', /^\/v1\/apps\/A1\/betaGroups/, { data: [{ id: 'G1', attributes: { name: 'Family' } }, { id: 'G2', attributes: { name: 'Other' } }] }],
    ['GET', /^\/v1\/betaGroups\/G1\/betaTesters/, { data: [{ id: 'T1', attributes: { state: 'NOT_INVITED' } }, { id: 'T2', attributes: { state: 'INSTALLED' } }, { id: 'T3', attributes: { state: 'INVITED' } }] }],
    ['POST', /^\/v1\/betaTesterInvitations$/, { data: { id: 'I1' } }, 201],
  ]);
  const out = await inviteGroupTesters(client, 'A1', 'Family');
  assert.deepEqual(out, [
    { testerId: 'T1', state: 'NOT_INVITED', action: 'invited' },
    { testerId: 'T2', state: 'INSTALLED', action: 'left-alone' },
    { testerId: 'T3', state: 'INVITED', action: 'left-alone' },
  ]);
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body.data.relationships, { app: { data: { type: 'apps', id: 'A1' } }, betaTester: { data: { type: 'betaTesters', id: 'T1' } } });
});

test('invitations: an unknown group is an error, and nothing is sent', async () => {
  const { client, calls } = fakeRw([['GET', /^\/v1\/apps\/A1\/betaGroups/, { data: [{ id: 'G1', attributes: { name: 'Family' } }] }]]);
  await assert.rejects(inviteGroupTesters(client, 'A1', 'Nope'), /no group "Nope"/);
  assert.ok(calls.every((c) => c.method === 'GET'));
});

test('invitations --all: an invited tester who never answered gets it again; an installed one never does', async () => {
  const { client, calls } = fakeRw([
    ['GET', /^\/v1\/apps\/A1\/betaGroups/, { data: [{ id: 'G1', attributes: { name: 'Family' } }] }],
    ['GET', /^\/v1\/betaGroups\/G1\/betaTesters/, { data: [{ id: 'T1', attributes: { state: 'INVITED' } }, { id: 'T2', attributes: { state: 'INSTALLED' } }, { id: 'T3', attributes: { state: 'NOT_INVITED' } }] }],
    ['POST', /^\/v1\/betaTesterInvitations$/, { data: { id: 'I1' } }, 201],
  ]);
  const out = await inviteGroupTesters(client, 'A1', 'Family', { all: true });
  assert.deepEqual(out.map((o) => o.action), ['re-invited', 'left-alone', 'invited']);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 2);
});

// ---- builds: assigning one to an external group, and Beta App Review

const BUILDS = { data: [
  { id: 'B10', attributes: { version: '10', processingState: 'PROCESSING', expired: false } },
  { id: 'B9', attributes: { version: '9', processingState: 'VALID', expired: false } },
  { id: 'B8', attributes: { version: '8', processingState: 'VALID', expired: false } },
  { id: 'B2', attributes: { version: '2', processingState: 'VALID', expired: true } },
] };

test('findBuild: without a number it is the newest build Apple has processed; with one, that build; a build still processing is named', async () => {
  const { client } = fakeRw([['GET', /^\/v1\/builds\?filter\[app\]=A1/, BUILDS]]);
  assert.equal((await findBuild(client, 'A1')).number, '9');                 // 10 is still PROCESSING: not offered
  assert.equal((await findBuild(client, 'A1', 8)).id, 'B8');
  await assert.rejects(findBuild(client, 'A1', 10), /build 10 is PROCESSING: wait until Apple has processed it/);
  await assert.rejects(findBuild(client, 'A1', 2), /build 2 has expired/);
  await assert.rejects(findBuild(client, 'A1', 77), /no build 77 on the app/);
});

test('findBuild: an app with nothing processed yet says so', async () => {
  const { client } = fakeRw([['GET', /^\/v1\/builds/, { data: [{ id: 'B1', attributes: { version: '1', processingState: 'PROCESSING', expired: false } }] }]]);
  await assert.rejects(findBuild(client, 'A1'), /no processed build on the app yet/);
});

test('assign-build: the newest processed build goes into the EXTERNAL group; a second run changes nothing', async () => {
  const routes = [
    ['GET', /^\/v1\/apps\/A1\/betaGroups/, { data: [{ id: 'GI', attributes: { name: 'Family', isInternalGroup: true } }, { id: 'GX', attributes: { name: 'FamilyPlus', isInternalGroup: false } }] }],
    ['GET', /^\/v1\/builds\?filter/, BUILDS],
    ['GET', /^\/v1\/betaGroups\/GX\/builds/, { data: [] }],
    ['POST', /^\/v1\/betaGroups\/GX\/relationships\/builds$/, undefined, 204],
  ];
  const first = fakeRw(routes);
  assert.deepEqual(await assignBuild(first.client, 'A1', 'FamilyPlus'), { group: 'FamilyPlus', build: '9', action: 'added' });
  assert.deepEqual(first.calls.find((c) => c.method === 'POST').body, { data: [{ type: 'builds', id: 'B9' }] });

  const again = fakeRw(routes.map((r) => (r[1].source.includes('GX\\/builds') && r[0] === 'GET' ? ['GET', r[1], { data: [{ id: 'B9' }] }] : r)));
  assert.deepEqual(await assignBuild(again.client, 'A1', 'FamilyPlus'), { group: 'FamilyPlus', build: '9', action: 'already-in-group' });
  assert.ok(again.calls.every((c) => c.method === 'GET'));
});

test('assign-build: an INTERNAL group, or one that does not exist, is an error and nothing is changed', async () => {
  const { client, calls } = fakeRw([['GET', /^\/v1\/apps\/A1\/betaGroups/, { data: [{ id: 'GI', attributes: { name: 'Family', isInternalGroup: true } }] }]]);
  await assert.rejects(assignBuild(client, 'A1', 'Family'), /no external group "Family" on the app/);
  await assert.rejects(assignBuild(client, 'A1', 'Nope'), /no external group "Nope"/);
  assert.ok(calls.every((c) => c.method === 'GET'));
});

test('submit-review: «what to test» is written, then the build is submitted once', async () => {
  const { client, calls } = fakeRw([
    ['GET', /^\/v1\/builds\?filter/, BUILDS],
    ['GET', /^\/v1\/builds\/B9\/betaBuildLocalizations/, { data: [] }],
    ['POST', /^\/v1\/betaBuildLocalizations$/, { data: { id: 'L1' } }, 201],
    ['GET', /^\/v1\/builds\/B9\/betaAppReviewSubmission$/, { data: null }],
    ['POST', /^\/v1\/betaAppReviewSubmissions$/, { data: { id: 'S1', attributes: { betaReviewState: 'WAITING_FOR_REVIEW' } } }, 201],
  ]);
  assert.deepEqual(await submitForReview(client, 'A1', undefined, 'La Home'), { build: '9', action: 'submitted', state: 'WAITING_FOR_REVIEW' });
  const posts = calls.filter((c) => c.method === 'POST');
  assert.deepEqual(posts[0].body.data, { type: 'betaBuildLocalizations', attributes: { locale: 'it', whatsNew: 'La Home' }, relationships: { build: { data: { type: 'builds', id: 'B9' } } } });
  assert.deepEqual(posts[1].body.data, { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: 'B9' } } } });
});

test('submit-review: a build already submitted is left alone and its state is reported (a 404 for «none» counts as none)', async () => {
  const done = fakeRw([
    ['GET', /^\/v1\/builds\?filter/, BUILDS],
    ['GET', /^\/v1\/builds\/B9\/betaAppReviewSubmission$/, { data: { id: 'S1', attributes: { betaReviewState: 'IN_REVIEW' } } }],
  ]);
  assert.deepEqual(await submitForReview(done.client, 'A1', 9), { build: '9', action: 'already-submitted', state: 'IN_REVIEW' });
  assert.ok(done.calls.every((c) => c.method === 'GET'));

  const none = fakeRw([
    ['GET', /^\/v1\/builds\?filter/, BUILDS],
    ['POST', /^\/v1\/betaAppReviewSubmissions$/, { data: { id: 'S2', attributes: { betaReviewState: 'WAITING_FOR_REVIEW' } } }, 201],
  ]);                                                                          // the lookup answers 404 (no route): none yet
  assert.equal((await submitForReview(none.client, 'A1', 9)).action, 'submitted');
});

test('submit-review: «what to test» already there is updated only when it differs; without text no localization is touched', async () => {
  const same = fakeRw([
    ['GET', /^\/v1\/builds\?filter/, BUILDS],
    ['GET', /^\/v1\/builds\/B9\/betaBuildLocalizations/, { data: [{ id: 'L1', attributes: { locale: 'it', whatsNew: 'La Home' } }] }],
    ['GET', /^\/v1\/builds\/B9\/betaAppReviewSubmission$/, { data: { id: 'S1', attributes: { betaReviewState: 'APPROVED' } } }],
  ]);
  await submitForReview(same.client, 'A1', 9, 'La Home');
  assert.ok(same.calls.every((c) => c.method === 'GET'));

  const changed = fakeRw([
    ['GET', /^\/v1\/builds\?filter/, BUILDS],
    ['GET', /^\/v1\/builds\/B9\/betaBuildLocalizations/, { data: [{ id: 'L1', attributes: { locale: 'it', whatsNew: 'vecchio' } }] }],
    ['PATCH', /^\/v1\/betaBuildLocalizations\/L1$/, { data: { id: 'L1' } }],
    ['GET', /^\/v1\/builds\/B9\/betaAppReviewSubmission$/, { data: { id: 'S1', attributes: { betaReviewState: 'APPROVED' } } }],
  ]);
  await submitForReview(changed.client, 'A1', 9, 'La Home');
  assert.deepEqual(changed.calls.find((c) => c.method === 'PATCH').body.data.attributes, { whatsNew: 'La Home' });

  const bare = fakeRw([
    ['GET', /^\/v1\/builds\?filter/, BUILDS],
    ['GET', /^\/v1\/builds\/B9\/betaAppReviewSubmission$/, { data: { id: 'S1', attributes: { betaReviewState: 'APPROVED' } } }],
  ]);
  await submitForReview(bare.client, 'A1', 9);
  assert.ok(bare.calls.every((c) => !/betaBuildLocalizations/.test(c.path)));
});

test('submit-review: a build still processing is not submitted', async () => {
  const { client, calls } = fakeRw([['GET', /^\/v1\/builds\?filter/, BUILDS]]);
  await assert.rejects(submitForReview(client, 'A1', 10, 'x'), /build 10 is PROCESSING/);
  assert.ok(calls.every((c) => c.method === 'GET'));
});

test('submit-review: a failure other than «not found» on the lookup stops everything (it would otherwise submit twice)', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = String(url).replace('https://api.appstoreconnect.apple.com', '');
    calls.push({ method: init.method, path });
    if (/^\/v1\/builds\?filter/.test(path)) return { ok: true, status: 200, text: async () => JSON.stringify(BUILDS) };
    return { ok: false, status: 500, text: async () => JSON.stringify({ errors: [{ title: 'Server error', detail: 'try later' }] }) };
  };
  const client = createClient(cfg, { fetchImpl, readKey: () => PEM, now: () => 1_794_000_000 });
  await assert.rejects(submitForReview(client, 'A1', 9), /HTTP 500/);
  assert.ok(calls.every((c) => c.method === 'GET'), 'nothing was changed');
});
