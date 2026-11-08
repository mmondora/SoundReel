// InboxModel.swift — the state behind the «Posta» tab: the notifications of my shares, the shares others made with me,
// the unread count (tab badge + app icon), and what the user can do with them: read, delete, see, retry.
//
// The server is the source of truth (ADR-0015): this model reads it when the tab opens, when the app comes to the
// front, after a sync and on pull-to-refresh, so it works with no push at all. Changes are applied at once and
// confirmed by the server; if the call fails the change is taken back.

import Foundation

public enum InboxRefreshReason: Equatable, Sendable {
    /// App launch, the tab opening, pull-to-refresh: the whole list.
    case launch, open, pull
    /// The app came to the front, a sync ended, a push arrived: only what changed since the last reading.
    case foreground, sync, push

    var isFull: Bool {
        switch self {
        case .launch, .open, .pull: return true
        case .foreground, .sync, .push: return false
        }
    }
}

/// The number on the app icon. A protocol because it needs UserNotifications, which the tests must never touch.
public protocol BadgeSetting: Sendable {
    func setBadge(_ count: Int) async
}

public struct NoBadge: BadgeSetting {
    public init() {}
    public func setBadge(_ count: Int) async {}
}

public enum InboxRetryResult: Equatable, Sendable {
    /// Sent again; the error goes away by itself when the link later succeeds.
    case sent(ShareOutcome)
    case failed(String)
    /// The notification has no link to send again.
    case noLink
}

@MainActor
public final class InboxModel: ObservableObject {
    /// A light reading that finds the last full one older than this does a full one: «since» cannot tell the phone
    /// that an error was closed or a notification deleted elsewhere.
    public static let fullEvery: TimeInterval = 10 * 60

    @Published public private(set) var notifications: [InboxNotification] = []
    @Published public private(set) var received: [ReceivedShare] = []
    /// Unread notifications + received shares not seen yet — the number on the badge. A received share counts ONCE:
    /// its notice and the share itself are the same thing (seen == read), as the server counts them.
    @Published public private(set) var unread = 0
    @Published public private(set) var isRefreshing = false
    /// The last reading failed (shown quietly: the list on screen is still the last good one).
    @Published public private(set) var error: String?
    /// When each error was sent again from here — so the row can say «Rimandato» instead of looking untouched.
    @Published public private(set) var resent: [String: Date] = [:]
    @Published public private(set) var lastRefreshAt: Date?

    /// The Posta tab is on screen right now: what it shows is being read, so nothing needs announcing.
    public var postaOnScreen = false

    /// The `serverTime` of the last answer: the next light reading sends it as `since`.
    public private(set) var serverTime: String?
    private var lastFullAt: Date?

    private let transport: InboxTransport
    private let sender: ShareSending
    private let log: ShareLog
    private let badge: BadgeSetting
    private let announcer: InboxAnnouncer?
    private let now: () -> Date

    public init(
        transport: InboxTransport,
        sender: ShareSending,
        log: ShareLog = .shared,
        badge: BadgeSetting = NoBadge(),
        announcer: InboxAnnouncer? = nil,
        now: @escaping () -> Date = { Date() }
    ) {
        self.transport = transport
        self.sender = sender
        self.log = log
        self.badge = badge
        self.announcer = announcer
        self.now = now
    }

    // MARK: what is shown

    /// Errors first, then newest first; info notifications past their expiry are not shown.
    public var visibleNotifications: [InboxNotification] {
        InboxVisibility.ordered(notifications, now: now())
    }

    public var unreadNotifications: Int { visibleNotifications.filter { !$0.isRead }.count }
    public var unseenReceived: Int { received.filter { !$0.seen }.count }

    /// The badge worked out from the lists, with the server's rule (a share and its notice count once).
    private func localUnread() -> Int {
        InboxUnread.count(notifications: notifications, received: received, now: now())
    }

    /// Takes `delta` off the count, never below zero, and says how much was really taken so an undo gives back exactly that.
    private func lower(by delta: Int) -> Int {
        let applied = max(0, min(delta, unread))
        unread -= applied
        return applied
    }

    // MARK: reading

    /// `postaVisible`: the tab is on screen, so the notifications are being read and need no announcement.
    public func refresh(_ reason: InboxRefreshReason, postaVisible: Bool = false) async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        let at = now()
        let full = reason.isFull || serverTime == nil || lastFullAt.map { at.timeIntervalSince($0) > Self.fullEvery } ?? true
        do {
            let snapshot = try await transport.inbox(since: full ? nil : serverTime, limit: 100)
            apply(snapshot, full: full)
            if let time = snapshot.serverTime { serverTime = time }
            if full { lastFullAt = at }
            lastRefreshAt = at
            error = nil
            await badge.setBadge(unread)
            await announcer?.announce(notifications, unread: unread, postaVisible: postaVisible || postaOnScreen)
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            self.error = Self.describe(error)
        }
    }

    private func apply(_ snapshot: InboxSnapshot, full: Bool) {
        // `received` is ALWAYS the full list, also in an answer to a light reading (`since` only narrows the
        // notifications), each with its `seen`: it replaces what the phone had, so a share that was withdrawn is gone
        // at once instead of lingering until the next full reading.
        received = snapshot.received
        if full {
            notifications = snapshot.notifications
        } else {
            // A light reading says what changed: it adds and updates, and `removedIds` names what disappeared
            // (deleted elsewhere, an error closed because the same link succeeded, information that expired). A
            // server that does not say it is covered by the full reading every `fullEvery`.
            var merged = notifications
            for item in snapshot.notifications {
                if let i = merged.firstIndex(where: { $0.id == item.id }) { merged[i] = item } else { merged.append(item) }
            }
            if !snapshot.removedIds.isEmpty {
                let gone = Set(snapshot.removedIds)
                merged.removeAll { gone.contains($0.id) }
            }
            notifications = merged
        }
        notifications = notifications.filter { InboxVisibility.isVisible($0, now: now()) }
        // «rimandato» is remembered only for what is still there
        let present = Set(notifications.map(\.id))
        resent = resent.filter { present.contains($0.key) }
        unread = snapshot.unread ?? localUnread()
    }

    /// A push arrived while the app ran and iOS showed it: it must not be announced again from the inbox.
    public func markAnnounced(_ id: String) {
        announcer?.markAnnounced(id)
    }

    // MARK: changing
    //
    // Every change is applied at once and confirmed by the server; if the call fails it is taken back. Seen and read
    // are ONE act, as on the server: reading the notice of a received share sees the share, seeing the share reads
    // its notice, and deleting the notice sees the share — so the optimistic number is the number the server will say.

    /// The received share a «shared with you» notice announces, when it is still unseen.
    private func unseenShareIndex(for notification: InboxNotification) -> Int? {
        guard notification.kind == "share_received", let entryId = notification.entryId else { return nil }
        return received.firstIndex { $0.entryId == entryId && !$0.seen }
    }

    /// «Mark read on view» for one notification.
    public func markRead(_ id: String) async {
        guard let i = notifications.firstIndex(where: { $0.id == id }), notifications[i].readAt == nil else { return }
        let before = localUnread()
        notifications[i].readAt = now()
        var seenEntry: String?
        if let s = unseenShareIndex(for: notifications[i]) {
            received[s].seen = true
            seenEntry = received[s].entryId
        }
        let applied = lower(by: before - localUnread())
        await badge.setBadge(unread)
        do {
            try await transport.markRead(id: id)
        } catch {
            // not confirmed: take it back, the next reading says what is true
            if let j = notifications.firstIndex(where: { $0.id == id }) { notifications[j].readAt = nil }
            if let entryId = seenEntry, let s = received.firstIndex(where: { $0.entryId == entryId }) { received[s].seen = false }
            unread += applied
            await badge.setBadge(unread)
        }
    }

    /// The tab opened: what is on screen counts as read.
    public func markVisibleRead() async {
        for id in visibleNotifications.filter({ !$0.isRead }).map(\.id) { await markRead(id) }
    }

    public func markAllRead() async {
        let notificationsBefore = notifications
        let receivedBefore = received
        let previousUnread = unread
        let stamp = now()
        notifications = notifications.map { var n = $0; if n.readAt == nil { n.readAt = stamp }; return n }
        received = received.map { var share = $0; share.seen = true; return share }
        // the server reads and sees everything: nothing is left, whatever the lists on this phone held
        unread = 0
        await badge.setBadge(unread)
        do {
            try await transport.markAllRead()
        } catch {
            notifications = notificationsBefore
            received = receivedBefore
            unread = previousUnread
            await badge.setBadge(unread)
            self.error = "Non sono riuscito a segnare tutto come letto: \(Self.describe(error))"
        }
    }

    /// Swipe / button. The only way to remove an error.
    public func delete(_ id: String) async {
        guard let i = notifications.firstIndex(where: { $0.id == id }) else { return }
        let before = localUnread()
        let removed = notifications[i]
        notifications.remove(at: i)
        var seenEntry: String?
        if let s = unseenShareIndex(for: removed) {
            received[s].seen = true
            seenEntry = received[s].entryId
        }
        let applied = lower(by: before - localUnread())
        await badge.setBadge(unread)
        do {
            try await transport.deleteNotification(id: id)
        } catch {
            notifications.insert(removed, at: min(i, notifications.count))
            if let entryId = seenEntry, let s = received.firstIndex(where: { $0.entryId == entryId }) { received[s].seen = false }
            unread += applied
            await badge.setBadge(unread)
            self.error = "Non sono riuscito a eliminarla: \(Self.describe(error))"
        }
    }

    /// A received share was opened: it is not «nuova» any more, and the notice that announced it is read.
    public func markSeen(_ entryId: String) async {
        guard let i = received.firstIndex(where: { $0.entryId == entryId }), !received[i].seen else { return }
        let before = localUnread()
        received[i].seen = true
        let stamp = now()
        var readNow: [String] = []
        for j in notifications.indices
        where notifications[j].kind == "share_received" && notifications[j].entryId == entryId && notifications[j].readAt == nil {
            notifications[j].readAt = stamp
            readNow.append(notifications[j].id)
        }
        let applied = lower(by: before - localUnread())
        await badge.setBadge(unread)
        do {
            try await transport.markSeen(entryId: entryId)
        } catch {
            if let j = received.firstIndex(where: { $0.entryId == entryId }) { received[j].seen = false }
            for j in notifications.indices where readNow.contains(notifications[j].id) { notifications[j].readAt = nil }
            unread += applied
            await badge.setBadge(unread)
        }
    }

    // MARK: «Riprova»

    /// Sends `data.sourceUrl` again through the same share call, THE WAY IT WAS SENT: with this phone's record of the
    /// share (the share log) when it has one, else with what the server kept (`data.options`), so an error of a share
    /// made on another device can be retried too. When the playlist was the problem the link goes without it.
    public func retry(_ notification: InboxNotification) async -> InboxRetryResult {
        let source = notification.data.sourceUrl ?? ""
        let local = source.isBlank ? nil : log.lastEntry(forURL: source, now: now())
        guard let request = InboxRetry.request(for: notification, local: local) else { return .noLink }
        do {
            let response = try await sender.share(url: request.url, comment: request.comment, tags: nil, options: request.options)
            guard response.success else { return .failed(ShareOutcomeText.failure(for: response)) }
            // Every share written from this phone leaves a line in the log: the next «Riprova» of this link starts
            // from what was really sent now (without the playlist, if it was dropped).
            log.record(url: request.url, comment: request.comment, options: request.options, at: now())
            resent[notification.id] = now()
            return .sent(ShareOutcomeText.success(response))
        } catch {
            return .failed(ShareOutcomeText.failure(for: error))
        }
    }

    static func describe(_ error: Error) -> String {
        // A backend from before the Posta answers 404: not a failure of the phone, the server has to be updated.
        if case .http(404, _)? = error as? MondropAPIError { return "il server non ha ancora la Posta (backend da aggiornare)" }
        return (error as? MondropAPIError)?.description ?? error.localizedDescription
    }
}
