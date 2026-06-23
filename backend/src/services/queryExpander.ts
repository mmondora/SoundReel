import { generateText } from './ollamaClient';
import { logWarning } from '../utils/logger';

const EXPAND_TIMEOUT_MS = 5_000;

async function doExpand(q: string): Promise<string[]> {
  const prompt = `Return a JSON array of up to 10 search terms related to: "${q}"
Include synonyms and related concepts in both Italian and English.
Output only the JSON array, no explanation, no markdown.
Example output: ["GPU", "home server", "NVIDIA", "inferenza locale", "edge AI"]`;

  const { text } = await generateText(prompt);
  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) return [];

  const parsed = JSON.parse(match[0]) as unknown[];
  return parsed
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .slice(0, 10);
}

export async function expandQuery(q: string): Promise<string[]> {
  const timeout = new Promise<string[]>((resolve) =>
    setTimeout(() => resolve([]), EXPAND_TIMEOUT_MS)
  );

  try {
    return await Promise.race([doExpand(q), timeout]);
  } catch (err) {
    logWarning('Query expansion failed, using original query only', { err: String(err) });
    return [];
  }
}
