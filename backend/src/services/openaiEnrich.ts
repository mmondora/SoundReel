import { getOpenAIConfig } from '../utils/db';
import { getPrompt, renderTemplate } from './promptLoader';
import { logWarning } from '../utils/logger';
import type {
  EnrichmentResult,
  EnrichmentItem,
  EnrichmentVerdict,
  EnrichmentVerdictLabel,
  EntryResults,
} from '../types';

interface OpenAIResponseOutput {
  type: string;
  content?: Array<{
    type: string;
    text?: string;
  }>;
}

interface OpenAIResponse {
  output: OpenAIResponseOutput[];
}

const VALID_CATEGORIES: readonly string[] = ['tech', 'security', 'claim', 'generic'];
const VALID_VERDICT_LABELS: readonly EnrichmentVerdictLabel[] = [
  'vero', 'falso', 'dubbio', 'ai-generated', 'phishing', 'sicuro', 'sospetto',
];

const FALLBACK_RESULT: EnrichmentResult = { category: 'generic', items: [] };

async function buildPrompt(results: EntryResults, caption: string | null): Promise<string> {
  const promptConfig = await getPrompt('enrichment');
  return renderTemplate(promptConfig.template, {
    songs: results.songs,
    films: results.films,
    notes: results.notes,
    tags: results.tags,
    links: results.links,
    caption: caption ? caption.slice(0, 500) : null,
  });
}

function parseVerdict(raw: unknown): EnrichmentVerdict | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.label !== 'string' || !VALID_VERDICT_LABELS.includes(v.label as EnrichmentVerdictLabel)) return undefined;
  if (typeof v.explanation !== 'string') return undefined;
  const confidence = typeof v.confidence === 'number' && Number.isFinite(v.confidence)
    ? Math.min(100, Math.max(0, v.confidence))
    : 0;
  return { label: v.label as EnrichmentVerdictLabel, confidence, explanation: v.explanation };
}

function parseItems(raw: unknown): EnrichmentItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      !!item && typeof item === 'object' &&
      typeof (item as Record<string, unknown>).label === 'string' &&
      Array.isArray((item as Record<string, unknown>).links)
    )
    .map((item) => ({
      label: item.label as string,
      explanation: typeof item.explanation === 'string' ? item.explanation : '',
      links: (item.links as Array<Record<string, unknown>>)
        .filter((link) => typeof link.url === 'string' && typeof link.title === 'string')
        .map((link) => ({
          url: link.url as string,
          title: link.title as string,
          snippet: (link.snippet as string) || '',
        })),
    }))
    .filter((item) => item.links.length > 0);
}

function parseEnrichmentResponse(content: string): EnrichmentResult {
  let jsonStr = content.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (error) {
    logWarning('enrichWithOpenAI: JSON parse fallito', { error: String(error), raw: jsonStr.slice(0, 200) });
    return FALLBACK_RESULT;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logWarning('enrichWithOpenAI: risposta non è un JSON object', { raw: jsonStr.slice(0, 200) });
    return FALLBACK_RESULT;
  }

  const obj = parsed as Record<string, unknown>;
  const category: EnrichmentResult['category'] =
    typeof obj.category === 'string' && VALID_CATEGORIES.includes(obj.category)
      ? (obj.category as EnrichmentResult['category'])
      : 'generic';

  const result: EnrichmentResult = { category, items: parseItems(obj.items) };
  if (category === 'security' || category === 'claim') {
    const verdict = parseVerdict(obj.verdict);
    if (verdict) result.verdict = verdict;
  }
  return result;
}

export async function enrichWithOpenAI(
  results: EntryResults,
  caption: string | null
): Promise<EnrichmentResult> {
  const config = await getOpenAIConfig();
  if (!config.apiKey) {
    throw new Error('OpenAI API key non configurata. Vai nelle Impostazioni per inserirla.');
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      tools: [{ type: 'web_search_preview' }],
      input: await buildPrompt(results, caption),
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as OpenAIResponse;

  let content = '';
  for (const output of data.output) {
    if (output.type === 'message' && output.content) {
      for (const block of output.content) {
        if (block.type === 'output_text' && block.text) {
          content += block.text;
        }
      }
    }
  }

  if (!content) {
    return FALLBACK_RESULT;
  }

  return parseEnrichmentResponse(content);
}
