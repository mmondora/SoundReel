/**
 * Public share ingest for the iOS/macOS Share Extension.
 * Auth: `X-SoundReel-Key` must match a key in config `apiKeys.keys`.
 * Fast path: stub entry + job queue (same reliability model as Telegram).
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createActionLog, getApiKeysConfig } from '../utils/db';
import { authenticateApiKey } from '../utils/apiKeyAuth';
import { extractTelegramCommentTags } from '../services/telegramCommentTags';
import { ingestLink } from '../services/linkIngest';
import { Logger } from '../services/debugLogger';

type ShareDeviceInfo = {
  name?: string;
  model?: string;
  system?: string;
  timeZone?: string;
};

type ShareBody = {
  url?: string;
  /** Free-text comment / hashtags (same rules as Telegram). */
  comment?: string;
  /** Explicit tags; merged with tags extracted from `comment`. */
  tags?: string[];
  channel?: 'ios' | 'macos' | 'share';
  /** Authelia username (mike / archi / sara) or display override. */
  user?: string | null;
  /** Device-local timestamp ISO-8601 with offset (when the user tapped Invia). */
  sharedAt?: string | null;
  device?: ShareDeviceInfo | null;
};

function mergeTagLists(...lists: Array<string[] | undefined>): string[] {
  const out: string[] = [];
  const idx = new Map<string, number>();
  for (const list of lists) {
    for (const raw of list ?? []) {
      const t = String(raw).trim();
      if (!t) continue;
      const bare = t.replace(/^[#@]/, '').toLowerCase();
      if (!bare) continue;
      const prev = idx.get(bare);
      if (prev === undefined) {
        idx.set(bare, out.length);
        out.push(t);
      } else if ((t.startsWith('#') || t.startsWith('@')) && !out[prev].startsWith('#') && !out[prev].startsWith('@')) {
        out[prev] = t;
      }
    }
  }
  return out.slice(0, 15);
}

export function registerShareRoute(app: FastifyInstance): void {
  app.post<{ Body: ShareBody }>('/api/share', async (req, reply) => {
    const log = new Logger('share');
    const auth = await authenticateApiKey(req.headers['x-soundreel-key']);
    if (!auth) {
      return reply.code(401).send({ success: false, error: 'unauthorized' });
    }

    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!url || !/^https?:\/\//i.test(url)) {
      return reply.code(400).send({ success: false, error: 'url required' });
    }

    const comment = typeof req.body?.comment === 'string' ? req.body.comment : '';
    const explicitTags = Array.isArray(req.body?.tags)
      ? req.body.tags.filter((t): t is string => typeof t === 'string')
      : [];
    const fromComment = extractTelegramCommentTags(`${url} ${comment}`.trim(), url);
    const tags = mergeTagLists(fromComment, explicitTags);

    // Journal channel stays `ios` for both iPhone and Mac clients (filter badge).
    const inputChannel = 'ios' as const;
    const shareChannel =
      req.body?.channel === 'macos' || req.body?.channel === 'share' || req.body?.channel === 'ios'
        ? req.body.channel
        : 'ios';
    // A key issued via /mondrop/connect is bound to its Authelia user: it wins over body.user.
    const inputUser =
      auth.owner?.user ??
      (typeof req.body?.user === 'string' && req.body.user.trim()
        ? req.body.user.trim().toLowerCase()
        : null);
    const sharedAt =
      typeof req.body?.sharedAt === 'string' && req.body.sharedAt.trim()
        ? req.body.sharedAt.trim()
        : null;
    const device =
      req.body?.device && typeof req.body.device === 'object'
        ? {
            name: typeof req.body.device.name === 'string' ? req.body.device.name.slice(0, 80) : undefined,
            model: typeof req.body.device.model === 'string' ? req.body.device.model.slice(0, 80) : undefined,
            system: typeof req.body.device.system === 'string' ? req.body.device.system.slice(0, 80) : undefined,
            timeZone:
              typeof req.body.device.timeZone === 'string' ? req.body.device.timeZone.slice(0, 80) : undefined,
          }
        : null;

    const receiveDetails = {
      channel: inputChannel,
      shareChannel,
      user: inputUser,
      sharedAt,
      device,
      via: 'api_share' as const,
      commentPreview: comment.slice(0, 120),
    };

    try {
      // One entry point for every link: Spotify → library + Spooty, anything else → stub + analysis job.
      // `url_received` is the same audit item for a new and an already-known URL.
      const received = createActionLog('url_received', receiveDetails);
      const result = await ingestLink({
        url,
        channel: inputChannel,
        inputUser,
        ownerUser: inputUser ?? 'anonymous',
        tags,
        notify: false,
        logs: { onNew: [received], onExisting: [received], tagsAction: 'share_comment_tags' },
      });

      log.info('Share enqueued', { entryId: result.entryId, platform: result.platform, kind: result.kind, tags });

      // A Shazam link is stored even when its page cannot be read; say so now (the share sheet shows
      // `error` and stays open) — sharing the same link again retries.
      if (result.shazam?.error) {
        return {
          success: false,
          entryId: result.entryId,
          tags: result.tags,
          status: 'error',
          kind: result.kind,
          error: `Shazam: ${result.shazam.error}`,
        };
      }

      const track = result.spotify ?? result.shazam;
      return {
        success: true,
        entryId: result.entryId,
        tags: result.tags,
        // Shazam songs are read synchronously: nothing is left in the queue.
        status: result.kind === 'shazam' ? 'completed' : 'queued',
        kind: result.kind,
        ...(track ? { title: track.title, artist: track.artist } : {}),
      };
    } catch (err) {
      log.error('Share failed', err instanceof Error ? err : new Error(String(err)));
      return reply.code(500).send({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Mint helper for local/admin use — Remote-User (Authelia), loopback, or Host localhost
   *  (docker publishes 127.0.0.1:8081 → container sees bridge IP, Host stays 127.0.0.1). */
  app.post('/api/share/mint-key', async (req, reply) => {
    const remoteUser = req.headers['remote-user'];
    const ip = req.ip || '';
    const isLoopback =
      ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
    const hostHdr = String(req.headers.host || '');
    const isLocalHostHdr = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(hostHdr);
    if (!remoteUser && !isLoopback && !isLocalHostHdr) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const key = `sr_${randomBytes(24).toString('base64url')}`;
    const cfg = await getApiKeysConfig();
    const keys = [...(cfg.keys ?? []).filter((k) => typeof k === 'string'), key];
    const { updateApiKeysConfig } = await import('../utils/db');
    await updateApiKeysConfig({ keys });
    return { key, count: keys.length };
  });
}
