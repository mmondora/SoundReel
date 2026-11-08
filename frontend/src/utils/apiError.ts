/**
 * What went wrong with an API call, read from the error the api functions throw: `json()` keeps the server's body
 * in the message, so `{"error":"folder_missing","index":0}` and a bare "HTTP 403" both come back here.
 */
export interface ApiErrorInfo {
  /** The server's machine-readable `error` (e.g. `query_too_short`, `folder_outside_roots`), or `network`. */
  code: string | null;
  /** For list errors: which entry of the submitted list is at fault (-1 = the list as a whole). */
  index: number | null;
  /** HTTP status when the message is a bare "HTTP nnn". */
  status: number | null;
  /** The raw message, shortened. */
  message: string;
}

export function parseApiError(err: unknown): ApiErrorInfo {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.slice(0, 200);
  const bare = /^HTTP (\d{3})\b/.exec(raw.trim());
  if (bare) return { code: null, index: null, status: Number(bare[1]), message };
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const { error, index } = body as { error?: unknown; index?: unknown };
      return {
        code: typeof error === 'string' && error !== '' ? error : null,
        index: typeof index === 'number' && Number.isInteger(index) ? index : null,
        status: null,
        message,
      };
    }
  } catch {
    // not JSON: a network failure, an HTML error page, plain text
  }
  const network = err instanceof TypeError || /failed to fetch|network|load failed/i.test(raw);
  return { code: network ? 'network' : null, index: null, status: null, message };
}
