import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/db', () => ({ query: queryMock }));

import { devicesForUser, registerPushDevice, removePushDevice, unregisterPushDevice } from './pushDevices';

beforeEach(() => queryMock.mockReset());

describe('push devices', () => {
  it('registers by token: a phone handed to somebody else re-registers under the new user', async () => {
    queryMock.mockResolvedValue([]);
    await registerPushDevice({ token: 'ab'.repeat(32), userId: 'sara', environment: 'production', device: 'iPhone di Sara' });
    expect(String(queryMock.mock.calls[0][0])).toMatch(/ON CONFLICT \(token\) DO UPDATE SET\s+user_id = EXCLUDED\.user_id/);
    expect(queryMock.mock.calls[0][1]).toEqual(['ab'.repeat(32), 'sara', 'production', 'iPhone di Sara']);
  });

  it('bounds the device label', async () => {
    queryMock.mockResolvedValue([]);
    await registerPushDevice({ token: 'ab'.repeat(32), userId: 'sara', environment: 'development', device: 'x'.repeat(300) });
    expect(((queryMock.mock.calls[0][1] as string[])[3]).length).toBe(100);
  });

  it('a user removes only his own phones', async () => {
    queryMock.mockResolvedValueOnce([{ token: 't' }]).mockResolvedValueOnce([]);
    expect(await unregisterPushDevice('mike', 't')).toBe(true);
    expect(await unregisterPushDevice('archi', 't')).toBe(false);
    expect(String(queryMock.mock.calls[0][0])).toMatch(/WHERE token = \$1 AND user_id = \$2/);
  });

  it('lists the phones of one user, defaulting an unknown environment to production', async () => {
    queryMock.mockResolvedValue([{ token: 'a', environment: 'development' }, { token: 'b', environment: 'production' }, { token: 'c', environment: 'weird' }]);
    expect(await devicesForUser('mike')).toEqual([
      { token: 'a', environment: 'development' }, { token: 'b', environment: 'production' }, { token: 'c', environment: 'production' },
    ]);
    expect(String(queryMock.mock.calls[0][0])).toMatch(/WHERE user_id = \$1/);
  });

  it('forgets a token Apple rejected, whoever had it', async () => {
    queryMock.mockResolvedValue([]);
    await removePushDevice('dead');
    expect(String(queryMock.mock.calls[0][0])).toMatch(/DELETE FROM push_devices WHERE token = \$1/);
  });
});
