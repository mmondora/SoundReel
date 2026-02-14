import { getPerplexityConfig } from '../utils/firestore';
import type { EnrichmentItem, EntryResults } from '../types';

interface PerplexityMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface PerplexityResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

function buildPrompt(results: EntryResults, caption: string | null): string {
  const items: string[] = [];

  for (const song of results.songs) {
    items.push(`- Canzone: "${song.title}" di ${song.artist}`);
  }
  for (const film of results.films) {
    items.push(`- Film: "${film.title}"${film.director ? ` di ${film.director}` : ''}${film.year ? ` (${film.year})` : ''}`);
  }
  for (const note of results.notes) {
    items.push(`- ${note.category}: ${note.text}`);
  }
  for (const tag of results.tags) {
    items.push(`- Tag: #${tag}`);
  }
  if (caption) {
    items.push(`- Caption del post: "${caption.slice(0, 500)}"`);
  }

  return `Dato il seguente contenuto estratto da un post social:

${items.join('\n')}

Per ogni elemento rilevante (canzone, film, prodotto, brand, luogo, persona, evento menzionato), trova link utili e verificati dal web.
Per le canzoni: link ufficiali (video musicale, lyrics, pagina artista).
Per i film: trailer, pagina Wikipedia o review.
Per prodotti/brand: sito ufficiale, pagina prodotto.
Per luoghi/eventi: sito ufficiale, mappa, info.
Per persone: profilo ufficiale, Wikipedia.

Rispondi SOLO con un JSON array valido, senza markdown, senza backtick, senza testo aggiuntivo.
Formato:
[
  {
    "label": "Nome dell'elemento",
    "links": [
      { "url": "https://...", "title": "Titolo del link", "snippet": "Breve descrizione" }
    ]
  }
]

Se non trovi nulla di rilevante, rispondi con un array vuoto: []`;
}

export async function enrichWithPerplexity(
  results: EntryResults,
  caption: string | null
): Promise<EnrichmentItem[]> {
  const config = await getPerplexityConfig();
  if (!config.apiKey) {
    throw new Error('Perplexity API key non configurata. Vai nelle Impostazioni per inserirla.');
  }
  const apiKey = config.apiKey;

  const messages: PerplexityMessage[] = [
    {
      role: 'system',
      content: 'Sei un assistente che trova link verificati dal web per arricchire contenuti estratti da post social. Rispondi sempre e solo in JSON valido.'
    },
    {
      role: 'user',
      content: buildPrompt(results, caption)
    }
  ];

  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'sonar',
      messages,
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Perplexity API error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as PerplexityResponse;
  const content = data.choices?.[0]?.message?.content;

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
