import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db', () => ({
  getTelegramIdentity: vi.fn(),
  upsertTelegramIdentity: vi.fn(),
}));

import { getTelegramIdentity, upsertTelegramIdentity } from '../utils/db';
import {
  resolveTelegramOwner,
  claimTelegramName,
  markPendingName,
  isPendingName,
  clearPendingName,
  ASK_NAME_MESSAGE,
  _resetPendingForTests,
} from './telegramIdentity';

describe('telegramIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPendingForTests();
  });

  it('does not suggest names in the ask prompt', () => {
    expect(ASK_NAME_MESSAGE.toLowerCase()).not.toMatch(/michele|archimede|sara|mike|archi/);
    expect(ASK_NAME_MESSAGE).toMatch(/nome proprio/i);
  });

  it('resolves mapped telegram user', async () => {
    vi.mocked(getTelegramIdentity).mockResolvedValueOnce({
      ownerUser: 'sara',
      claimedName: 'Sara',
    });
    const r = await resolveTelegramOwner({ id: 1, username: 'sara_tg' });
    expect(r).toEqual({ ownerUser: 'sara', claimedName: 'Sara', mapped: true });
  });

  it('falls back to anonymous when unmapped', async () => {
    vi.mocked(getTelegramIdentity).mockResolvedValue(null);
    const r = await resolveTelegramOwner({ id: 99, username: 'stranger' });
    expect(r.mapped).toBe(false);
    expect(r.ownerUser).toBe('anonymous');
  });

  it('claims a proper name without listing options', async () => {
    vi.mocked(upsertTelegramIdentity).mockResolvedValue();
    const ok = await claimTelegramName({ id: 7, username: 'x' }, 'Michele Mondora');
    expect(ok).toEqual({ ok: true, ownerUser: 'mike', claimedName: 'Michele Mondora' });
    expect(upsertTelegramIdentity).toHaveBeenCalled();
  });

  it('rejects unknown claimed names', async () => {
    const bad = await claimTelegramName({ id: 7 }, 'Giuseppe');
    expect(bad).toEqual({ ok: false });
    expect(upsertTelegramIdentity).not.toHaveBeenCalled();
  });

  it('tracks pending name state per chat', () => {
    expect(isPendingName(42)).toBe(false);
    markPendingName(42);
    expect(isPendingName(42)).toBe(true);
    clearPendingName(42);
    expect(isPendingName(42)).toBe(false);
  });
});
