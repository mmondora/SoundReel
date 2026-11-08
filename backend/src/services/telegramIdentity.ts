/**
 * Telegram → Authelia owner mapping via claimed proper name.
 * Pending chats wait for a free-text name (never suggest family names).
 */
import { getTelegramIdentity, upsertTelegramIdentity } from '../utils/db';
import { matchFamilyName, ANONYMOUS_USER, type FamilyUserId } from '../utils/requestUser';

/** chatId → awaiting name claim */
const pendingNameByChat = new Map<number, number>(); // chatId → expiresAt ms

const PENDING_TTL_MS = 30 * 60 * 1000;

export function telegramKeysFromMessage(from: {
  id?: number;
  username?: string;
} | undefined): string[] {
  if (!from) return [];
  const keys: string[] = [];
  if (from.username) keys.push(from.username.trim().toLowerCase());
  if (typeof from.id === 'number') keys.push(`id:${from.id}`);
  return keys;
}

export async function resolveTelegramOwner(
  from: { id?: number; username?: string } | undefined,
): Promise<{ ownerUser: string; claimedName: string | null; mapped: boolean }> {
  for (const key of telegramKeysFromMessage(from)) {
    const row = await getTelegramIdentity(key);
    if (row) {
      return { ownerUser: row.ownerUser, claimedName: row.claimedName, mapped: true };
    }
  }
  return { ownerUser: ANONYMOUS_USER, claimedName: null, mapped: false };
}

export function markPendingName(chatId: number): void {
  pendingNameByChat.set(chatId, Date.now() + PENDING_TTL_MS);
}

export function clearPendingName(chatId: number): void {
  pendingNameByChat.delete(chatId);
}

export function isPendingName(chatId: number): boolean {
  const exp = pendingNameByChat.get(chatId);
  if (!exp) return false;
  if (Date.now() > exp) {
    pendingNameByChat.delete(chatId);
    return false;
  }
  return true;
}

export const ASK_NAME_MESSAGE =
  'Prima di analizzare i link, dimmi come ti chiami (nome proprio).';

export async function claimTelegramName(
  from: { id?: number; username?: string } | undefined,
  claimedRaw: string,
): Promise<{ ok: true; ownerUser: FamilyUserId; claimedName: string } | { ok: false }> {
  const ownerUser = matchFamilyName(claimedRaw);
  if (!ownerUser) return { ok: false };
  const claimedName = claimedRaw.trim().replace(/\s+/g, ' ');
  const keys = telegramKeysFromMessage(from);
  if (keys.length === 0) return { ok: false };
  for (const key of keys) {
    await upsertTelegramIdentity(key, ownerUser, claimedName);
  }
  return { ok: true, ownerUser, claimedName };
}

/** Test helper */
export function _resetPendingForTests(): void {
  pendingNameByChat.clear();
}
