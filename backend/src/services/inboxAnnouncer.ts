/**
 * The doorbell (ADR-0015): when an inbox item is created, ring the user's phones. The item is already stored; the
 * push only says "something arrived" and carries its id, so a push that fails or is switched off loses nothing.
 * Never throws: an announcement must not cost the caller its job or its share.
 */
import { logWarning } from '../utils/logger';
import type { InboxItem } from './inbox';
import { unreadCount } from './inbox';
import { getApnsSender, type ApnsSender, type PushTarget } from './apnsClient';
import { devicesForUser, removePushDevice } from './pushDevices';

export interface AnnouncerDeps {
  sender: () => ApnsSender | null;
  devices: (userId: string) => Promise<PushTarget[]>;
  badge: (userId: string) => Promise<number>;
  forget: (token: string) => Promise<void>;
}

const defaults: AnnouncerDeps = {
  sender: getApnsSender,
  devices: devicesForUser,
  badge: (userId) => unreadCount(userId),
  forget: removePushDevice,
};

/** The payload of `docs/mondrop-inbox.md`: the alert, the badge, and the ids the app opens. */
export function buildPushPayload(item: Pick<InboxItem, 'id' | 'title' | 'body' | 'entryId'>, badge: number): Record<string, unknown> {
  return {
    aps: {
      alert: { title: item.title, body: item.body },
      sound: 'default',
      badge,
      'thread-id': 'inbox',
    },
    inboxId: item.id,
    ...(item.entryId ? { entryId: item.entryId } : {}),
  };
}

export async function announceInboxItem(
  item: Pick<InboxItem, 'id' | 'userId' | 'title' | 'body' | 'entryId'>,
  deps: AnnouncerDeps = defaults,
): Promise<void> {
  try {
    const send = deps.sender();
    if (!send) return; // push is off until the APNs key exists
    const targets = await deps.devices(item.userId);
    if (targets.length === 0) return;
    const payload = buildPushPayload(item, await deps.badge(item.userId));
    for (const target of targets) {
      const outcome = await send(target, payload);
      if (outcome === 'invalid_token') await deps.forget(target.token);
    }
  } catch (err) {
    logWarning('inbox announcement failed (the item is stored anyway)', { error: err instanceof Error ? err.message : String(err) });
  }
}
