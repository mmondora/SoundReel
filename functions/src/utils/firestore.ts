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

export async function getEntry(entryId: string): Promise<Entry | null> {
  const doc = await db.collection('entries').doc(entryId).get();
  if (!doc.exists) {
    return null;
  }
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
  updates: Partial<Entry> | Record<string, unknown>
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
  autoEnrichEnabled: boolean;
  mediaAnalysisEnabled: boolean;
  useVertexAi: boolean;
  transcriptionEnabled: boolean;
  aiAnalysisEnabled: boolean;
}

const DEFAULT_FEATURES: FeaturesConfig = {
  cobaltEnabled: false, // Disabled by default - requires auth
  allowDuplicateUrls: false, // Disabled by default - idempotency enabled
  autoEnrichEnabled: false, // Disabled by default - requires OpenAI config
  mediaAnalysisEnabled: false, // Disabled by default - uses more resources
  useVertexAi: true, // Enabled by default - uses GCP ADC
  transcriptionEnabled: true, // Enabled by default
  aiAnalysisEnabled: true // Enabled by default
};

export async function getFeaturesConfig(): Promise<FeaturesConfig> {
  const doc = await db.collection('config').doc('features').get();
  if (!doc.exists) {
    return DEFAULT_FEATURES;
  }
  const data = doc.data();
  return {
    cobaltEnabled: data?.cobaltEnabled ?? DEFAULT_FEATURES.cobaltEnabled,
    allowDuplicateUrls: data?.allowDuplicateUrls ?? DEFAULT_FEATURES.allowDuplicateUrls,
    autoEnrichEnabled: data?.autoEnrichEnabled ?? DEFAULT_FEATURES.autoEnrichEnabled,
    mediaAnalysisEnabled: data?.mediaAnalysisEnabled ?? DEFAULT_FEATURES.mediaAnalysisEnabled,
    useVertexAi: data?.useVertexAi ?? DEFAULT_FEATURES.useVertexAi,
    transcriptionEnabled: data?.transcriptionEnabled ?? DEFAULT_FEATURES.transcriptionEnabled,
    aiAnalysisEnabled: data?.aiAnalysisEnabled ?? DEFAULT_FEATURES.aiAnalysisEnabled
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

export interface OpenAIConfig {
  apiKey: string | null;
  enabled: boolean;
}

const DEFAULT_OPENAI: OpenAIConfig = {
  apiKey: null,
  enabled: false
};

export async function getOpenAIConfig(): Promise<OpenAIConfig> {
  const doc = await db.collection('config').doc('openai').get();
  if (!doc.exists) {
    return DEFAULT_OPENAI;
  }
  const data = doc.data();
  return {
    apiKey: data?.apiKey ?? null,
    enabled: data?.enabled ?? false
  };
}

export async function updateOpenAIConfig(updates: Partial<OpenAIConfig>): Promise<void> {
  await db.collection('config').doc('openai').set(updates, { merge: true });
}

export interface ApiKeysConfig {
  keys: string[];
}

const DEFAULT_API_KEYS: ApiKeysConfig = {
  keys: []
};

export async function getApiKeysConfig(): Promise<ApiKeysConfig> {
  const doc = await db.collection('config').doc('apiKeys').get();
  if (!doc.exists) {
    return DEFAULT_API_KEYS;
  }
  const data = doc.data();
  return {
    keys: data?.keys ?? []
  };
}

export async function updateApiKeysConfig(updates: Partial<ApiKeysConfig>): Promise<void> {
  await db.collection('config').doc('apiKeys').set(updates, { merge: true });
}

export { db };
