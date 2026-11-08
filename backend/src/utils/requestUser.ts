/**
 * Resolve the Authelia user for a request.
 * Web traffic: Traefik injects `Remote-User` / `Remote-Groups`.
 * Missing identity → `anonymous` (admins can browse anonymous-owned data).
 * Share/Telegram: callers pass an explicit owner (not via this helper).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export const FAMILY_USERS = ['mike', 'archi', 'sara'] as const;
export type FamilyUserId = (typeof FAMILY_USERS)[number];

export const ANONYMOUS_USER = 'anonymous' as const;
export type AppUserId = FamilyUserId | typeof ANONYMOUS_USER;

export const FAMILY_DISPLAY: Record<FamilyUserId, string> = {
  mike: 'Michele',
  archi: 'Archimede',
  sara: 'Sara',
};

/** Names accepted when claiming identity (Telegram). Never list these in prompts. */
const NAME_ALIASES: Array<{ id: FamilyUserId; aliases: string[] }> = [
  { id: 'mike', aliases: ['michele', 'michele mondora', 'mike', 'mike mondora'] },
  { id: 'archi', aliases: ['archimede', 'archi'] },
  { id: 'sara', aliases: ['sara', 'sara spini'] },
];

export function normalizeFamilyUser(raw: string | null | undefined): FamilyUserId | null {
  if (!raw) return null;
  const id = raw.trim().toLowerCase();
  return (FAMILY_USERS as readonly string[]).includes(id) ? (id as FamilyUserId) : null;
}

export function normalizeAppUser(raw: string | null | undefined): AppUserId | null {
  if (!raw) return null;
  const id = raw.trim().toLowerCase();
  if (id === ANONYMOUS_USER) return ANONYMOUS_USER;
  return normalizeFamilyUser(id);
}

/** Match a claimed proper name to a family Authelia id. */
export function matchFamilyName(claimed: string | null | undefined): FamilyUserId | null {
  if (!claimed) return null;
  const norm = claimed.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!norm) return null;
  for (const row of NAME_ALIASES) {
    if (row.aliases.includes(norm)) return row.id;
  }
  return null;
}

/** Read Authelia username from Traefik headers. */
export function remoteUserFromRequest(req: FastifyRequest): FamilyUserId | null {
  const header = req.headers['remote-user'];
  const raw = Array.isArray(header) ? header[0] : header;
  return normalizeFamilyUser(raw);
}

/** Parse Authelia Remote-Groups CSV. */
export function remoteGroupsFromRequest(req: FastifyRequest): string[] {
  const header = req.headers['remote-groups'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminRequest(req: FastifyRequest): boolean {
  return remoteGroupsFromRequest(req).includes('admins');
}

export interface RequestUser {
  id: AppUserId;
  displayName: string;
  isAdmin: boolean;
  /** True when identity came from Authelia Remote-User. */
  authenticated: boolean;
}

/**
 * Resolve current app user. Missing Remote-User → anonymous (no 401).
 * Production web is behind Authelia; loopback/dev without headers is anonymous.
 */
export function resolveUser(req: FastifyRequest): RequestUser {
  const id = remoteUserFromRequest(req);
  const isAdmin = isAdminRequest(req);
  if (id) {
    return {
      id,
      displayName: FAMILY_DISPLAY[id],
      isAdmin,
      authenticated: true,
    };
  }
  return {
    id: ANONYMOUS_USER,
    displayName: 'Anonymous',
    isAdmin: false,
    authenticated: false,
  };
}

/**
 * Require a family Authelia user (not anonymous). Sends 401 when missing.
 * Use for destructive/admin-only paths that must not run as anonymous.
 */
export function requireUser(req: FastifyRequest, reply: FastifyReply): RequestUser | null {
  const user = resolveUser(req);
  if (!user.authenticated) {
    reply.code(401).send({ error: 'authentication required', hint: 'Authelia Remote-User missing' });
    return null;
  }
  return user;
}

export function isFamilyUser(id: string): id is FamilyUserId {
  return (FAMILY_USERS as readonly string[]).includes(id);
}

export function isAppUser(id: string): id is AppUserId {
  return id === ANONYMOUS_USER || isFamilyUser(id);
}
