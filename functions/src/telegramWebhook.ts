import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { db } from './utils/firestore';
import { detectPlatform } from './services/contentExtractor';
import { getPrompt, renderTemplate } from './services/promptLoader';
import { Logger } from './services/debugLogger';

const telegramBotToken = defineSecret('TELEGRAM_BOT_TOKEN');
const telegramWebhookSecret = defineSecret('TELEGRAM_WEBHOOK_SECRET');

interface TelegramMessage {
  message_id: number;
  from?: {
    username?: string;
    first_name?: string;
  };
  chat: {
    id: number;
  };
  text?: string;
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
  }>;
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
      disable_web_page_preview: true
    })
  });
}

async function getStats(): Promise<{ entries: number; songs: number; films: number }> {
  const snapshot = await db.collection('entries').get();
  let songs = 0;
  let films = 0;

  snapshot.forEach(doc => {
    const data = doc.data();
    songs += data.results?.songs?.length || 0;
    films += data.results?.films?.length || 0;
  });

  return { entries: snapshot.size, songs, films };
}

async function getLastEntry(): Promise<string> {
  const snapshot = await db.collection('entries')
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  if (snapshot.empty) {
    return 'Nessuna entry ancora processata.';
  }

  const data = snapshot.docs[0].data();
  const songs = data.results?.songs?.length || 0;
  const films = data.results?.films?.length || 0;

  return `Ultima entry:\n${data.sourceUrl}\n${songs} canzoni, ${films} film`;
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
    };
  };
  error?: string;
}

async function formatTelegramResponse(result: AnalyzeResult, entryId: string): Promise<string> {
  const results = result.entry?.results || { songs: [], films: [], notes: [], links: [], tags: [] };
  const { songs, films, notes, links, tags } = results;
  const rawTranscript = (results as Record<string, unknown>).transcript as string | null | undefined;
  const transcript = rawTranscript
    ? (rawTranscript.length > 500 ? rawTranscript.substring(0, 500) + '...' : rawTranscript)
    : null;

  try {
    const promptConfig = await getPrompt('telegramResponse');
    const response = renderTemplate(promptConfig.template, {
      songs,
      films,
      notes,
      links,
      tags,
      hasSongs: songs.length > 0,
      hasFilms: films.length > 0,
      hasNotes: notes.length > 0,
      hasLinks: links.length > 0,
      hasTags: tags.length > 0,
      hasTranscript: !!transcript,
      transcript,
      frontendUrl: `https://soundreel-776c1.web.app/#${entryId}`
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
      response = 'Ho analizzato il link ma non ho trovato canzoni o film. 🤷';
    }

    return response;
  }
}

export const telegramWebhook = onRequest(
  {
    region: 'europe-west1',
    secrets: [telegramBotToken, telegramWebhookSecret]
  },
  async (req, res) => {
    const log = new Logger('telegramWebhook');
    log.startTimer();

    if (req.method !== 'POST') {
      log.warn('Metodo non consentito', { method: req.method });
      res.status(405).send('Metodo non consentito');
      return;
    }

    // Verifica secret
    const secretHeader = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;
    const expectedSecret = telegramWebhookSecret.value();

    if (expectedSecret && secretHeader !== expectedSecret) {
      log.warn('Secret non valido', {
        received: secretHeader ? 'present' : 'missing'
      });
    }

    const update = req.body as TelegramUpdate;
    const message = update.message;

    if (!message) {
      log.debug('Update senza messaggio', { updateId: update.update_id });
      res.status(200).send('OK');
      return;
    }

    const chatId = message.chat.id;
    const token = telegramBotToken.value();
    const text = message.text?.trim() || '';
    const username = message.from?.username || message.from?.first_name || 'unknown';

    log.info('Messaggio ricevuto', {
      chatId,
      username,
      messageId: message.message_id,
      textPreview: text.substring(0, 100)
    });

    try {
      // Comandi
      if (text === '/start') {
        log.debug('Comando /start');
        await sendTelegramMessage(
          chatId,
          'Ciao! Sono SoundReel Bot.\n\nInviami un link da Instagram, TikTok o qualsiasi post social e lo analizzo per estrarre canzoni e film!',
          token
        );
        res.status(200).send('OK');
        return;
      }

      if (text === '/stats') {
        log.debug('Comando /stats');
        const stats = await getStats();
        await sendTelegramMessage(
          chatId,
          `📊 <b>Statistiche SoundReel</b>\n\n📋 Entry: ${stats.entries}\n🎵 Canzoni: ${stats.songs}\n🎬 Film: ${stats.films}`,
          token
        );
        res.status(200).send('OK');
        return;
      }

      if (text === '/status') {
        log.debug('Comando /status');
        const lastEntry = await getLastEntry();
        await sendTelegramMessage(chatId, lastEntry, token);
        res.status(200).send('OK');
        return;
      }

      // Estrai URL
      const url = extractUrl(message);
      if (!url) {
        log.debug('Nessun URL nel messaggio');
        await sendTelegramMessage(
          chatId,
          'Inviami un link da Instagram, TikTok o qualsiasi post social e lo analizzo per te!',
          token
        );
        res.status(200).send('OK');
        return;
      }

      const platform = detectPlatform(url);
      const platformNames: Record<string, string> = {
        instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube',
        facebook: 'Facebook', twitter: 'X/Twitter', threads: 'Threads',
        spotify: 'Spotify', reddit: 'Reddit', linkedin: 'LinkedIn',
        pinterest: 'Pinterest', vimeo: 'Vimeo', twitch: 'Twitch',
        snapchat: 'Snapchat', soundcloud: 'SoundCloud', other: 'Web'
      };
      const platformLabel = platformNames[platform] || platform;

      log.info('URL estratto', { url, platform });
      await sendTelegramMessage(chatId, `✅ Ricevuto! Link da <b>${platformLabel}</b>\n🔗 ${url}\n\n⏳ Analisi in corso...`, token);

      // Chiama la pipeline di analisi
      const functionsUrl = `https://europe-west1-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/analyzeUrl`;
      log.debug('Chiamata analyzeUrl', { functionsUrl });

      const analyzeResponse = await fetch(functionsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, channel: 'telegram' })
      });

      if (!analyzeResponse.ok) {
        const errorText = await analyzeResponse.text();
        log.error('Errore da analyzeUrl', new Error(errorText), {
          status: analyzeResponse.status
        });
        throw new Error('Errore durante l\'analisi');
      }

      const result = await analyzeResponse.json() as AnalyzeResult;

      if (!result.success || !result.entry) {
        log.error('Analisi fallita', new Error(result.error || 'Unknown error'));
        throw new Error(result.error || 'Analisi fallita');
      }

      log.setEntryId(result.entryId || '');
      log.info('Analisi completata', {
        songs: result.entry.results.songs.length,
        films: result.entry.results.films.length
      });

      const response = await formatTelegramResponse(result, result.entryId || '');
      await sendTelegramMessage(chatId, response, token);

      log.info('Risposta inviata', { chatId });
      res.status(200).send('OK');
    } catch (error) {
      log.error('Webhook fallito', error instanceof Error ? error : new Error(String(error)));
      await sendTelegramMessage(
        chatId,
        '❌ Si è verificato un errore durante l\'analisi. Riprova più tardi.',
        token
      );
      res.status(200).send('OK');
    }
  }
);
