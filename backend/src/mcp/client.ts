/**
 * Thin HTTP client for SoundReel Fastify API (used by the MCP stdio server).
 */

export type SoundreelClientOptions = {
  baseUrl: string;
  /** Analyze can run up to the pipeline timeout (120s). */
  analyzeTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class SoundreelHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'SoundreelHttpError';
  }
}

export function createSoundreelClient(opts: SoundreelClientOptions) {
  const base = opts.baseUrl.replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const analyzeTimeoutMs = opts.analyzeTimeoutMs ?? 120_000;

  async function request<T>(
    method: string,
    path: string,
    init?: { query?: Record<string, string | number | undefined>; body?: unknown; timeoutMs?: number },
  ): Promise<T> {
    const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
    if (init?.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v === undefined || v === '') continue;
        url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: string | undefined;
    if (init?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const signal = AbortSignal.timeout(init?.timeoutMs ?? 30_000);
    const res = await fetchImpl(url, { method, headers, body, signal });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      throw new SoundreelHttpError(
        `SoundReel ${method} ${path} → ${res.status}`,
        res.status,
        parsed,
      );
    }
    return parsed as T;
  }

  return {
    baseUrl: base,

    listRecent(limit = 20) {
      return request<{
        entries: unknown[];
        total: number;
        limit: number;
        offset: number;
      }>('GET', 'api/entries', {
        query: { view: 'summary', limit, offset: 0 },
      });
    },

    getEntry(id: string) {
      return request<unknown>('GET', `api/entries/${encodeURIComponent(id)}`);
    },

    search(q: string, limit = 20) {
      return request<{
        results: unknown[];
        expandedTerms: string[];
        total: number;
      }>('GET', 'api/search', { query: { q, limit } });
    },

    stats() {
      return request<unknown>('GET', 'api/stats');
    },

    analyzeUrl(url: string, opts?: { channel?: string; user?: string }) {
      return request<unknown>('POST', 'api/analyze', {
        body: {
          url,
          channel: opts?.channel ?? 'mcp',
          user: opts?.user ?? null,
        },
        timeoutMs: analyzeTimeoutMs,
      });
    },

    health() {
      return request<{ ok: boolean }>('GET', 'health');
    },
  };
}

export type SoundreelClient = ReturnType<typeof createSoundreelClient>;
