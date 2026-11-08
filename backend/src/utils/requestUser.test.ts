import { describe, expect, it } from 'vitest';
import {
  normalizeFamilyUser,
  isFamilyUser,
  FAMILY_DISPLAY,
  matchFamilyName,
  normalizeAppUser,
  ANONYMOUS_USER,
  remoteGroupsFromRequest,
  resolveUser,
} from './requestUser';
import type { FastifyRequest } from 'fastify';

function fakeReq(headers: Record<string, string>): FastifyRequest {
  return { headers } as FastifyRequest;
}

describe('requestUser', () => {
  it('normalizes Authelia ids', () => {
    expect(normalizeFamilyUser('Mike')).toBe('mike');
    expect(normalizeFamilyUser(' archi ')).toBe('archi');
    expect(normalizeFamilyUser('sara')).toBe('sara');
    expect(normalizeFamilyUser('guest')).toBeNull();
    expect(normalizeFamilyUser(null)).toBeNull();
    expect(normalizeAppUser('Anonymous')).toBe(ANONYMOUS_USER);
  });

  it('knows family users', () => {
    expect(isFamilyUser('mike')).toBe(true);
    expect(isFamilyUser('nope')).toBe(false);
    expect(FAMILY_DISPLAY.mike).toBe('Michele');
  });

  it('matches proper names without requiring Authelia ids', () => {
    expect(matchFamilyName('Michele')).toBe('mike');
    expect(matchFamilyName('  michele mondora ')).toBe('mike');
    expect(matchFamilyName('Archimede')).toBe('archi');
    expect(matchFamilyName('Sara Spini')).toBe('sara');
    expect(matchFamilyName('unknown person')).toBeNull();
  });

  it('parses Remote-Groups CSV', () => {
    expect(remoteGroupsFromRequest(fakeReq({ 'remote-groups': 'family,admins' }))).toEqual([
      'family',
      'admins',
    ]);
    expect(remoteGroupsFromRequest(fakeReq({}))).toEqual([]);
  });

  it('resolves Remote-User or anonymous', () => {
    const mike = resolveUser(fakeReq({ 'remote-user': 'mike', 'remote-groups': 'family,admins' }));
    expect(mike).toEqual({
      id: 'mike',
      displayName: 'Michele',
      isAdmin: true,
      authenticated: true,
    });

    const anon = resolveUser(fakeReq({}));
    expect(anon).toEqual({
      id: ANONYMOUS_USER,
      displayName: 'Anonymous',
      isAdmin: false,
      authenticated: false,
    });
  });
});
