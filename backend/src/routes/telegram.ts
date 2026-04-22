import type { FastifyInstance } from 'fastify';
import { detectPlatform } from '../services/contentExtractor';
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
    results: {
      songs: Array<{ title: string; artist: string; album: string | null; addedToPlaylist: boolean }>;
      films: Array<{ title: string; year: string | null; director: string | null }>;
      notes: Array<{ text: string; category: string }>;
      links: Array<{ url: string; label: string | null }>;
      tags: string[];
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
  const results = result.entry?.results || { songs: [], films: [], notes: [], links: [], tags: [] };
  const { songs, films, notes, links, tags } = results;
  const rawTranscript = (results as { transcript?: string | null }).transcript;
  const transcript = rawTranscript
    ? rawTranscript.length > 500 ? rawTranscript.substring(0, 500) + '...' : rawTranscript
    : null;

  try {
    const promptConfig = await getPrompt('telegramResponse');
    const response = renderTemplate(promptConfig.template, {
      songs, films, notes, links, tags,
      hasSongs: songs.length > 0,
      hasFilms: films.length > 0,
      hasNotes: notes.length > 0,
      hasLinks: links.length > 0,
      hasTags: tags.length > 0,
      hasTranscript: !!transcript,
      transcript,
      frontendUrl: frontendUrl(entryId),
    });
    return response.replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    let response = '🎵 <b>SoundReel ha analizzato il tuo link!</b>\n\n';
    if (songs.length > 0) {
      response += '🎶 <b>Canzoni trovate:</b>\n';
      for (const song of songs) {
        const albumPart = song.album ? ` (${song.album})` : '';
        const playlistPart = song.addedToPlaylist ? ' ✓' : '';
        response += `• ${song.title} — ${song.artist}${albumPart}${playlistPart}\n`;
      }
      response += '\n';
    }
    if (films.length > 0) {
      response += '🎬 <b>Film trovati:</b>\n';
      for (const film of films) {
        const yearPart = film.year ? ` (${film.year})` : '';
        const directorPart = film.director ? ` — ${film.director}` : '';
        response += `• ${film.title}${yearPart}${directorPart}\n`;
      }
    }
    if (songs.length === 0 && films.length === 0) {
      response = 'Ho analizzato il link ma non ho trovato canzoni o film. 🤷\n\n';
    }
    response += `\n🌐 <a href="${frontendUrl(entryId)}">Vedi su SoundReel</a>`;
    return response;
  }
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

      const platform = detectPlatform(url);
      const platformLabels: Record<string, string> = {
        instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube',
        facebook: 'Facebook', twitter: 'X/Twitter', threads: 'Threads',
        spotify: 'Spotify', reddit: 'Reddit', linkedin: 'LinkedIn',
        pinterest: 'Pinterest', vimeo: 'Vimeo', twitch: 'Twitch',
        snapchat: 'Snapchat', soundcloud: 'SoundCloud', other: 'Web',
      };
      const platformLabel = platformLabels[platform] || platform;

      await sendTelegramMessage(chatId, `✅ Ricevuto! Link da <b>${platformLabel}</b>\n🔗 ${url}\n\n⏳ Analisi in corso...`, token);

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
          await sendTelegramMessage(chatId, '❌ Si è verificato un errore durante l\'analisi. Riprova più tardi.', token);
        }
      })().catch(() => {});

      await countEntries().catch(() => 0);
      return;
    } catch (error) {
      log.error('Webhook fallito', error instanceof Error ? error : new Error(String(error)));
      try {
        await sendTelegramMessage(chatId, '❌ Si è verificato un errore durante l\'analisi. Riprova più tardi.', token);
      } catch {}
      reply.code(200).send('OK');
      return;
    }
  });
}
