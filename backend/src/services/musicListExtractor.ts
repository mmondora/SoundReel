import { generateText } from './ollamaClient';
import { extractPage } from './pageExtractor';
import { logInfo, logWarning, logError } from '../utils/logger';

export interface ExtractedSong {
  title: string;
  artist: string;
}

export async function detectMusicList(text: string): Promise<boolean> {
  const excerpt = text.slice(0, 2000);
  const prompt = `Is the following text a music list, ranking, chart, album collection, or playlist? Answer only "yes" or "no".\n\n${excerpt}`;
  try {
    const res = await generateText(prompt);
    return res.text.trim().toLowerCase().startsWith('yes');
  } catch (err) {
    logWarning('detectMusicList failed', { err: String(err) });
    return false;
  }
}

export async function extractSongsFromText(text: string): Promise<ExtractedSong[]> {
  const excerpt = text.slice(0, 4000);
  const prompt = `Extract all songs and albums from the following text. Return a JSON array of objects with "title" and "artist" string fields. Return only the JSON array, no other text.\n\n${excerpt}`;
  try {
    const res = await generateText(prompt);
    const match = res.text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as unknown[];
    return (parsed as Array<{ title?: unknown; artist?: unknown }>)
      .filter((s) => typeof s.title === 'string' && s.title.trim() && typeof s.artist === 'string' && s.artist.trim())
      .map((s) => ({ title: (s.title as string).trim(), artist: (s.artist as string).trim() }));
  } catch (err) {
    logWarning('extractSongsFromText failed', { err: String(err) });
    return [];
  }
}

export async function extractSongsFromMainText(mainText: string): Promise<ExtractedSong[]> {
  try {
    const isMusicList = await detectMusicList(mainText);
    if (!isMusicList) {
      logInfo('extractSongsFromMainText: not a music list');
      return [];
    }
    const songs = await extractSongsFromText(mainText);
    logInfo('extractSongsFromMainText: extracted songs', { count: songs.length });
    return songs;
  } catch (err) {
    logError('extractSongsFromMainText failed', { err: String(err) });
    return [];
  }
}

export async function extractSongsFromUrl(url: string): Promise<ExtractedSong[]> {
  try {
    const page = await extractPage(url);
    if (!page.mainText) {
      logInfo('extractSongsFromUrl: no mainText', { url });
      return [];
    }
    const isMusicList = await detectMusicList(page.mainText);
    if (!isMusicList) {
      logInfo('extractSongsFromUrl: not a music list', { url });
      return [];
    }
    const songs = await extractSongsFromText(page.mainText);
    logInfo('extractSongsFromUrl: extracted songs', { url, count: songs.length });
    return songs;
  } catch (err) {
    logError('extractSongsFromUrl failed', { url, err: String(err) });
    return [];
  }
}
