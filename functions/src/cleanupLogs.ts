import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

const RETENTION_DAYS = 7;

async function deleteOldLogs(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);

  const snapshot = await db.collection('logs')
    .where('timestamp', '<', cutoffDate.toISOString())
    .limit(500) // Batch di 500 per evitare timeout
    .get();

  if (snapshot.empty) {
    return 0;
  }

  const batch = db.batch();
  snapshot.docs.forEach(doc => {
    batch.delete(doc.ref);
  });

  await batch.commit();
  return snapshot.size;
}

// Scheduled: ogni giorno a mezzanotte
export const cleanupLogs = onSchedule(
  {
    schedule: 'every 24 hours',
    region: 'europe-west1',
    timeZone: 'Europe/Rome'
  },
  async () => {
    console.log('Starting log cleanup...');

    let totalDeleted = 0;
    let deleted = 0;

    // Continua a eliminare finché ci sono log vecchi
    do {
      deleted = await deleteOldLogs();
      totalDeleted += deleted;
    } while (deleted === 500);

    console.log(`Log cleanup completed. Deleted ${totalDeleted} logs.`);
  }
);

// Endpoint manuale per cleanup
export const clearAllLogs = onRequest(
  {
    region: 'europe-west1',
    cors: true
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Metodo non consentito' });
      return;
    }

    console.log('Manual log clear requested');

    let totalDeleted = 0;
    let batchSize = 0;

    do {
      const snapshot = await db.collection('logs').limit(500).get();
      batchSize = snapshot.size;

      if (batchSize > 0) {
        const batch = db.batch();
        snapshot.docs.forEach(doc => {
          batch.delete(doc.ref);
        });
        await batch.commit();
        totalDeleted += batchSize;
      }
    } while (batchSize === 500);

    console.log(`Cleared ${totalDeleted} logs`);
    res.json({ success: true, deleted: totalDeleted });
  }
);
