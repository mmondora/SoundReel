# Prompt 006 — API Lettura SoundReel (Entries)

**Progetto:** SoundReel (backend)  
**Dipendenze:** SoundReel Firestore (cross-project)  
**Priorità:** Alta  
**Stima:** 2-3 ore

---

## Obiettivo

Creare un servizio per leggere le entries da SoundReel Firestore, filtrate per i device configurati dall'utente. Le entries contengono canzoni, film, link e note salvate dall'utente.

---

## Struttura dati SoundReel (sola lettura)

Collection: `entries`

```typescript
// Schema documento SoundReel (riferimento, non modificare)
interface SoundReelEntry {
  id: string;
  sourceUrl: string;                    // URL del reel/post originale
  sourcePlatform: string;               // "instagram", "tiktok", "youtube", etc.
  inputChannel: string;                 // "telegram", "web"
  caption?: string;
  thumbnailUrl?: string;
  authorName?: string;
  status: 'processing' | 'completed' | 'error';
  
  results: {
    songs: Array<{
      title: string;
      artist: string;
      album?: string;
      spotifyUrl?: string;
      youtubeUrl?: string;
    }>;
    films: Array<{
      title: string;
      director?: string;
      year?: string;
      imdbUrl?: string;
    }>;
    notes: Array<{
      text: string;
      type: string;                     // "luogo", "evento", "brand", "libro", "prodotto", "citazione", "persona"
    }>;
    links: Array<{
      url: string;
      title?: string;
    }>;
    tags: string[];
    summary?: string;
  };
  
  createdAt: Timestamp;
}
```

**Nota:** SoundReel attualmente NON ha `clientId`/`deviceId`. L'utente salva contenuti via Telegram bot o web — non c'è correlazione device. Per ora, leggiamo TUTTI i contenuti nelle ultime 24h (single-user app).

**Evoluzione futura:** Se SoundReel diventa multi-utente, aggiungere filtro per userId o deviceId.

---

## Servizio SoundReel Client

```typescript
// functions/src/services/soundreel-client.ts

import { initializeApp, cert, App } from 'firebase-admin/app';
import { getFirestore, Firestore, Timestamp } from 'firebase-admin/firestore';

interface SoundReelConfig {
  projectId: string;
  serviceAccountJson: string;           // JSON stringificato da Secret Manager
}

interface SoundReelSource {
  projectId: string;
  collection: string;
  consoleUrl: string;
}

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
  data: Record<string, any>;            // Dati originali completi
}

interface SoundReelContent {
  source: SoundReelSource;
  songs: SoundReelContentItem[];
  films: SoundReelContentItem[];
  links: SoundReelContentItem[];
  notes: SoundReelContentItem[];
  totalCount: number;
}

class SoundReelClient {
  private app: App | null = null;
  private db: Firestore | null = null;
  private config: SoundReelConfig;
  
  constructor(config: SoundReelConfig) {
    this.config = config;
  }
  
  private async getDb(): Promise<Firestore> {
    if (this.db) return this.db;
    
    const serviceAccount = JSON.parse(this.config.serviceAccountJson);
    
    this.app = initializeApp({
      credential: cert(serviceAccount),
      projectId: this.config.projectId
    }, 'soundreel');
    
    this.db = getFirestore(this.app);
    return this.db;
  }
  
  /**
   * Fetch contenuti SoundReel delle ultime N ore
   */
  async fetchContent(
    sinceHours: number = 24,
    limit: number = 50
  ): Promise<SoundReelContent> {
    const db = await this.getDb();
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
    
    // Query entries completate
    const snapshot = await db
      .collection('entries')
      .where('status', '==', 'completed')
      .where('createdAt', '>=', Timestamp.fromDate(since))
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    
    const songs: SoundReelContentItem[] = [];
    const films: SoundReelContentItem[] = [];
    const links: SoundReelContentItem[] = [];
    const notes: SoundReelContentItem[] = [];
    
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const entry = data as SoundReelEntry;
      const timestamp = entry.createdAt.toDate();
      
      // Estrai canzoni
      if (entry.results?.songs) {
        for (const song of entry.results.songs) {
          songs.push({
            id: `${doc.id}_song_${songs.length}`,
            docPath: `entries/${doc.id}`,
            type: 'song',
            title: song.title,
            subtitle: song.artist,
            meta: [song.album, `da ${entry.sourcePlatform}`].filter(Boolean).join(' • '),
            timestamp,
            sourceUrl: entry.sourceUrl,
            sourcePlatform: entry.sourcePlatform,
            data: { ...song, entryId: doc.id }
          });
        }
      }
      
      // Estrai film
      if (entry.results?.films) {
        for (const film of entry.results.films) {
          films.push({
            id: `${doc.id}_film_${films.length}`,
            docPath: `entries/${doc.id}`,
            type: 'film',
            title: `${film.title}${film.year ? ` (${film.year})` : ''}`,
            subtitle: film.director,
            meta: `da ${entry.sourcePlatform}`,
            timestamp,
            sourceUrl: entry.sourceUrl,
            sourcePlatform: entry.sourcePlatform,
            data: { ...film, entryId: doc.id }
          });
        }
      }
      
      // Estrai link
      if (entry.results?.links) {
        for (const link of entry.results.links) {
          links.push({
            id: `${doc.id}_link_${links.length}`,
            docPath: `entries/${doc.id}`,
            type: 'link',
            title: link.title || link.url,
            subtitle: new URL(link.url).hostname,
            meta: formatTimeAgo(timestamp),
            timestamp,
            sourceUrl: entry.sourceUrl,
            sourcePlatform: entry.sourcePlatform,
            data: { ...link, entryId: doc.id }
          });
        }
      }
      
      // Estrai note
      if (entry.results?.notes) {
        for (const note of entry.results.notes) {
          notes.push({
            id: `${doc.id}_note_${notes.length}`,
            docPath: `entries/${doc.id}`,
            type: 'note',
            title: note.text,
            subtitle: `tipo: ${note.type}`,
            meta: formatTimeAgo(timestamp),
            timestamp,
            sourceUrl: entry.sourceUrl,
            sourcePlatform: entry.sourcePlatform,
            data: { ...note, entryId: doc.id }
          });
        }
      }
    }
    
    return {
      source: {
        projectId: this.config.projectId,
        collection: 'entries',
        consoleUrl: this.buildConsoleUrl('entries')
      },
      songs,
      films,
      links,
      notes,
      totalCount: songs.length + films.length + links.length + notes.length
    };
  }
  
  /**
   * Test connessione
   */
  async testConnection(): Promise<{
    success: boolean;
    latencyMs: number;
    error?: string;
    documentCount?: number;
  }> {
    const start = Date.now();
    
    try {
      const db = await this.getDb();
      const snapshot = await db.collection('entries').limit(1).get();
      
      // Conta documenti ultime 24h
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const countSnapshot = await db
        .collection('entries')
        .where('status', '==', 'completed')
        .where('createdAt', '>=', Timestamp.fromDate(since))
        .count()
        .get();
      
      return {
        success: true,
        latencyMs: Date.now() - start,
        documentCount: countSnapshot.data().count
      };
    } catch (err) {
      return {
        success: false,
        latencyMs: Date.now() - start,
        error: err.message
      };
    }
  }
  
  private buildConsoleUrl(collection: string): string {
    const encoded = collection.replace(/\//g, '~2F');
    return `https://console.firebase.google.com/project/${this.config.projectId}/firestore/data/~2F${encoded}`;
  }
}

export { SoundReelClient, SoundReelContent, SoundReelContentItem };
```

---

## API Endpoints

```typescript
// functions/src/api/soundreel.ts

import { SoundReelClient } from '../services/soundreel-client';

/**
 * GET /sources/soundreel/content
 * 
 * Ritorna contenuti SoundReel delle ultime 24h
 */
export async function getSoundReelContent(req: Request, res: Response) {
  const tenantId = req.user.tenantId;
  const config = await getConfig(tenantId);
  
  if (!config.soundreel?.projectId || !config.soundreel?.serviceAccountJson) {
    return res.status(400).json({
      error: 'SoundReel non configurato',
      message: 'Configura Project ID e Service Account in Impostazioni → Connessioni'
    });
  }
  
  const client = new SoundReelClient({
    projectId: config.soundreel.projectId,
    serviceAccountJson: config.soundreel.serviceAccountJson
  });
  
  const hours = parseInt(req.query.hours as string) || 24;
  const limit = parseInt(req.query.limit as string) || 50;
  
  try {
    const content = await client.fetchContent(hours, limit);
    return res.json(content);
  } catch (err) {
    return res.status(500).json({
      error: 'Errore lettura SoundReel',
      message: err.message
    });
  }
}

/**
 * POST /sources/soundreel/test
 * 
 * Test connessione SoundReel
 */
export async function testSoundReelConnection(req: Request, res: Response) {
  const tenantId = req.user.tenantId;
  const config = await getConfig(tenantId);
  
  if (!config.soundreel?.projectId || !config.soundreel?.serviceAccountJson) {
    return res.status(200).json({
      success: false,
      steps: [{
        name: 'Configurazione',
        status: 'error',
        message: 'SoundReel non configurato'
      }],
      error: 'Configura Project ID e Service Account prima di testare'
    });
  }
  
  const client = new SoundReelClient({
    projectId: config.soundreel.projectId,
    serviceAccountJson: config.soundreel.serviceAccountJson
  });
  
  const result = await client.testConnection();
  
  const steps = [
    {
      name: 'Connessione Firestore',
      status: result.success ? 'ok' : 'error',
      message: result.success 
        ? `Progetto: ${config.soundreel.projectId}`
        : `Errore: ${result.error}`,
      detail: result.success ? `latenza: ${result.latencyMs}ms` : undefined
    }
  ];
  
  if (result.success) {
    steps.push({
      name: 'Accesso collection',
      status: 'ok',
      message: 'Collection "entries" accessibile'
    });
    
    steps.push({
      name: 'Contenuti disponibili',
      status: result.documentCount > 0 ? 'ok' : 'warning',
      message: result.documentCount > 0
        ? `${result.documentCount} entries nelle ultime 24h`
        : 'Nessuna entry nelle ultime 24h'
    });
  }
  
  return res.json({
    success: result.success,
    steps,
    durationMs: result.latencyMs,
    preview: result.success ? await client.fetchContent(24, 3) : undefined
  });
}
```

---

## Registra routes

```typescript
// functions/src/router.ts

import { getSoundReelContent, testSoundReelConnection } from './api/soundreel';

// Aggiungi routes
router.get('/sources/soundreel/content', auth, getSoundReelContent);
router.post('/sources/soundreel/test', auth, testSoundReelConnection);
```

---

## Configurazione tenant

Aggiungi a `tenants/{tenantId}` config:

```typescript
interface TenantConfig {
  // ... esistenti
  
  soundreel?: {
    projectId: string;                  // "soundreel-prod"
    serviceAccountJson: string;         // JSON service account (encrypted at rest)
    enabled: boolean;
  };
}
```

---

## Secret Management

Il service account JSON deve essere salvato in modo sicuro:

```typescript
// Salvataggio (da UI Config)
async function saveSoundReelConfig(tenantId: string, projectId: string, serviceAccountJson: string) {
  // Valida JSON
  try {
    const parsed = JSON.parse(serviceAccountJson);
    if (!parsed.project_id || !parsed.private_key) {
      throw new Error('Service account JSON non valido');
    }
  } catch (err) {
    throw new Error('JSON non valido: ' + err.message);
  }
  
  await db.doc(`tenants/${tenantId}`).update({
    'soundreel.projectId': projectId,
    'soundreel.serviceAccountJson': serviceAccountJson,  // In produzione, cifrare
    'soundreel.enabled': true
  });
}
```

---

## Test

| Test | Expected |
|------|----------|
| SoundReel non configurato | 400 con messaggio chiaro |
| Service account invalido | Errore connessione |
| Collection vuota | Success con warning "nessuna entry" |
| Entries presenti | Lista songs, films, links, notes |
| Test connessione | Steps ok + preview 3 items |
| consoleUrl | URL valido a Firebase Console |

---

## File da creare

```
functions/src/
├── services/
│   └── soundreel-client.ts        # NUOVO
├── api/
│   └── soundreel.ts               # NUOVO
└── router.ts                      # MODIFICA - aggiungi routes
```
