#!/usr/bin/env node
/**
 * SoundReel MCP server (stdio).
 * Calls the running Fastify API — no second database.
 *
 *   SOUNDREEL_URL=http://127.0.0.1:8081 npx tsx src/mcp/server.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createSoundreelClient, SoundreelHttpError } from './client';

const BASE_URL = (process.env.SOUNDREEL_URL || 'http://127.0.0.1:8081').replace(/\/$/, '');

const client = createSoundreelClient({ baseUrl: BASE_URL });

const server = new McpServer({
  name: 'soundreel',
  version: '0.1.0',
});

function asJson(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function asError(err: unknown) {
  if (err instanceof SoundreelHttpError) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: err.message, status: err.status, body: err.body }, null, 2),
      }],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

server.tool(
  'soundreel_list_recent',
  'List recent SoundReel journal entries (lean summary: id, url, platform, summary, counts, tags).',
  {
    limit: z.number().int().min(1).max(100).optional().describe('Max entries (default 20)'),
  },
  async ({ limit }) => {
    try {
      return asJson(await client.listRecent(limit ?? 20));
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  'soundreel_get_entry',
  'Get a full SoundReel entry by id (results, actionLog, media fields).',
  {
    id: z.string().min(1).describe('Entry UUID'),
  },
  async ({ id }) => {
    try {
      return asJson(await client.getEntry(id));
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  'soundreel_search',
  'Full-text search across SoundReel entries (caption, summary, tags, etc.).',
  {
    q: z.string().min(2).describe('Search query (min 2 chars)'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20)'),
  },
  async ({ q, limit }) => {
    try {
      return asJson(await client.search(q, limit ?? 20));
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  'soundreel_stats',
  'Journal totals: entries, songs, films, notes, software.',
  {},
  async () => {
    try {
      return asJson(await client.stats());
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  'soundreel_analyze_url',
  'Enqueue/run analysis for a URL (same pipeline as web/Telegram). Can take up to ~120s. channel defaults to "mcp".',
  {
    url: z.string().url().describe('Instagram / TikTok / YouTube / web URL'),
    user: z.string().optional().describe('Optional input user label'),
  },
  async ({ url, user }) => {
    try {
      return asJson(await client.analyzeUrl(url, { user }));
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  'soundreel_health',
  'Ping SoundReel backend /health.',
  {},
  async () => {
    try {
      return asJson({ ...(await client.health()), baseUrl: BASE_URL });
    } catch (err) {
      return asError(err);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('soundreel-mcp failed', err);
  process.exit(1);
});
