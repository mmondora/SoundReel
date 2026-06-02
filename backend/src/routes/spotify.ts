import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { exchangeAuthCode, getRedirectUri, searchTracks, SpotifyTrackResult } from '../services/spotify';
import { getSpotifyConfig } from '../utils/db';

const authState = new Map<string, { codeVerifier: string; createdAt: number }>();

function cleanupStates(): void {
  const now = Date.now();
  for (const [k, v] of authState.entries()) {
    if (now - v.createdAt > 10 * 60_000) authState.delete(k);
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function registerSpotifyRoutes(app: FastifyInstance): void {
  app.get('/api/spotify/status', async () => {
    const config = await getSpotifyConfig();
    return {
      connected: !!config,
      playlistId: config?.playlistId ?? null,
    };
  });

  app.get('/api/spotify/authorize', async (_req, reply) => {
    cleanupStates();
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    if (!clientId) {
      reply.code(500).send({ error: 'SPOTIFY_CLIENT_ID not set' });
      return;
    }

    const codeVerifier = base64UrlEncode(randomBytes(32));
    const codeChallenge = base64UrlEncode(createHash('sha256').update(codeVerifier).digest());
    const state = base64UrlEncode(randomBytes(16));
    authState.set(state, { codeVerifier, createdAt: Date.now() });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: 'playlist-modify-private playlist-modify-public playlist-read-private user-read-private',
      redirect_uri: getRedirectUri(),
      state,
      code_challenge_method: 'S256',
      code_challenge: codeChallenge,
    });

    reply.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/spotify/callback', async (req, reply) => {
    const { code, state, error } = req.query;
    if (error) {
      reply.type('text/html').send(`<h1>Errore Spotify</h1><p>${error}</p>`);
      return;
    }
    if (!code || !state) {
      reply.code(400).send({ error: 'missing code/state' });
      return;
    }
    const stored = authState.get(state);
    if (!stored) {
      reply.code(400).send({ error: 'invalid or expired state' });
      return;
    }
    authState.delete(state);

    const ok = await exchangeAuthCode(code, stored.codeVerifier);
    if (!ok) {
      reply.type('text/html').send('<h1>Errore scambio token Spotify</h1>');
      return;
    }

    reply.type('text/html').send(
      '<html><body><h1>Spotify collegato ✓</h1><p>Puoi chiudere questa finestra e tornare a SoundReel.</p><script>setTimeout(()=>window.close(),1500)</script></body></html>'
    );
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/spotify/search', async (req, reply) => {
    const q = (req.query.q ?? '').trim();
    const limit = Math.min(10, Math.max(1, Number(req.query.limit ?? 5)));

    if (!q) {
      reply.code(400).send({ error: 'q parameter required' });
      return;
    }

    const config = await getSpotifyConfig();
    if (!config) {
      reply.code(503).send({ error: 'spotify_not_connected' });
      return;
    }

    const tracks: SpotifyTrackResult[] = await searchTracks(q, limit);
    reply.send(tracks);
  });
}
