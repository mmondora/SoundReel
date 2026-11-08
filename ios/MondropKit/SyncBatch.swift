// SyncBatch.swift — «Sync finito»: what one sync did, and whether the phone should say so.
//
// A *sync* is what the user asked for with Sync / Riprova / Riscarica: the songs it queued. The download that a first
// play starts in parallel is NOT part of it (a notification at every track change would be noise). The batch is
// persisted, so when iOS wakes the app in the background to deliver the last download the summary still knows
// which songs the sync started.

import Foundation

public struct SyncBatchSummary: Equatable, Sendable {
    public let downloaded: Int
    public let failed: Int

    public init(downloaded: Int, failed: Int) {
        self.downloaded = downloaded
        self.failed = failed
    }
}

/// The songs of the sync in progress. Only a song that was queued by a sync can settle it.
public struct SyncBatch: Codable, Equatable, Sendable {
    /// Queued by the sync, not finished yet.
    public private(set) var pending: Set<String> = []
    public private(set) var downloaded: Set<String> = []
    public private(set) var failed: [String: String] = [:]
    public private(set) var startedAt: Date?

    public init() {}

    private enum CodingKeys: String, CodingKey { case pending, downloaded, failed, startedAt }

    /// Tolerant: a half-written or older file never prevents the app from starting.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pending = Set((try? c.decodeIfPresent([String].self, forKey: .pending)) ?? [])
        downloaded = Set((try? c.decodeIfPresent([String].self, forKey: .downloaded)) ?? [])
        failed = (try? c.decodeIfPresent([String: String].self, forKey: .failed)) ?? [:]
        startedAt = (try? c.decodeIfPresent(Date.self, forKey: .startedAt)) ?? nil
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(pending.sorted(), forKey: .pending)
        try c.encode(downloaded.sorted(), forKey: .downloaded)
        try c.encode(failed, forKey: .failed)
        try c.encodeIfPresent(startedAt, forKey: .startedAt)
    }

    /// Nothing was ever queued (or everything was cancelled).
    public var isEmpty: Bool { pending.isEmpty && downloaded.isEmpty && failed.isEmpty }

    /// Everything the sync queued has settled, and something did happen.
    public var isFinished: Bool { pending.isEmpty && !(downloaded.isEmpty && failed.isEmpty) }

    public var summary: SyncBatchSummary { SyncBatchSummary(downloaded: downloaded.count, failed: failed.count) }

    /// The sync queued these songs (again: a retry takes a song out of «failed»).
    public mutating func enqueue(_ keys: [String], at date: Date) {
        guard !keys.isEmpty else { return }
        if startedAt == nil { startedAt = date }
        for key in keys {
            pending.insert(key)
            failed.removeValue(forKey: key)
            downloaded.remove(key)
        }
    }

    /// A download finished. Ignored unless the sync queued that song (a first-play download is not the sync's).
    public mutating func markInstalled(_ key: String) {
        guard pending.remove(key) != nil else { return }
        downloaded.insert(key)
    }

    public mutating func markFailed(_ key: String, message: String) {
        guard pending.remove(key) != nil else { return }
        failed[key] = message
    }

    /// The user cancelled it: neither a success nor an error.
    public mutating func forget(_ key: String) {
        pending.remove(key)
        downloaded.remove(key)
        failed.removeValue(forKey: key)
    }

    /// After a relaunch: songs that are neither running nor waiting any more (they finished while the app was dead and
    /// were counted elsewhere, or the user deleted them) must not keep the sync open for ever.
    public mutating func reconcile(stillActive keys: Set<String>) {
        pending = pending.intersection(keys)
    }

    /// A batch nobody finished for this long is the leftover of a crash, not a sync worth announcing.
    public func isStale(now: Date, after maxAge: TimeInterval = 6 * 3600) -> Bool {
        guard let startedAt else { return !isEmpty }
        return now.timeIntervalSince(startedAt) > maxAge
    }
}

// MARK: - Notification policy

public enum NotificationPermission: Equatable, Sendable {
    /// iOS has never been asked.
    case notDetermined
    case denied
    case allowed
}

public struct SyncNotificationContent: Equatable, Sendable {
    public let title: String
    public let body: String
    /// Mondrop 1.6 (the inbox): a notification that replaces an older one with the same identifier, carries the ids
    /// a tap needs, and sets the number on the app icon. All optional: the «Sync finito» notification uses none.
    public let identifier: String?
    public let userInfo: [String: String]
    public let badge: Int?

    public init(title: String, body: String, identifier: String? = nil, userInfo: [String: String] = [:], badge: Int? = nil) {
        self.title = title
        self.body = body
        self.identifier = identifier
        self.userInfo = userInfo
        self.badge = badge
    }
}

public enum SyncNotificationPolicy {
    /// The permission is asked for the first time the user starts something that will want it, never at the end of a
    /// background sync (iOS would not show the prompt there) and never when the switch is off.
    public static func shouldRequestPermission(enabled: Bool, permission: NotificationPermission) -> Bool {
        enabled && permission == .notDetermined
    }

    /// What to show when a sync ends; nil = stay quiet. Quiet when the switch is off, when iOS has not allowed
    /// notifications (denied, or never asked — the sync is never blocked by it), when the user is looking at the app
    /// (the status line already says it), or when nothing was downloaded and nothing failed.
    public static func content(
        for summary: SyncBatchSummary,
        stillPreparing: Int = 0,
        enabled: Bool,
        permission: NotificationPermission,
        appIsActive: Bool
    ) -> SyncNotificationContent? {
        guard enabled, permission == .allowed, !appIsActive else { return nil }
        guard summary.downloaded > 0 || summary.failed > 0 else { return nil }
        var body = "\(brani(summary.downloaded, scaricati: true)), \(errori(summary.failed))"
        if stillPreparing > 0 {
            body += " · \(stillPreparing) ancora in preparazione sul server"
        }
        return SyncNotificationContent(title: "Sync finito", body: body)
    }

    /// «1 brano scaricato», «12 brani scaricati».
    static func brani(_ n: Int, scaricati: Bool) -> String {
        n == 1 ? "1 brano scaricato" : "\(n) brani scaricati"
    }

    /// «0 errori», «1 errore», «3 errori».
    static func errori(_ n: Int) -> String {
        n == 1 ? "1 errore" : "\(n) errori"
    }
}

// MARK: - Notifier

/// The system side of the notification, behind a protocol: the app plugs in `UNUserNotificationCenter`, tests plug in a fake
/// (a unit test must never raise the permission prompt).
public protocol SyncNotificationCenter: Sendable {
    func permission() async -> NotificationPermission
    func requestPermission() async -> Bool
    func post(_ content: SyncNotificationContent) async
}

@MainActor
public final class SyncNotifier {
    public static let shared = SyncNotifier()

    /// nil until the app plugs one in (extensions and tests have none: nothing is ever posted).
    public var center: SyncNotificationCenter?
    /// The Impostazioni switch (default ON).
    public var isEnabled: @MainActor () -> Bool
    /// The user is looking at the app.
    public var isAppActive: @MainActor () -> Bool
    /// Songs the server was still preparing when the sync ended.
    public var stillPreparing: @MainActor () -> Int
    /// Posting right after the last download must not be cut short when iOS suspends the app again.
    public var backgroundRunner: BackgroundTaskRunner = NoBackgroundTask()

    public init(
        center: SyncNotificationCenter? = nil,
        isEnabled: @escaping @MainActor () -> Bool = { true },
        isAppActive: @escaping @MainActor () -> Bool = { false },
        stillPreparing: @escaping @MainActor () -> Int = { 0 }
    ) {
        self.center = center
        self.isEnabled = isEnabled
        self.isAppActive = isAppActive
        self.stillPreparing = stillPreparing
    }

    /// The user started a sync (or switched the setting on) in the foreground: the right moment to ask iOS, once.
    /// Never throws and never waits for the answer to matter: a «no» just means no notification later.
    public func ensurePermission() async {
        guard let center else { return }
        let permission = await center.permission()
        if SyncNotificationPolicy.shouldRequestPermission(enabled: isEnabled(), permission: permission) {
            _ = await center.requestPermission()
        }
    }

    /// A sync ended (called by the engine). Decides and, if it must, posts.
    public func syncFinished(_ summary: SyncBatchSummary) async {
        guard let center else { return }
        let enabled = isEnabled()
        guard enabled else { return }
        let permission = await center.permission()
        let content = SyncNotificationPolicy.content(
            for: summary,
            stillPreparing: stillPreparing(),
            enabled: enabled,
            permission: permission,
            appIsActive: isAppActive()
        )
        guard let content else { return }
        await backgroundRunner.run(name: "mondrop-sync-notification") {
            await center.post(content)
        }
    }
}
