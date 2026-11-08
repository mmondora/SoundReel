import type { FastifyInstance } from 'fastify';
import Handlebars from 'handlebars';
import { getPrompt, renderTemplate } from '../services/promptLoader';
import { Logger } from '../services/debugLogger';
import { countEntries, listEntries, createActionLog } from '../utils/db';
import { extractTelegramCommentTags } from '../services/telegramCommentTags';
import { ingestLink, type IngestResult } from '../services/linkIngest';
import { spootyFrontendUrl } from '../services/spootyClient';

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  /** Present on `text_link` / `url` entities when Telegram stores the href separately. */
  url?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id?: number; username?: string; first_name?: string };
  chat: { id: number };
  text?: string;
  entities?: TelegramMessageEntity[];
  /** Share-with-preview / media messages put the URL+comment here instead of `text`. */
  caption?: string;
  caption_entities?: TelegramMessageEntity[];
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/** @deprecated The webhook classifies through `classifyLink` (services/linkIngest). Kept for callers/tests. */
export function isSpotifyUrl(url: string): boolean {
  return /https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|playlist|album)\//.test(url);
}

/** Immediate reply for a Spotify link: what was understood and what happens next. */
export function formatSpotifyAck(result: IngestResult): string {
  const info = result.spotify;
  const home = process.env.FRONTEND_URL || 'https://soundreel.casamon.dev';
  const links = `🌐 <a href="${home}/?entry=${result.entryId}">Apri in SoundReel</a> · <a href="${spootyFrontendUrl()}">Spooty</a>`;
  const name = escapeHtml(info?.caption ?? info?.ref.url ?? 'link Spotify');
  if (result.existing) return `ℹ️ Già in SoundReel: <b>${name}</b>\n${links}`;
  if (!info?.spootyAccepted) {
    return `✅ Salvato in SoundReel: <b>${name}</b>\n⚠️ Spooty non risponde: riprovo da solo.\n${links}`;
  }
  const count = info.ref.kind === 'track' || info.trackCount === 0 ? '' : ` (${info.trackCount} brani)`;
  return `✅ Aggiunto a SoundReel: <b>${name}</b>${count}\n⬇️ In coda su Spooty — ti avviso quando è pronto.\n${links}`;
}

/** Immediate reply for a Shazam link: the song that was read, or why it could not be. */
export function formatShazamAck(result: IngestResult): string {
  const info = result.shazam;
  const home = process.env.FRONTEND_URL || 'https://soundreel.casamon.dev';
  const link = `🌐 <a href="${home}/?entry=${result.entryId}">Apri in SoundReel</a>`;
  if (info?.error) {
    return `⚠️ Link Shazam salvato, ma non riesco a leggere il brano: ${escapeHtml(info.error)}\n🔁 Rimandalo per riprovare.\n${link}`;
  }
  const name = escapeHtml(info?.caption ?? info?.ref.url ?? 'link Shazam');
  if (result.existing) return `ℹ️ Già in SoundReel: <b>${name}</b>\n${link}`;
  return `✅ Aggiunto a SoundReel: <b>${name}</b>\n🎧 Brano Shazam in libreria.\n${link}`;
}

/** Body of the Telegram message that may carry the URL + user comment. */
export function telegramMessageText(message: TelegramMessage): string {
  return (message.text ?? message.caption ?? '').trim();
}

function entitiesFor(message: TelegramMessage): TelegramMessageEntity[] {
  if (message.text && message.entities?.length) return message.entities;
  if (message.caption && message.caption_entities?.length) return message.caption_entities;
  return message.entities ?? message.caption_entities ?? [];
}

export function extractUrl(message: TelegramMessage): string | null {
  const text = telegramMessageText(message);
  if (!text) return null;

  for (const entity of entitiesFor(message)) {
    if (entity.type === 'url') {
      const sliced = text.substring(entity.offset, entity.offset + entity.length);
      if (sliced) return sliced;
    }
    if (entity.type === 'text_link' && entity.url) {
      return entity.url;
    }
  }

  const urlMatch = text.match(/https?:\/\/[^\s<>"']+/i);
  return urlMatch ? urlMatch[0].replace(/[),.;]+$/g, '') : null;
}

export async function sendTelegramMessage(chatId: number, text: string, token: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const body = await res.json().catch(() => null) as { ok?: boolean; description?: string } | null;
  if (!res.ok || !body?.ok) {
    throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${body?.description || ''}`.trim());
  }
}

async function getStats(): Promise<{ entries: number; songs: number; films: number }> {
  const entries = await listEntries(10_000);
  let songs = 0;
  let films = 0;
  for (const e of entries) {
    songs += e.results?.songs?.length || 0;
    films += e.results?.films?.length || 0;
  }
  return { entries: entries.length, songs, films };
}

async function getLastEntry(): Promise<string> {
  const entries = await listEntries(1);
  if (!entries.length) return 'Nessuna entry ancora processata.';
  const e = entries[0];
  const songs = e.results?.songs?.length || 0;
  const films = e.results?.films?.length || 0;
  return `Ultima entry:\n${e.sourceUrl}\n${songs} canzoni, ${films} film`;
}

export interface AnalyzeResult {
  success: boolean;
  entryId?: string;
  entry?: {
    caption?: string | null;
    sourceUrl?: string;
    results: {
      songs: Array<{ title: string; artist: string; album: string | null; addedToPlaylist: boolean }>;
      films: Array<{ title: string; year: string | null; director: string | null }>;
      notes: Array<{ text: string; category: string }>;
      links: Array<{ url: string; label: string | null }>;
      tags: string[];
      summary?: string | null;
      transcript?: string | null;
    };
  };
  error?: string;
}

function frontendUrl(entryId: string): string {
  const base = process.env.FRONTEND_URL || 'https://soundreel.casamon.dev';
  return `${base.replace(/\/$/, '')}/?entry=${entryId}`;
}

export interface AnalysisErrorOptions {
  /**
   * The job is not dead: it has a retry scheduled. Says so in the message, so
   * "renew the session" does not read as "and then re-submit the link" — the
   * worker re-runs it on its own, and the user hears back when it goes through.
   */
  willRetry?: boolean;
}

export function formatAnalysisError(result: AnalyzeResult, opts: AnalysisErrorOptions = {}): string {
  const srl = process.env.FRONTEND_URL || 'https://soundreel.casamon.dev';
  const link = `🌐 <a href="${srl}">Apri SoundReel</a>`;
  const err = result.error ?? '';
  const entryLink = result.entryId ? `\n🔗 <a href="${frontendUrl(result.entryId)}">Vedi entry</a>` : '';
  const retry = opts.willRetry ? '\n🔄 Riprovo da solo: non serve rimandare il link.' : '';

  if (err.includes('challenge_required')) {
    return `⚠️ Instagram richiede una nuova autorizzazione.\nRinnova la sessione su Instaloader.${retry}${entryLink}\n${link}`;
  }
  if (err.includes('unable to extract shortcode') || err === 'instaloader_download_failed') {
    return `⚠️ Estrattore Instagram non disponibile o URL non supportato.\nVerifica che il container Instaloader sia attivo e la sessione valida.${retry}${entryLink}\n${link}`;
  }
  if (err.includes('instaloader')) {
    return `⚠️ Errore Instaloader: ${err.slice(0, 120)}\nVerifica la sessione Instagram.${retry}${entryLink}\n${link}`;
  }
  if (err === 'page_pipeline_failed') {
    return `⚠️ Pagina non accessibile o contenuto insufficiente.${entryLink}\n${link}`;
  }
  return `❌ Analisi fallita${err ? `: ${err.slice(0, 120)}` : ''}.${entryLink}\n${link}`;
}

export async function formatTelegramResponse(result: AnalyzeResult, entryId: string): Promise<string> {
  const results = result.entry?.results || { songs: [], films: [], notes: [], links: [], tags: [], summary: null };
  const { songs, films, links } = results;
  const tags = (results.tags ?? []).filter((t) => typeof t === 'string' && t.trim()).slice(0, 8);
  const summaryRaw = (results as { summary?: string | null }).summary;
  const summary = summaryRaw ? truncateForTelegram(summaryRaw, 280) : null;
  const title = pickTitle(result, summary);

  const linksCount = links.length;
  const songsCount = songs.length;
  const filmsCount = films.length;
  const hasCounts = linksCount > 0 || songsCount > 0 || filmsCount > 0;
  const tagsLine = tags.length ? tags.join(' ') : '';

  const entryHref = frontendUrl(entryId);
  try {
    const promptConfig = await getPrompt('telegramResponse');
    // Handlebars escapes {{var}} by default. Title/summary go through once
    // (raw → Handlebars). The URL must stay raw inside href= — pass a
    // SafeString, and keep {{{frontendUrl}}} in the default template so a
    // custom prompt that still uses {{frontendUrl}} also works.
    const response = renderTemplate(promptConfig.template, {
      title,
      summary: summary || '',
      hasSummary: !!summary,
      linksCount, songsCount, filmsCount, hasCounts,
      tags,
      tagsLine,
      hasTags: tags.length > 0,
      frontendUrl: new Handlebars.SafeString(entryHref),
    });
    return response.replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    const safeTitle = escapeHtml(title);
    const lines = [`<b>${safeTitle}</b>`];
    if (summary) lines.push(escapeHtml(summary));
    lines.push('');
    if (hasCounts) lines.push(`🔗 ${linksCount} · 🎵 ${songsCount} · 🎬 ${filmsCount}`);
    if (tagsLine) lines.push(`🏷️ ${escapeHtml(tagsLine)}`);
    lines.push(`🌐 <a href="${entryHref}">Apri su SoundReel</a>`);
    return lines.join('\n');
  }
}

export function pickTitle(result: AnalyzeResult, summary: string | null): string {
  const r = result.entry as { caption?: string | null; sourceUrl?: string } | undefined;
  const caption = r?.caption?.split(/\r?\n/)[0]?.trim();
  if (caption && caption.length > 0) return caption.slice(0, 90);
  if (summary) return summary.slice(0, 80);
  if (r?.sourceUrl) {
    try { return new URL(r.sourceUrl).hostname.replace(/^www\./, ''); }
    catch { return 'SoundReel' }
  }
  return 'SoundReel';
}

export function truncateForTelegram(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function telegramUser(msg: TelegramMessage): string | null {
  if (msg.from?.username) return `@${msg.from.username}`;
  if (msg.from?.first_name) return msg.from.first_name;
  return null;
}


export function registerTelegramRoute(app: FastifyInstance): void {
  // Count route
  app.get('/telegram/stats', async () => getStats());

  app.post<{ Body: TelegramUpdate }>('/telegram/webhook', async (req, reply) => {
    const log = new Logger('telegramWebhook');
    log.startTimer();

    const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      log.error('TELEGRAM_BOT_TOKEN not configured');
      reply.code(200).send('OK');
      return;
    }

    if (expectedSecret && secretHeader !== expectedSecret) {
      log.warn('Secret non valido', { received: secretHeader ? 'present' : 'missing' });
      reply.code(401).send('Unauthorized');
      return;
    }

    const update = req.body;
    const message = update?.message;
    if (!message) {
      log.debug('Update senza messaggio', { updateId: update?.update_id });
      reply.code(200).send('OK');
      return;
    }

    const chatId = message.chat.id;
    const text = telegramMessageText(message);

    try {
      if (text === '/start') {
        await sendTelegramMessage(
          chatId,
          'Ciao! Sono SoundReel Bot.\n\nInviami un link da Instagram, TikTok o qualsiasi post social e lo analizzo per estrarre canzoni e film!\n\nSe è la prima volta, ti chiederò il tuo nome proprio così i link restano nel tuo journal.',
          token
        );
        reply.code(200).send('OK');
        return;
      }

      if (text === '/stats') {
        const stats = await getStats();
        await sendTelegramMessage(
          chatId,
          `📊 <b>Statistiche SoundReel</b>\n\n📋 Entry: ${stats.entries}\n🎵 Canzoni: ${stats.songs}\n🎬 Film: ${stats.films}`,
          token
        );
        reply.code(200).send('OK');
        return;
      }

      if (text === '/status') {
        const lastEntry = await getLastEntry();
        await sendTelegramMessage(chatId, lastEntry, token);
        reply.code(200).send('OK');
        return;
      }

      const {
        resolveTelegramOwner,
        isPendingName,
        markPendingName,
        clearPendingName,
        claimTelegramName,
        ASK_NAME_MESSAGE,
      } = await import('../services/telegramIdentity');

      const url = extractUrl(message);
      if (!url) {
        // Plain text while waiting for identity claim.
        if (isPendingName(chatId) && text.trim()) {
          const claim = await claimTelegramName(message.from, text);
          if (claim.ok) {
            clearPendingName(chatId);
            await sendTelegramMessage(
              chatId,
              `Ok, ${claim.claimedName}. Da ora i link che invii vanno nel tuo journal SoundReel.`,
              token,
            );
          } else {
            await sendTelegramMessage(
              chatId,
              'Non ho riconosciuto il nome. Scrivi il tuo nome proprio, oppure invia un link e lo terrò come Anonymous finché non ti associ.',
              token,
            );
          }
          reply.code(200).send('OK');
          return;
        }
        await sendTelegramMessage(
          chatId,
          'Inviami un link da Instagram, TikTok o qualsiasi post social e lo analizzo per te!',
          token
        );
        reply.code(200).send('OK');
        return;
      }

      // One entry point for every link (same for Telegram, Mondrop share and web):
      // Spotify → journal entry + Spooty download, anything else → stub entry + analysis job.
      const tgUser = telegramUser(message);
      // Free text in the same message as the URL → filter tags (plus AI tags later).
      const commentTags = extractTelegramCommentTags(text, url);
      log.info('Telegram comment tags', {
        hasComment: commentTags.length > 0,
        tags: commentTags,
        textLen: text.length,
        fromCaption: !message.text && !!message.caption,
      });

      let ingest: IngestResult | null = null;
      try {
        // Prefer telegram_identities mapping; else Authelia-like username; else anonymous.
        // Unmapped users are asked for their proper name (no name suggestions).
        const { normalizeFamilyUser, ANONYMOUS_USER } = await import('../utils/requestUser');
        const mapped = await resolveTelegramOwner(message.from);
        const ownerUser =
          mapped.mapped
            ? mapped.ownerUser
            : (normalizeFamilyUser(tgUser?.replace(/^@/, '') ?? null) ?? ANONYMOUS_USER);
        if (!mapped.mapped && ownerUser === ANONYMOUS_USER) {
          markPendingName(chatId);
          await sendTelegramMessage(chatId, ASK_NAME_MESSAGE, token);
          // Still accept the URL under anonymous so it is not lost; admins can browse it.
        }
        const tgMsgLog = createActionLog('telegram_message', {
          channel: 'telegram',
          user: tgUser,
          ownerUser,
          textPreview: text.slice(0, 240),
          commentTags,
        });
        ingest = await ingestLink({
          url,
          channel: 'telegram',
          inputUser: tgUser,
          ownerUser,
          tags: commentTags,
          chatId,
          logs: {
            onNew: [createActionLog('url_received', { channel: 'telegram', user: tgUser, ownerUser }), tgMsgLog],
            onExisting: [tgMsgLog],
            tagsAction: 'telegram_comment_tags',
          },
        });
      } catch (ingestErr) {
        log.error('Link ingest failed', ingestErr instanceof Error ? ingestErr : new Error(String(ingestErr)));
      }

      // If the stub entry write or the enqueue itself failed (e.g. a DB
      // hiccup), the link never entered the system — tell the user instead
      // of silently replying 200 with no entry, no job, and no feedback.
      // Analysis jobs send no "analizzo…" ack: the user only wants the final
      // result (or a clear failure). Spotify and Shazam links get an immediate ack
      // because the metadata is known right away (a Spotify download outcome arrives later).
      if (!ingest) {
        await sendTelegramMessage(
          chatId,
          `❌ Analisi fallita.\n🌐 <a href="${process.env.FRONTEND_URL || 'https://soundreel.casamon.dev'}">Apri SoundReel</a>`,
          token
        ).catch(() => {});
      } else if (ingest.kind === 'spotify') {
        await sendTelegramMessage(chatId, formatSpotifyAck(ingest), token).catch((err) => {
          log.error('Spotify ack failed', err instanceof Error ? err : new Error(String(err)));
        });
      } else if (ingest.kind === 'shazam') {
        await sendTelegramMessage(chatId, formatShazamAck(ingest), token).catch((err) => {
          log.error('Shazam ack failed', err instanceof Error ? err : new Error(String(err)));
        });
      }

      reply.code(200).send('OK');
      await countEntries().catch(() => 0);
      return;
    } catch (error) {
      log.error('Webhook fallito', error instanceof Error ? error : new Error(String(error)));
      try {
        await sendTelegramMessage(chatId, `❌ Analisi fallita.\n🌐 <a href="${process.env.FRONTEND_URL || 'https://soundreel.casamon.dev'}">Apri SoundReel</a>`, token);
      } catch {}
      reply.code(200).send('OK');
      return;
    }
  });
}
