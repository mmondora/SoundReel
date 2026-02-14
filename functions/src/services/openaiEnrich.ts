import { getOpenAIConfig } from '../utils/firestore';
import { getPrompt, renderTemplate } from './promptLoader';
import type { EnrichmentItem, EntryResults } from '../types';

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

async function buildPrompt(results: EntryResults, caption: string | null): Promise<string> {
  const promptConfig = await getPrompt('enrichment');
  return renderTemplate(promptConfig.template, {
    songs: results.songs,
    films: results.films,
    notes: results.notes,
    tags: results.tags,
    caption: caption ? caption.slice(0, 500) : null
  });
}

export async function enrichWithOpenAI(
  results: EntryResults,
  caption: string | null
): Promise<EnrichmentItem[]> {
  const config = await getOpenAIConfig();
  if (!config.apiKey) {
    throw new Error('OpenAI API key non configurata. Vai nelle Impostazioni per inserirla.');
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      tools: [{ type: 'web_search_preview' }],
      input: await buildPrompt(results, caption),
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as OpenAIResponse;

  // Extract text from the response output
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
    return [];
  }

  // Parse JSON from response, handling possible markdown wrapping
  let jsonStr = content.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const parsed = JSON.parse(jsonStr);

  if (!Array.isArray(parsed)) {
    return [];
  }

  // Validate and filter the response
  return parsed
    .filter((item: Record<string, unknown>) =>
      typeof item.label === 'string' &&
      Array.isArray(item.links)
    )
    .map((item: Record<string, unknown>) => ({
      label: item.label as string,
      links: (item.links as Array<Record<string, unknown>>)
        .filter((link) =>
          typeof link.url === 'string' &&
          typeof link.title === 'string'
        )
        .map((link) => ({
          url: link.url as string,
          title: link.title as string,
          snippet: (link.snippet as string) || ''
        }))
    }))
    .filter((item: EnrichmentItem) => item.links.length > 0);
}
