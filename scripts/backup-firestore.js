#!/usr/bin/env node
/* eslint-disable */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Resolve firebase-admin from functions/node_modules
const adminPath = path.resolve(__dirname, '../functions/node_modules/firebase-admin');
const admin = require(adminPath);

const OUT_DIR = path.resolve(__dirname, '../migration');
const SA_PATH = process.env.FIREBASE_SERVICE_ACCOUNT || path.resolve(OUT_DIR, 'service-account.json');

if (!fs.existsSync(SA_PATH)) {
  console.error(`Service account key not found at ${SA_PATH}`);
  console.error('Set FIREBASE_SERVICE_ACCOUNT env var or place key at migration/service-account.json');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(SA_PATH),
});

const db = admin.firestore();

function toJson(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof admin.firestore.Timestamp) {
    return {
      __type: 'timestamp',
      iso: value.toDate().toISOString(),
      seconds: value.seconds,
      nanoseconds: value.nanoseconds,
    };
  }
  if (value instanceof admin.firestore.GeoPoint) {
    return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  }
  if (value instanceof admin.firestore.DocumentReference) {
    return { __type: 'docref', path: value.path };
  }
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toJson(v);
    }
    return out;
  }
  return value;
}

async function dumpCollection(name) {
  console.log(`[${name}] fetching...`);
  const snapshot = await db.collection(name).get();
  const docs = snapshot.docs.map((d) => ({ id: d.id, data: toJson(d.data()) }));
  const file = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(docs, null, 2));
  console.log(`[${name}] ${docs.length} docs → ${file}`);
  return docs.length;
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const collections = ['entries', 'config', 'logs'];
  const counts = {};
  for (const c of collections) {
    counts[c] = await dumpCollection(c);
  }

  const summary = {
    exportedAt: new Date().toISOString(),
    projectId: admin.app().options.credential?.projectId || process.env.FIREBASE_PROJECT_ID || 'unknown',
    collections,
    counts,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('done. Summary:', summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
