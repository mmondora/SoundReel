#!/usr/bin/env node
// App Store Connect API helper for the TestFlight steps (ADR-0016, spec 2026-11-08-mondrop-testflight-design.md).
// Zero dependencies (Node 20+: global fetch and node:crypto).
//
// Credentials live OUTSIDE the repository: ~/.config/soundreel/appstoreconnect/config.env (ASC_KEY_ID, ASC_KEY_PATH and,
// for a team key, ASC_ISSUER_ID: an individual key has none) and the AuthKey_<KeyID>.p8 it points to (0600). Environment
// variables override the file. The key is read only to sign a short-lived token and is never printed; neither is the token.
//
// Usage:
//   node ios/scripts/asc.mjs status                       read-only: the app, its builds, its TestFlight groups and testers
//   node ios/scripts/asc.mjs groups [name]                read-only: TestFlight groups of the whole team with that name (default Family)
//   node ios/scripts/asc.mjs get /v1/apps?limit=5         read-only: any GET, the answer trimmed (to look at what the API says)
//   node ios/scripts/asc.mjs setup-group Family a@x b@y   CHANGES App Store Connect: the external group and its testers (idempotent; give the group a build first: assign-build)
//   node ios/scripts/asc.mjs invite-group Family [--all]  CHANGES App Store Connect: invites the testers never invited (--all: sends it again to those who never answered)
//   node ios/scripts/asc.mjs assign-build Family [9]      CHANGES App Store Connect: puts the build (default: the newest processed one) in the EXTERNAL group (an internal group holds every build by itself)
//   node ios/scripts/asc.mjs set-test-info [--description "text|@file"] [--notes "text|@file"]   CHANGES App Store Connect: the Italian beta description and the notes for the Beta App Review team
//   node ios/scripts/asc.mjs submit-review [9] [--whats-new "text|@file"]   CHANGES App Store Connect: sends the build to Beta App Review (needed once per version for external testers; Apple then invites them)
//   (a text given as `@path` is read from that file; Apple takes 4000 characters at most in each text)
import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const API = 'https://api.appstoreconnect.apple.com';
export const BUNDLE_ID = 'it.mikesoft.mondrop';
export const DEFAULT_CONFIG = join(homedir(), '.config', 'soundreel', 'appstoreconnect', 'config.env');

/** KEY=VALUE lines, `#` comments, optional quotes; nothing is evaluated. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * The settings, from the file then the environment. Throws a message that names what is missing, never a value.
 * `ASC_ISSUER_ID` is optional: a TEAM key has one (shown above the keys table), an INDIVIDUAL key has none and signs its
 * token with `sub: "user"` instead (see createToken).
 */
export function loadConfig(env = process.env, file = DEFAULT_CONFIG, read = (p) => readFileSync(p, 'utf8'), exists = existsSync) {
  const fromFile = exists(file) ? parseEnvFile(read(file)) : {};
  const get = (k) => (env[k] ?? fromFile[k] ?? '').trim();
  const cfg = { keyId: get('ASC_KEY_ID'), issuerId: get('ASC_ISSUER_ID'), keyPath: get('ASC_KEY_PATH') };
  const missing = [['ASC_KEY_ID', cfg.keyId], ['ASC_KEY_PATH', cfg.keyPath]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`missing ${missing.join(', ')} (set them in ${file} or the environment)`);
  return cfg;
}

const b64url = (input) => Buffer.from(input).toString('base64url');

/**
 * The ES256 token the API wants: `iss` = issuer id for a team key, or `sub: "user"` for an individual key (no issuer);
 * `aud` = appstoreconnect-v1; valid at most 20 minutes.
 */
export function createToken(cfg, privateKey, nowSec = Math.floor(Date.now() / 1000)) {
  const who = cfg.issuerId ? { iss: cfg.issuerId } : { sub: 'user' };
  const signingInput = `${b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' }))}.${b64url(
    JSON.stringify({ ...who, iat: nowSec, exp: nowSec + 15 * 60, aud: 'appstoreconnect-v1' }),
  )}`;
  const signature = sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}

/** What the API's `errors` say, in one line each, without the request or any header. */
export function describeErrors(status, body) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  if (errors.length === 0) return `HTTP ${status}`;
  return errors.map((e) => `HTTP ${status} ${e.code ?? ''} ${e.title ?? ''}: ${e.detail ?? ''}`.replace(/\s+/g, ' ').trim()).join(' | ');
}

export function createClient(cfg, { fetchImpl = fetch, readKey = (p) => readFileSync(p, 'utf8'), now = () => Math.floor(Date.now() / 1000) } = {}) {
  const privateKey = createPrivateKey(readKey(cfg.keyPath));
  let cached = null;
  const token = () => {
    const t = now();
    if (!cached || t - cached.at > 600) cached = { at: t, value: createToken(cfg, privateKey, t) };
    return cached.value;
  };

  async function request(method, path, body) {
    const res = await fetchImpl(path.startsWith('http') ? path : `${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* a non-JSON body is reported as the status */ }
    if (!res.ok) throw new Error(describeErrors(res.status, json));
    return json;
  }

  /** GET that follows `links.next` and returns every `data` item (and the merged `included`). */
  async function list(path, maxPages = 10) {
    const data = [];
    const included = [];
    let next = path;
    for (let page = 0; next && page < maxPages; page += 1) {
      const json = await request('GET', next);
      data.push(...(json?.data ?? []));
      included.push(...(json?.included ?? []));
      next = json?.links?.next ?? null;
    }
    return { data, included };
  }

  return { get: (path) => request('GET', path), post: (path, body) => request('POST', path, body), patch: (path, body) => request('PATCH', path, body), list };
}

// ---------------------------------------------------------------------------
// Read-only views
// ---------------------------------------------------------------------------

export async function findApp(client, bundleId = BUNDLE_ID) {
  const { data } = await client.list(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=5`);
  return data[0] ?? null;
}

export async function statusReport(client) {
  const app = await findApp(client);
  if (!app) return { app: null };
  const id = app.id;
  const builds = await client.list(`/v1/builds?filter[app]=${id}&sort=-uploadedDate&limit=10&include=preReleaseVersion&fields[builds]=version,uploadedDate,processingState,expired&fields[preReleaseVersions]=version`);
  const versions = new Map(builds.included.filter((i) => i.type === 'preReleaseVersions').map((i) => [i.id, i.attributes?.version]));
  const groups = await client.list(`/v1/apps/${id}/betaGroups?limit=50&fields[betaGroups]=name,isInternalGroup,publicLinkEnabled`);
  const groupViews = [];
  for (const g of groups.data) {
    const testers = await client.list(`/v1/betaGroups/${g.id}/betaTesters?limit=200&fields[betaTesters]=email,firstName,lastName,state`);
    groupViews.push({
      name: g.attributes?.name,
      internal: Boolean(g.attributes?.isInternalGroup),
      testers: testers.data.map((t) => ({ email: t.attributes?.email, name: [t.attributes?.firstName, t.attributes?.lastName].filter(Boolean).join(' '), state: t.attributes?.state })),
    });
  }
  return {
    app: { id, name: app.attributes?.name, bundleId: app.attributes?.bundleId },
    builds: builds.data.map((b) => ({
      id: b.id,
      version: `${versions.get(b.relationships?.preReleaseVersion?.data?.id) ?? '?'} (${b.attributes?.version})`,
      state: b.attributes?.processingState,
      expired: Boolean(b.attributes?.expired),
      uploaded: b.attributes?.uploadedDate,
    })),
    groups: groupViews,
  };
}

/** The TestFlight groups of the whole team with this name: which app they belong to and who is in them. */
export async function groupsNamed(client, name = 'Family') {
  const found = await client.list(`/v1/betaGroups?filter[name]=${encodeURIComponent(name)}&include=app&limit=50&fields[betaGroups]=name,isInternalGroup&fields[apps]=name,bundleId`);
  const apps = new Map(found.included.filter((i) => i.type === 'apps').map((a) => [a.id, a.attributes]));
  const out = [];
  for (const g of found.data) {
    const testers = await client.list(`/v1/betaGroups/${g.id}/betaTesters?limit=200&fields[betaTesters]=email,firstName,lastName,state`);
    const appId = g.relationships?.app?.data?.id;
    out.push({
      id: g.id,
      name: g.attributes?.name,
      internal: Boolean(g.attributes?.isInternalGroup),
      app: apps.get(appId)?.name ?? appId ?? null,
      testers: testers.data.map((t) => ({ id: t.id, email: t.attributes?.email, name: [t.attributes?.firstName, t.attributes?.lastName].filter(Boolean).join(' '), state: t.attributes?.state })),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Changes (each one is explicit, idempotent, and run only on Michele's request: spec 2026-11-08-mondrop-testflight-design)
// ---------------------------------------------------------------------------

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * The EXTERNAL group with this name on the app, or a new one (no public link, feedback on). An internal group with the
 * same name is not reused: internal testers must be App Store Connect users, family members are not.
 */
export async function ensureExternalGroup(client, appId, name) {
  const groups = await client.list(`/v1/apps/${appId}/betaGroups?limit=50&fields[betaGroups]=name,isInternalGroup`);
  const existing = groups.data.find((g) => g.attributes?.name === name && !g.attributes?.isInternalGroup);
  if (existing) return { id: existing.id, name, created: false };
  const json = await client.post('/v1/betaGroups', {
    data: {
      type: 'betaGroups',
      attributes: { name, isInternalGroup: false, publicLinkEnabled: false, feedbackEnabled: true },
      relationships: { app: { data: { type: 'apps', id: appId } } },
    },
  });
  return { id: json.data.id, name, created: true };
}

/**
 * Puts these emails in the group. One already in the group is left alone; one the team already knows (a tester of another
 * app) is added to the group; a new one is created in it. An EXTERNAL group with no build refuses new testers (409 STATE_ERROR
 * «Tester(s) cannot be assigned», seen on 8 November): run `assign-build` first. No invitation goes out until a build of the
 * group passes beta review (or `invite-group` sends it).
 */
export async function addTesters(client, groupId, emails) {
  const bad = emails.filter((e) => !EMAIL.test(e.trim()));
  if (bad.length) throw new Error(`not an email address: ${bad.join(', ')}`);
  const current = await client.list(`/v1/betaGroups/${groupId}/betaTesters?limit=200&fields[betaTesters]=email`);
  const inGroup = new Set(current.data.map((t) => (t.attributes?.email ?? '').toLowerCase()));
  const out = [];
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (inGroup.has(email)) {
      out.push({ email, action: 'already-in-group' });
      continue;
    }
    const found = await client.list(`/v1/betaTesters?filter[email]=${encodeURIComponent(email)}&limit=5&fields[betaTesters]=email`);
    const known = found.data.find((t) => (t.attributes?.email ?? '').toLowerCase() === email);
    if (known) {
      await client.post(`/v1/betaGroups/${groupId}/relationships/betaTesters`, { data: [{ type: 'betaTesters', id: known.id }] });
      out.push({ email, action: 'added-existing-tester' });
    } else {
      await client.post('/v1/betaTesters', {
        data: { type: 'betaTesters', attributes: { email }, relationships: { betaGroups: { data: [{ type: 'betaGroups', id: groupId }] } } },
      });
      out.push({ email, action: 'created' });
    }
    inGroup.add(email);
  }
  return out;
}

/**
 * Sends the TestFlight invitation to the testers of a group that were never invited (`NOT_INVITED`): an internal group
 * with automatic distribution already holds every build, and an invitation is what makes the app show up in the
 * TestFlight app of the tester. Testers in any other state are left alone, so it can be run twice; with `all` a tester who
 * was invited and never answered gets the invitation again.
 */
export async function inviteGroupTesters(client, appId, groupName, { all = false } = {}) {
  const groups = await client.list(`/v1/apps/${appId}/betaGroups?limit=50&fields[betaGroups]=name`);
  const group = groups.data.find((g) => g.attributes?.name === groupName);
  if (!group) throw new Error(`no group "${groupName}" on the app`);
  const testers = await client.list(`/v1/betaGroups/${group.id}/betaTesters?limit=200&fields[betaTesters]=email,state`);
  const out = [];
  for (const tester of testers.data) {
    const state = tester.attributes?.state;
    // `all` sends the invitation again to a tester who was invited but never answered (the email got lost); an
    // INSTALLED tester has nothing to accept and is always left alone
    if (state === 'INSTALLED' || (!all && state !== 'NOT_INVITED')) {
      out.push({ testerId: tester.id, state, action: 'left-alone' });
      continue;
    }
    await client.post('/v1/betaTesterInvitations', {
      data: {
        type: 'betaTesterInvitations',
        relationships: { app: { data: { type: 'apps', id: appId } }, betaTester: { data: { type: 'betaTesters', id: tester.id } } },
      },
    });
    out.push({ testerId: tester.id, state, action: state === 'NOT_INVITED' ? 'invited' : 're-invited' });
  }
  return out;
}

/**
 * The build with this number, or — without a number — the newest one Apple has finished processing. A build that is still
 * processing (or expired) is an error that says so: nothing can be assigned or submitted before it is `VALID`.
 */
export async function findBuild(client, appId, number) {
  const builds = await client.list(`/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=30&fields[builds]=version,uploadedDate,processingState,expired`);
  const rows = builds.data.map((b) => ({ id: b.id, number: b.attributes?.version, state: b.attributes?.processingState, expired: Boolean(b.attributes?.expired) }));
  const pick = number === undefined ? rows.find((b) => b.state === 'VALID' && !b.expired) : rows.find((b) => b.number === String(number));
  if (!pick) throw new Error(number === undefined ? 'no processed build on the app yet' : `no build ${number} on the app`);
  if (pick.expired) throw new Error(`build ${pick.number} has expired`);
  if (pick.state !== 'VALID') throw new Error(`build ${pick.number} is ${pick.state}: wait until Apple has processed it`);
  return pick;
}

/**
 * Puts a build in an EXTERNAL group (an internal group with automatic distribution already holds every build). One already in the
 * group is left alone, so it can be run twice. It does not submit the build for review: that is `submitForReview`.
 */
export async function assignBuild(client, appId, groupName, number) {
  const groups = await client.list(`/v1/apps/${appId}/betaGroups?limit=50&fields[betaGroups]=name,isInternalGroup`);
  const group = groups.data.find((g) => g.attributes?.name === groupName && !g.attributes?.isInternalGroup);
  if (!group) throw new Error(`no external group "${groupName}" on the app (an internal group holds every build by itself)`);
  const build = await findBuild(client, appId, number);
  const inGroup = await client.list(`/v1/betaGroups/${group.id}/builds?limit=200&fields[builds]=version`);
  if (inGroup.data.some((b) => b.id === build.id)) return { group: groupName, build: build.number, action: 'already-in-group' };
  await client.post(`/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: 'builds', id: build.id }] });
  return { group: groupName, build: build.number, action: 'added' };
}

/**
 * Sends a build to Beta App Review, the step external testers wait for (once per version; Apple invites the testers of the group by
 * itself when it is approved). «What to test» (Italian) is written first when given. A build already submitted is left alone and
 * its state is reported: running it twice never submits twice.
 */
export async function submitForReview(client, appId, number, whatsNew) {
  if (whatsNew && whatsNew.length > MAX_TEST_TEXT) throw new Error(`what to test is ${whatsNew.length} characters: Apple takes ${MAX_TEST_TEXT} at most`);
  const build = await findBuild(client, appId, number);
  if (whatsNew) {
    const found = await client.list(`/v1/builds/${build.id}/betaBuildLocalizations?limit=20&fields[betaBuildLocalizations]=locale,whatsNew`);
    const italian = found.data.find((l) => l.attributes?.locale === 'it');
    if (!italian) {
      await client.post('/v1/betaBuildLocalizations', {
        data: { type: 'betaBuildLocalizations', attributes: { locale: 'it', whatsNew }, relationships: { build: { data: { type: 'builds', id: build.id } } } },
      });
    } else if (italian.attributes?.whatsNew !== whatsNew) {
      await client.patch(`/v1/betaBuildLocalizations/${italian.id}`, { data: { type: 'betaBuildLocalizations', id: italian.id, attributes: { whatsNew } } });
    }
  }
  let existing = null;
  try {
    existing = (await client.get(`/v1/builds/${build.id}/betaAppReviewSubmission`))?.data ?? null;
  } catch (err) {
    if (!/HTTP 404/.test(err.message)) throw err;      // «no submission» may come as an empty answer or as a 404: both mean none
  }
  if (existing) return { build: build.number, action: 'already-submitted', state: existing.attributes?.betaReviewState ?? null };
  const json = await client.post('/v1/betaAppReviewSubmissions', {
    data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: build.id } } } },
  });
  return { build: build.number, action: 'submitted', state: json?.data?.attributes?.betaReviewState ?? null };
}

/** Apple takes at most this many characters in a beta description, in «what to test» and in the review notes. */
export const MAX_TEST_TEXT = 4000;

/**
 * A text given on the command line: `@path` reads that file (a long text with line breaks: the macro features and the points to
 * look at), anything else is the text itself. Surrounding blank lines are trimmed. The reader is injectable for the tests.
 */
export function textArg(value, read = (p) => readFileSync(p, 'utf8')) {
  if (!value.startsWith('@')) return value;
  const path = value.slice(1);
  let text;
  try {
    text = read(path);
  } catch {
    throw new Error(`cannot read ${path}`);
  }
  text = text.trim();
  if (!text) throw new Error(`${path} is empty`);
  return text;
}

/**
 * The test information Beta App Review reads. Apple turned build 8 down on 8 November with «il motivo lo devi aggiungere tu,
 * mettendo l'elenco delle macro funzionalità, i due o tre macro punti da attenzionare», and the app had «Gestione delle playlist sul
 * telefono» as its whole description and no notes at all (a private app that does nothing without its server). Two texts:
 * `description`, the Italian beta description testers read in TestFlight, and `notes`, the notes for the review team (they never
 * reach the testers). A field already equal is left alone, a missing text is not touched, and a text over Apple's limit is refused
 * before anything is sent. «What to test» is per build: `submitForReview` writes it.
 */
export async function setTestInfo(client, appId, { description, notes } = {}) {
  for (const [name, text] of [['description', description], ['notes', notes]]) {
    if (text && text.length > MAX_TEST_TEXT) throw new Error(`${name} is ${text.length} characters: Apple takes ${MAX_TEST_TEXT} at most`);
  }
  const out = { description: 'unchanged', notes: 'unchanged' };
  if (description) {
    const found = await client.list(`/v1/apps/${appId}/betaAppLocalizations?limit=20&fields[betaAppLocalizations]=locale,description`);
    const italian = found.data.find((l) => l.attributes?.locale === 'it');
    if (!italian) {
      await client.post('/v1/betaAppLocalizations', {
        data: { type: 'betaAppLocalizations', attributes: { locale: 'it', description }, relationships: { app: { data: { type: 'apps', id: appId } } } },
      });
      out.description = 'created';
    } else if (italian.attributes?.description !== description) {
      await client.patch(`/v1/betaAppLocalizations/${italian.id}`, { data: { type: 'betaAppLocalizations', id: italian.id, attributes: { description } } });
      out.description = 'updated';
    }
  }
  if (notes) {
    const detail = (await client.get(`/v1/apps/${appId}/betaAppReviewDetail`)).data;
    if (detail.attributes?.notes !== notes) {
      await client.patch(`/v1/betaAppReviewDetails/${detail.id}`, { data: { type: 'betaAppReviewDetails', id: detail.id, attributes: { notes } } });
      out.notes = 'updated';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** The value after `--flag` in the arguments, or undefined; a flag with no value is a usage error. */
function flagValue(args, flag, usage, read) {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  if (!args[at + 1]) throw new Error(usage);
  return textArg(args[at + 1], read);
}

/**
 * `submit-review [build number] [--whats-new "text|@file"]` → `{ number, whatsNew }`. The number is the first word that is not the
 * flag or its value: without the flag it is the first word (it used to be skipped, so `submit-review 9` sent the newest build).
 */
export function submitArgs(rest, read) {
  const at = rest.indexOf('--whats-new');
  const whatsNew = flagValue(rest, '--whats-new', 'usage: asc.mjs submit-review [build number] [--whats-new "text|@file"]', read);
  const valueAt = at >= 0 ? at + 1 : -1;
  const number = rest.find((a, i) => !a.startsWith('--') && i !== valueAt);
  return { number, whatsNew };
}

async function main(argv) {
  const [command = 'status', ...rest] = argv;
  const client = createClient(loadConfig());
  if (command === 'invite-group') {
    if (!rest[0]) throw new Error('usage: asc.mjs invite-group <group name> [--all]');
    const app = await findApp(client);
    if (!app) throw new Error(`no app record for ${BUNDLE_ID}`);
    const testers = await inviteGroupTesters(client, app.id, rest[0], { all: rest.includes('--all') });
    console.log(JSON.stringify({ app: app.attributes?.name, group: rest[0], testers }, null, 2));
  } else if (command === 'setup-group') {
    const [name, ...emails] = rest;
    if (!name || emails.length === 0) throw new Error('usage: asc.mjs setup-group <group name> <email> [email ...]');
    const app = await findApp(client);
    if (!app) throw new Error(`no app record for ${BUNDLE_ID}`);
    const group = await ensureExternalGroup(client, app.id, name);
    const testers = await addTesters(client, group.id, emails);
    console.log(JSON.stringify({ app: app.attributes?.name, group, testers }, null, 2));
  } else if (command === 'assign-build') {
    const [name, number] = rest.filter((a) => !a.startsWith('--'));
    if (!name) throw new Error('usage: asc.mjs assign-build <external group name> [build number]');
    const app = await findApp(client);
    if (!app) throw new Error(`no app record for ${BUNDLE_ID}`);
    console.log(JSON.stringify(await assignBuild(client, app.id, name, number), null, 2));
  } else if (command === 'set-test-info') {
    const usage = 'usage: asc.mjs set-test-info [--description "text|@file"] [--notes "text|@file"]';
    const description = flagValue(rest, '--description', usage);
    const notes = flagValue(rest, '--notes', usage);
    if (description === undefined && notes === undefined) throw new Error(usage);
    const app = await findApp(client);
    if (!app) throw new Error(`no app record for ${BUNDLE_ID}`);
    console.log(JSON.stringify(await setTestInfo(client, app.id, { description, notes }), null, 2));
  } else if (command === 'submit-review') {
    const { number, whatsNew } = submitArgs(rest);
    const app = await findApp(client);
    if (!app) throw new Error(`no app record for ${BUNDLE_ID}`);
    console.log(JSON.stringify(await submitForReview(client, app.id, number, whatsNew), null, 2));
  } else if (command === 'status') {
    console.log(JSON.stringify(await statusReport(client), null, 2));
  } else if (command === 'groups') {
    console.log(JSON.stringify(await groupsNamed(client, rest[0] ?? 'Family'), null, 2));
  } else if (command === 'get') {
    if (!rest[0]?.startsWith('/v1/')) throw new Error('usage: asc.mjs get /v1/...');
    console.log(JSON.stringify(await client.get(rest[0]), null, 2).slice(0, 6000));
  } else {
    throw new Error(`unknown command "${command}" (status | groups | get | setup-group | invite-group | assign-build | set-test-info | submit-review)`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`asc: ${err.message}`);
    process.exit(1);
  });
}
