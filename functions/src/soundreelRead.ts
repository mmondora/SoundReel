import { onRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { db, getApiKeysConfig } from './utils/firestore';
import type { Entry } from './types';

interface SoundReelContentItem {
  id: string;
  docPath: string;
  type: 'song' | 'film' | 'link' | 'note';
  title: string;
  subtitle?: string;
  meta: string;
  timestamp: Date;
  sourceUrl?: string;
  sourcePlatform?: string;
  data: Record<string, unknown>;
}

interface SoundReelSource {
  projectId: string;
  collection: string;
  consoleUrl: string;
}

interface SoundReelContent {
  source: SoundReelSource;
  songs: SoundReelContentItem[];
  films: SoundReelContentItem[];
  links: SoundReelContentItem[];
  notes: SoundReelContentItem[];
  totalCount: number;
}

async function validateApiKey(req: { headers: { authorization?: string } }): Promise<boolean> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }
  const key = authHeader.slice(7);
  const config = await getApiKeysConfig();
  return config.keys.includes(key);
}

function buildConsoleUrl(collection: string): string {
  const projectId = 'soundreel-776c1';
  const encoded = collection.replace(/\//g, '~2F');
  return `https://console.firebase.google.com/project/${projectId}/firestore/data/~2F${encoded}`;
}

function tryParseHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function transformEntries(docs: FirebaseFirestore.QueryDocumentSnapshot[]): SoundReelContent {
  const songs: SoundReelContentItem[] = [];
  const films: SoundReelContentItem[] = [];
  const links: SoundReelContentItem[] = [];
  const notes: SoundReelContentItem[] = [];

  for (const doc of docs) {
    const data = doc.data() as Entry;
    const createdAt = data.createdAt;
    const timestamp = createdAt instanceof Timestamp
      ? createdAt.toDate()
      : new Date(createdAt as string);

    if (data.results?.songs) {
      for (const song of data.results.songs) {
        songs.push({
          id: `${doc.id}_song_${songs.length}`,
          docPath: `entries/${doc.id}`,
          type: 'song',
          title: song.title,
          subtitle: song.artist,
          meta: [song.album, `da ${data.sourcePlatform}`].filter(Boolean).join(' \u2022 '),
          timestamp,
          sourceUrl: data.sourceUrl,
          sourcePlatform: data.sourcePlatform,
          data: { ...song, entryId: doc.id } as Record<string, unknown>
        });
      }
    }

    if (data.results?.films) {
      for (const film of data.results.films) {
        films.push({
          id: `${doc.id}_film_${films.length}`,
          docPath: `entries/${doc.id}`,
          type: 'film',
          title: `${film.title}${film.year ? ` (${film.year})` : ''}`,
          subtitle: film.director ?? undefined,
          meta: `da ${data.sourcePlatform}`,
          timestamp,
          sourceUrl: data.sourceUrl,
          sourcePlatform: data.sourcePlatform,
          data: { ...film, entryId: doc.id } as Record<string, unknown>
        });
      }
    }

    if (data.results?.links) {
      for (const link of data.results.links) {
        links.push({
          id: `${doc.id}_link_${links.length}`,
          docPath: `entries/${doc.id}`,
          type: 'link',
          title: link.label || link.url,
          subtitle: tryParseHostname(link.url),
          meta: `da ${data.sourcePlatform}`,
          timestamp,
          sourceUrl: data.sourceUrl,
          sourcePlatform: data.sourcePlatform,
          data: { ...link, entryId: doc.id } as Record<string, unknown>
        });
      }
    }

    if (data.results?.notes) {
      for (const note of data.results.notes) {
        notes.push({
          id: `${doc.id}_note_${notes.length}`,
          docPath: `entries/${doc.id}`,
          type: 'note',
          title: note.text,
          subtitle: `tipo: ${note.category}`,
          meta: `da ${data.sourcePlatform}`,
          timestamp,
          sourceUrl: data.sourceUrl,
          sourcePlatform: data.sourcePlatform,
          data: { ...note, entryId: doc.id } as Record<string, unknown>
        });
      }
    }
  }

  return {
    source: {
      projectId: 'soundreel-776c1',
      collection: 'entries',
      consoleUrl: buildConsoleUrl('entries')
    },
    songs,
    films,
    links,
    notes,
    totalCount: songs.length + films.length + links.length + notes.length
  };
}

export const readEntries = onRequest(
  {
    region: 'europe-west1',
    cors: true
  },
  async (req, res) => {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Metodo non consentito' });
      return;
    }

    if (!(await validateApiKey(req))) {
      res.status(401).json({ error: 'API key non valida o mancante' });
      return;
    }

    try {
      const hours = Math.min(parseInt(req.query.hours as string) || 24, 720);
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

      const since = new Date(Date.now() - hours * 60 * 60 * 1000);

      const snapshot = await db
        .collection('entries')
        .where('status', '==', 'completed')
        .where('createdAt', '>=', Timestamp.fromDate(since))
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();

      const content = transformEntries(snapshot.docs);
      res.json(content);
    } catch (error) {
      console.error('Errore readEntries:', error);
      res.status(500).json({ error: 'Errore interno' });
    }
  }
);

export const testReadConnection = onRequest(
  {
    region: 'europe-west1',
    cors: true
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Metodo non consentito' });
      return;
    }

    if (!(await validateApiKey(req))) {
      res.status(401).json({ error: 'API key non valida o mancante' });
      return;
    }

    const start = Date.now();
    const steps: Array<{ name: string; status: string; message: string; detail?: string }> = [];

    try {
      // Step 1: Test Firestore connection
      await db.collection('entries').limit(1).get();
      steps.push({
        name: 'Connessione Firestore',
        status: 'ok',
        message: 'Progetto: soundreel-776c1',
        detail: `latenza: ${Date.now() - start}ms`
      });

      // Step 2: Check collection access
      steps.push({
        name: 'Accesso collection',
        status: 'ok',
        message: 'Collection "entries" accessibile'
      });

      // Step 3: Count recent entries
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const countSnapshot = await db
        .collection('entries')
        .where('status', '==', 'completed')
        .where('createdAt', '>=', Timestamp.fromDate(since))
        .count()
        .get();
      const docCount = countSnapshot.data().count;

      steps.push({
        name: 'Contenuti disponibili',
        status: docCount > 0 ? 'ok' : 'warning',
        message: docCount > 0
          ? `${docCount} entries nelle ultime 24h`
          : 'Nessuna entry nelle ultime 24h'
      });

      // Preview: fetch 3 items
      const previewSnapshot = await db
        .collection('entries')
        .where('status', '==', 'completed')
        .where('createdAt', '>=', Timestamp.fromDate(since))
        .orderBy('createdAt', 'desc')
        .limit(3)
        .get();

      const preview = transformEntries(previewSnapshot.docs);

      res.json({
        success: true,
        steps,
        durationMs: Date.now() - start,
        preview
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Errore sconosciuto';
      steps.push({
        name: 'Connessione Firestore',
        status: 'error',
        message: `Errore: ${errMsg}`
      });

      res.json({
        success: false,
        steps,
        durationMs: Date.now() - start
      });
    }
  }
);
