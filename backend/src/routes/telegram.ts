import type { FastifyInstance } from 'fastify';
import { getPrompt, renderTemplate } from '../services/promptLoader';
import { Logger } from '../services/debugLogger';
import { countEntries, listEntries } from '../utils/db';

interface TelegramMessage {
  message_id: number;
  from?: { username?: string; first_name?: string };
  chat: { id: number };
  text?: string;
  entities?: Array<{ type: string; offset: number; length: number }>;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

function isSpotifyUrl(url: string): boolean {
  return /https?:\/\/open\.spotify\.com\/(track|playlist|album)\//.test(url);
}

async function sendToSpooty(spotifyUrl: string): Promise<void> {
  const spootyBase = process.env.SPOOTY_URL || 'http://spooty:3000';
  const res = await fetch(`${spootyBase}/playlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spotifyUrl }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Spooty HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

function extractUrl(message: TelegramMessage): string | null {
  if (!message.text) return null;
  if (message.entities) {
    for (const entity of message.entities) {
      if (entity.type === 'url') {
        return message.text.substring(entity.offset, entity.offset + entity.length);
      }
    }
  }
  const urlMatch = message.text.match(/https?:\/\/[^\s]+/i);
  return urlMatch ? urlMatch[0] : null;
}

async function sendTelegramMessage(chatId: number, text: string, token: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
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

interface AnalyzeResult {
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

async function formatTelegramResponse(result: AnalyzeResult, entryId: string): Promise<string> {
  const results = result.entry?.results || { songs: [], films: [], notes: [], links: [], tags: [], summary: null };
  const { songs, films, links } = results;
  const summaryRaw = (results as { summary?: string | null }).summary;
  const summary = summaryRaw ? truncateForTelegram(summaryRaw, 280) : null;
  const title = pickTitle(result, summary);

  const linksCount = links.length;
  const songsCount = songs.length;
  const filmsCount = films.length;
  const hasCounts = linksCount > 0 || songsCount > 0 || filmsCount > 0;

  try {
    const promptConfig = await getPrompt('telegramResponse');
    const response = renderTemplate(promptConfig.template, {
      title: escapeHtml(title),
      summary: summary ? escapeHtml(summary) : '',
      hasSummary: !!summary,
      linksCount, songsCount, filmsCount, hasCounts,
      frontendUrl: frontendUrl(entryId),
    });
    return response.replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    const safeTitle = escapeHtml(title);
    const lines = [`<b>${safeTitle}</b>`];
    if (summary) lines.push(escapeHtml(summary));
    lines.push('');
    if (hasCounts) lines.push(`🔗 ${linksCount} · 🎵 ${songsCount} · 🎬 ${filmsCount}`);
    lines.push(`🌐 <a href="${frontendUrl(entryId)}">Apri su SoundReel</a>`);
    return lines.join('\n');
  }
}

function pickTitle(result: AnalyzeResult, summary: string | null): string {
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

function truncateForTelegram(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
    const text = message.text?.trim() || '';

    try {
      if (text === '/start') {
        await sendTelegramMessage(
          chatId,
          'Ciao! Sono SoundReel Bot.\n\nInviami un link da Instagram, TikTok o qualsiasi post social e lo analizzo per estrarre canzoni e film!',
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

      const url = extractUrl(message);
      if (!url) {
        await sendTelegramMessage(
          chatId,
          'Inviami un link da Instagram, TikTok o qualsiasi post social e lo analizzo per te!',
          token
        );
        reply.code(200).send('OK');
        return;
      }

      if (isSpotifyUrl(url)) {
        reply.code(200).send('OK');
        (async () => {
          try {
            await sendToSpooty(url);
            const spootyFrontend = process.env.SPOOTY_FRONTEND_URL || 'https://spooty.casamon.dev';
            await sendTelegramMessage(
              chatId,
              `✅ Ho aggiunto il tuo link a Spooty!\n🎵 <a href="${url}">${url}</a>\n\n🌐 <a href="${spootyFrontend}">Apri Spooty</a>`,
              token
            );
          } catch (err) {
            log.error('Spooty add failed', err instanceof Error ? err : new Error(String(err)));
            await sendTelegramMessage(chatId, `❌ Errore Spooty: ${err instanceof Error ? err.message : String(err)}`, token);
          }
        })().catch(() => {});
        return;
      }

      // Respond webhook fast, process in background
      reply.code(200).send('OK');

      (async () => {
        try {
          const internalUrl = `http://127.0.0.1:${process.env.PORT || 8080}/api/analyze`;
          const analyzeResponse = await fetch(internalUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, channel: 'telegram' }),
          });
          if (!analyzeResponse.ok) {
            throw new Error(`analyze HTTP ${analyzeResponse.status}`);
          }
          const result = (await analyzeResponse.json()) as AnalyzeResult;
          if (!result.success || !result.entry) {
            throw new Error(result.error || 'Analisi fallita');
          }
          const response = await formatTelegramResponse(result, result.entryId || '');
          await sendTelegramMessage(chatId, response, token);
        } catch (err) {
          log.error('Pipeline analyze via telegram fallita', err instanceof Error ? err : new Error(String(err)));
          await sendTelegramMessage(chatId, `❌ Analisi fallita.\n🌐 <a href="${process.env.FRONTEND_URL || 'https://soundreel.casamon.dev'}">Apri SoundReel</a>`, token);
        }
      })().catch(() => {});

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
