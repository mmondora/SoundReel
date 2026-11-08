import { describe, expect, it } from 'vitest';
import { parseApiError } from './apiError';

describe('parseApiError', () => {
  it('reads the server’s error code and the index of the entry at fault', () => {
    expect(parseApiError(new Error('{"error":"folder_missing","index":2}'))).toMatchObject({ code: 'folder_missing', index: 2, status: null });
  });

  it('a code without an index has no index', () => {
    expect(parseApiError(new Error('{"error":"query_too_short"}'))).toMatchObject({ code: 'query_too_short', index: null });
  });

  it('a bare HTTP status keeps the status and has no code', () => {
    expect(parseApiError(new Error('HTTP 403'))).toMatchObject({ code: null, status: 403 });
    expect(parseApiError(new Error('HTTP 500'))).toMatchObject({ status: 500 });
  });

  it('a fetch that never reached the server is "network"', () => {
    expect(parseApiError(new TypeError('Failed to fetch')).code).toBe('network');
    expect(parseApiError(new Error('NetworkError when attempting to fetch resource')).code).toBe('network');
  });

  it('survives anything else: HTML error pages, plain text, non-errors, JSON that is not an object', () => {
    expect(parseApiError(new Error('<html>502 Bad Gateway</html>'))).toMatchObject({ code: null, index: null, status: null });
    expect(parseApiError('boom')).toMatchObject({ code: null, message: 'boom' });
    expect(parseApiError(new Error('[1,2]'))).toMatchObject({ code: null });
    expect(parseApiError(new Error('{"error":42,"index":"x"}'))).toMatchObject({ code: null, index: null });
    expect(parseApiError(undefined).code).toBeNull();
  });

  it('shortens a long message', () => {
    expect(parseApiError(new Error('x'.repeat(500))).message).toHaveLength(200);
  });
});
