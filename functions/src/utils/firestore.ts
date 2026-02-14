import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import type { Entry, ActionLogItem } from '../types';

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

export async function findEntryByUrl(sourceUrl: string): Promise<Entry | null> {
  const snapshot = await db
    .collection('entries')
    .where('sourceUrl', '==', sourceUrl)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() } as Entry;
}

export async function createEntry(entry: Omit<Entry, 'id'>): Promise<string> {
  const docRef = await db.collection('entries').add({
    ...entry,
    createdAt: FieldValue.serverTimestamp()
  });
  return docRef.id;
}

export async function updateEntry(
  entryId: string,
  updates: Partial<Entry>
): Promise<void> {
  await db.collection('entries').doc(entryId).update(updates);
}

export async function appendActionLog(
  entryId: string,
  logItem: ActionLogItem
): Promise<void> {
  await db.collection('entries').doc(entryId).update({
    actionLog: FieldValue.arrayUnion(logItem)
  });
}

export async function getSpotifyConfig(): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  playlistId: string | null;
} | null> {
  const doc = await db.collection('config').doc('spotify').get();
  if (!doc.exists) {
    return null;
  }
  const data = doc.data();
  if (!data?.accessToken || !data?.refreshToken) {
    return null;
  }
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt || 0,
    playlistId: data.playlistId || null
  };
}

export async function updateSpotifyConfig(updates: {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  playlistId?: string;
}): Promise<void> {
  await db.collection('config').doc('spotify').set(updates, { merge: true });
}

export interface FeaturesConfig {
  cobaltEnabled: boolean;
  allowDuplicateUrls: boolean;
}

const DEFAULT_FEATURES: FeaturesConfig = {
  cobaltEnabled: false, // Disabled by default - requires auth
  allowDuplicateUrls: false // Disabled by default - idempotency enabled
};

export async function getFeaturesConfig(): Promise<FeaturesConfig> {
  const doc = await db.collection('config').doc('features').get();
  if (!doc.exists) {
    return DEFAULT_FEATURES;
  }
  const data = doc.data();
  return {
    cobaltEnabled: data?.cobaltEnabled ?? DEFAULT_FEATURES.cobaltEnabled,
    allowDuplicateUrls: data?.allowDuplicateUrls ?? DEFAULT_FEATURES.allowDuplicateUrls
  };
}

export async function updateFeaturesConfig(updates: Partial<FeaturesConfig>): Promise<void> {
  await db.collection('config').doc('features').set(updates, { merge: true });
}

export interface InstagramConfig {
  sessionId: string | null;
  csrfToken: string | null;
  dsUserId: string | null;
  enabled: boolean;
}

const DEFAULT_INSTAGRAM: InstagramConfig = {
  sessionId: null,
  csrfToken: null,
  dsUserId: null,
  enabled: false
};

export async function getInstagramConfig(): Promise<InstagramConfig> {
  const doc = await db.collection('config').doc('instagram').get();
  if (!doc.exists) {
    return DEFAULT_INSTAGRAM;
  }
  const data = doc.data();
  return {
    sessionId: data?.sessionId ?? null,
    csrfToken: data?.csrfToken ?? null,
    dsUserId: data?.dsUserId ?? null,
    enabled: data?.enabled ?? false
  };
}

export async function updateInstagramConfig(updates: Partial<InstagramConfig>): Promise<void> {
  await db.collection('config').doc('instagram').set(updates, { merge: true });
}

export { db };
