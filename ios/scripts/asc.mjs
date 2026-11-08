#!/usr/bin/env node
// App Store Connect API helper for the TestFlight steps (ADR-0016, spec 2026-11-08-mondrop-testflight-design.md).
// Zero dependencies (Node 20+: global fetch and node:crypto).
//
// Credentials live OUTSIDE the repository: ~/.config/soundreel/appstoreconnect/config.env (ASC_KEY_ID, ASC_ISSUER_ID,
// ASC_KEY_PATH) and the AuthKey_<KeyID>.p8 it points to (0600). Environment variables override the file. The key is read
// only to sign a short-lived token and is never printed; neither is the token.
//
// Usage:
//   node ios/scripts/asc.mjs status                       read-only: the app, its builds, its TestFlight groups and testers
//   node ios/scripts/asc.mjs groups [name]                read-only: TestFlight groups of the whole team with that name (default Family)
//   node ios/scripts/asc.mjs get /v1/apps?limit=5         read-only: any GET, the answer trimmed (to look at what the API says)
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

/** The three settings, from the file then the environment. Throws a message that names what is missing, never a value. */
export function loadConfig(env = process.env, file = DEFAULT_CONFIG, read = (p) => readFileSync(p, 'utf8'), exists = existsSync) {
  const fromFile = exists(file) ? parseEnvFile(read(file)) : {};
  const get = (k) => (env[k] ?? fromFile[k] ?? '').trim();
  const cfg = { keyId: get('ASC_KEY_ID'), issuerId: get('ASC_ISSUER_ID'), keyPath: get('ASC_KEY_PATH') };
  const missing = [['ASC_KEY_ID', cfg.keyId], ['ASC_ISSUER_ID', cfg.issuerId], ['ASC_KEY_PATH', cfg.keyPath]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`missing ${missing.join(', ')} (set them in ${file} or the environment)`);
  return cfg;
}

const b64url = (input) => Buffer.from(input).toString('base64url');

/** The ES256 token the API wants: `iss` = issuer id, `aud` = appstoreconnect-v1, valid at most 20 minutes. */
export function createToken(cfg, privateKey, nowSec = Math.floor(Date.now() / 1000)) {
  const signingInput = `${b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' }))}.${b64url(
    JSON.stringify({ iss: cfg.issuerId, iat: nowSec, exp: nowSec + 15 * 60, aud: 'appstoreconnect-v1' }),
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
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  const [command = 'status', ...rest] = argv;
  const client = createClient(loadConfig());
  if (command === 'status') {
    console.log(JSON.stringify(await statusReport(client), null, 2));
  } else if (command === 'groups') {
    console.log(JSON.stringify(await groupsNamed(client, rest[0] ?? 'Family'), null, 2));
  } else if (command === 'get') {
    if (!rest[0]?.startsWith('/v1/')) throw new Error('usage: asc.mjs get /v1/...');
    console.log(JSON.stringify(await client.get(rest[0]), null, 2).slice(0, 6000));
  } else {
    throw new Error(`unknown command "${command}" (status | groups | get)`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`asc: ${err.message}`);
    process.exit(1);
  });
}
