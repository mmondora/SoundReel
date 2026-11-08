// InboxAnnouncer.swift — the local notification that stands in for push (spec IN6, ADR-0015 «push is only the
// doorbell»): when the app learns of notifications it has not told the user about yet, it posts ONE local notification.
// What to post, and when to stay quiet, is pure code; remembering which ids were already announced is a tiny store.

import Foundation

/// The ids already announced, oldest first, so a notification is announced once however many times the inbox is read.
public protocol AnnouncedIDStore: AnyObject {
    var ids: [String] { get set }
}

public final class MemoryAnnouncedIDs: AnnouncedIDStore {
    public var ids: [String] = []
    public init(_ ids: [String] = []) { self.ids = ids }
}

/// In the App Group defaults, like the other small Mondrop settings.
public final class DefaultsAnnouncedIDs: AnnouncedIDStore {
    private let defaults: UserDefaults
    private let key = "inboxAnnouncedIds"

    public init(defaults: UserDefaults) { self.defaults = defaults }

    public var ids: [String] {
        get { defaults.stringArray(forKey: key) ?? [] }
        set { defaults.set(newValue, forKey: key) }
    }
}

public enum InboxAnnouncementPolicy {
    /// Older than this is not news any more (and a first launch must not announce a backlog of days).
    public static let maxAge: TimeInterval = 24 * 3600
    /// How many announced ids are remembered.
    public static let memory = 300

    public struct Plan: Equatable, Sendable {
        /// nil = stay quiet.
        public let content: SyncNotificationContent?
        /// Every unread notification this reading showed for the first time: remembered whether or not it was posted
        /// (the user saw it, was pushed it, or switched announcements off — it must not come back later).
        public let known: [String]
    }

    public static func plan(
        notifications: [InboxNotification],
        announced: [String],
        unread: Int,
        now: Date,
        enabled: Bool,
        permission: NotificationPermission,
        postaVisible: Bool,
        pushActive: Bool
    ) -> Plan {
        let already = Set(announced)
        let candidates = notifications
            .filter { !$0.isRead && !already.contains($0.id) && InboxVisibility.isVisible($0, now: now) }
            .sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
        let known = candidates.map(\.id)
        let fresh = candidates.filter { $0.createdAt.map { now.timeIntervalSince($0) <= maxAge } ?? true }

        // Quiet when: switched off · iOS has not allowed it · the push already rang · the user is reading the list now.
        guard enabled, permission == .allowed, !pushActive, !postaVisible, let latest = fresh.first else {
            return Plan(content: nil, known: known)
        }
        if fresh.count == 1 {
            return Plan(
                content: SyncNotificationContent(
                    title: latest.title.isEmpty ? "SoundReel" : latest.title,
                    body: latest.body,
                    identifier: "mondrop.inbox.\(latest.id)",
                    userInfo: userInfo(for: latest),
                    badge: unread
                ),
                known: known
            )
        }
        let errors = fresh.filter(\.isError).count
        var body = "\(fresh.count) nuove notifiche"
        if errors > 0 { body += errors == 1 ? " · 1 con errore" : " · \(errors) con errore" }
        return Plan(
            content: SyncNotificationContent(
                title: "SoundReel", body: body, identifier: "mondrop.inbox.summary", userInfo: userInfo(for: latest), badge: unread
            ),
            known: known
        )
    }

    /// What a tap needs to open the right place (the same keys the push payload carries).
    static func userInfo(for n: InboxNotification) -> [String: String] {
        var info = ["inboxId": n.id]
        if let entryId = n.entryId { info["entryId"] = entryId }
        return info
    }
}

@MainActor
public final class InboxAnnouncer {
    private let store: AnnouncedIDStore
    private let center: @MainActor () -> SyncNotificationCenter?
    private let isEnabled: @MainActor () -> Bool
    private let pushActive: @MainActor () -> Bool
    private let now: () -> Date

    public init(
        store: AnnouncedIDStore,
        center: @escaping @MainActor () -> SyncNotificationCenter?,
        isEnabled: @escaping @MainActor () -> Bool,
        pushActive: @escaping @MainActor () -> Bool = { false },
        now: @escaping () -> Date = { Date() }
    ) {
        self.store = store
        self.center = center
        self.isEnabled = isEnabled
        self.pushActive = pushActive
        self.now = now
    }

    /// Called after every reading of the inbox. `postaVisible`: the user is looking at the list right now.
    public func announce(_ notifications: [InboxNotification], unread: Int, postaVisible: Bool) async {
        let enabled = isEnabled()
        let permission = await center()?.permission() ?? .notDetermined
        let plan = InboxAnnouncementPolicy.plan(
            notifications: notifications,
            announced: store.ids,
            unread: unread,
            now: now(),
            enabled: enabled,
            permission: permission,
            postaVisible: postaVisible,
            pushActive: pushActive()
        )
        if !plan.known.isEmpty {
            store.ids = Array((store.ids + plan.known).suffix(InboxAnnouncementPolicy.memory))
        }
        if let content = plan.content, let center = center() {
            await center.post(content)
        }
    }

    /// A push arrived while the app was running: the system already told the user, so it is not announced again.
    public func markAnnounced(_ id: String) {
        guard !store.ids.contains(id) else { return }
        store.ids = Array((store.ids + [id]).suffix(InboxAnnouncementPolicy.memory))
    }
}
