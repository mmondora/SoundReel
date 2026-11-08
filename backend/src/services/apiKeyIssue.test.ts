import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyMeta } from '../utils/db';

const state = vi.hoisted(() => ({
  cfg: { keys: [] as string[], meta: {} as Record<string, unknown> },
}));

vi.mock('../utils/db', () => ({
  getApiKeysConfig: vi.fn(async () => ({ keys: [...state.cfg.keys], meta: { ...state.cfg.meta } })),
  updateApiKeysConfig: vi.fn(async (u: { keys?: string[]; meta?: Record<string, unknown> }) => {
    state.cfg = { ...state.cfg, ...u } as typeof state.cfg;
  }),
}));

import {
  issueUserApiKey,
  normalizeDeviceLabel,
  guessDeviceLabel,
  MAX_KEYS_PER_USER,
} from './apiKeyIssue';
import { apiKeyId, authenticateApiKey } from '../utils/apiKeyAuth';

function metaOf(key: string): ApiKeyMeta | undefined {
  return state.cfg.meta[apiKeyId(key)] as ApiKeyMeta | undefined;
}

describe('issueUserApiKey', () => {
  beforeEach(() => {
    state.cfg = { keys: [], meta: {} };
  });

  it('issues an sr_ key bound to user + device', async () => {
    const out = await issueUserApiKey('mike', 'iPhone di Michele');
    expect(out.key).toMatch(/^sr_[A-Za-z0-9_-]{32}$/);
    expect(out.replaced).toBe(false);
    expect(state.cfg.keys).toEqual([out.key]);
    expect(metaOf(out.key)).toMatchObject({ user: 'mike', device: 'iPhone di Michele' });
    await expect(authenticateApiKey(out.key)).resolves.toEqual({
      owner: { user: 'mike', device: 'iPhone di Michele' },
    });
  });

  it('does not store the raw key inside meta', async () => {
    const out = await issueUserApiKey('mike', 'iPhone');
    expect(JSON.stringify(state.cfg.meta)).not.toContain(out.key);
  });

  it('rotating the same user + device revokes the previous key', async () => {
    const first = await issueUserApiKey('mike', 'iPhone');
    const second = await issueUserApiKey('mike', 'iphone'); // label match is case-insensitive
    expect(second.replaced).toBe(true);
    expect(second.key).not.toBe(first.key);
    expect(state.cfg.keys).toEqual([second.key]);
    expect(metaOf(first.key)).toBeUndefined();
    await expect(authenticateApiKey(first.key)).resolves.toBeNull();
  });

  it('keeps other devices and other users untouched', async () => {
    const mikePhone = await issueUserApiKey('mike', 'iPhone');
    const mikeMac = await issueUserApiKey('mike', 'Mac');
    const saraPhone = await issueUserApiKey('sara', 'iPhone');
    const mikePhoneAgain = await issueUserApiKey('mike', 'iPhone');
    expect([...state.cfg.keys].sort()).toEqual(
      [mikeMac.key, saraPhone.key, mikePhoneAgain.key].sort(),
    );
    expect(metaOf(mikePhone.key)).toBeUndefined();
    expect(metaOf(saraPhone.key)).toMatchObject({ user: 'sara' });
  });

  it('leaves legacy (unbound) keys alone', async () => {
    state.cfg = { keys: ['sr_legacy_key_1234567890'], meta: {} };
    const out = await issueUserApiKey('mike', 'iPhone');
    expect(state.cfg.keys).toEqual(['sr_legacy_key_1234567890', out.key]);
    await expect(authenticateApiKey('sr_legacy_key_1234567890')).resolves.toEqual({ owner: null });
  });

  it(`revokes the user's oldest keys beyond ${MAX_KEYS_PER_USER}`, async () => {
    const issued: string[] = [];
    for (let i = 0; i < MAX_KEYS_PER_USER + 2; i += 1) {
      issued.push((await issueUserApiKey('mike', `dev-${i}`)).key);
    }
    expect(state.cfg.keys).toHaveLength(MAX_KEYS_PER_USER);
    expect(state.cfg.keys).not.toContain(issued[0]);
    expect(state.cfg.keys).not.toContain(issued[1]);
    expect(state.cfg.keys).toContain(issued[issued.length - 1]);
  });

  it('serializes concurrent issuers (no lost update)', async () => {
    const out = await Promise.all(['a', 'b', 'c', 'd'].map((d) => issueUserApiKey('archi', d)));
    expect([...state.cfg.keys].sort()).toEqual(out.map((o) => o.key).sort());
  });
});

describe('device labels', () => {
  it('normalizes user input', () => {
    expect(normalizeDeviceLabel('  iPhone   di\tMichele ')).toBe('iPhone di Michele');
    expect(normalizeDeviceLabel('x'.repeat(100))).toHaveLength(60);
    expect(normalizeDeviceLabel('', 'Mac')).toBe('Mac');
    expect(normalizeDeviceLabel(42)).toBe('device');
    expect(normalizeDeviceLabel('a\u0000b\nc')).toBe('a b c');
  });

  it('guesses a label from the user agent', () => {
    expect(guessDeviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
    expect(guessDeviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Mac');
    expect(guessDeviceLabel(undefined)).toBe('browser');
  });
});
