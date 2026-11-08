// InboxModels.swift — «Posta»: the notifications of my shares, the shares others made with me (docs/mondrop-inbox.md,
// spec IN1–IN7), and the calls that read and change them.
//
// Decoded defensively like the manifest: a field this build does not know is ignored, a malformed element is skipped
// (one bad notification must not hide the others), and every field the contract does not guarantee is optional.

import Foundation

public enum InboxLevel: Equatable, Sendable {
    case info
    /// Errors never expire: they stay until the user removes them or the same link later succeeds.
    case error

    init(serverValue: String?) { self = serverValue?.lowercased() == "error" ? .error : .info }
}

public struct InboxPlaylistInfo: Equatable, Sendable {
    public let id: String
    public let name: String
    public let added: Int?
}

/// What the server kept of the share an error belongs to (`data.options`), so «Riprova» reproduces it from ANY device,
/// also when the share did not start from this phone. Every field is optional.
public struct InboxRetryOptions: Equatable, Sendable {
    public var playlistId: String?
    /// Family user ids; empty = nobody.
    public var shareWith: [String]
    public var comment: String?

    public init(playlistId: String? = nil, shareWith: [String] = [], comment: String? = nil) {
        self.playlistId = playlistId
        self.shareWith = shareWith
        self.comment = comment
    }

    public var shareOptions: ShareOptions { ShareOptions(playlistId: playlistId, shareWith: shareWith) }
}

extension InboxRetryOptions: Decodable {
    private enum CodingKeys: String, CodingKey { case playlistId, shareWith, comment }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func text(_ key: CodingKeys) -> String? {
            guard let value = (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil, !value.isBlank else { return nil }
            return value
        }
        playlistId = text(.playlistId)
        comment = text(.comment)
        shareWith = ((try? c.decodeIfPresent([LossyDecodable<String>].self, forKey: .shareWith)) ?? nil)?
            .compactMap { $0.value }.filter { !$0.isBlank } ?? []
    }
}

/// Why an error happened (`data.reason`). A reason this build does not know is kept as `.other`.
public enum InboxReason: Equatable, Sendable {
    case analysisFailed
    /// Instagram asked for a new session: the server keeps trying by itself.
    case instagramSession
    case aiOutputUnusable
    case shazamUnreadable
    case playlistNotFound
    case playlistDynamic
    case playlistReadOnly
    case other(String)

    public init(serverValue: String) {
        switch serverValue.lowercased() {
        case "analysis_failed": self = .analysisFailed
        case "instagram_session": self = .instagramSession
        case "ai_output_unusable": self = .aiOutputUnusable
        case "shazam_unreadable": self = .shazamUnreadable
        case "playlist_not_found": self = .playlistNotFound
        case "playlist_dynamic": self = .playlistDynamic
        case "playlist_read_only": self = .playlistReadOnly
        default: self = .other(serverValue)
        }
    }

    /// The playlist the share asked for was the problem: sending the link again must leave it out.
    public var isPlaylistProblem: Bool {
        switch self {
        case .playlistNotFound, .playlistDynamic, .playlistReadOnly: return true
        default: return false
        }
    }
}

/// `data` of a notification: the numbers of the Telegram-style summary, or — for an error — the link to send again,
/// the options it was sent with, and whether the server keeps trying by itself.
public struct InboxData: Equatable, Sendable {
    public var sourceUrl: String?
    public var reason: String?
    public var songs: Int?
    public var films: Int?
    public var notes: Int?
    public var software: Int?
    public var tags: Int?
    public var playlist: InboxPlaylistInfo?
    /// Errors: what the share was sent with (nil on a server that does not say).
    public var options: InboxRetryOptions?
    /// Errors: the server keeps trying by itself and closes the notice when the link goes through.
    public var retrying: Bool

    public init(
        sourceUrl: String? = nil, reason: String? = nil, songs: Int? = nil, films: Int? = nil, notes: Int? = nil,
        software: Int? = nil, tags: Int? = nil, playlist: InboxPlaylistInfo? = nil,
        options: InboxRetryOptions? = nil, retrying: Bool = false
    ) {
        self.sourceUrl = sourceUrl
        self.reason = reason
        self.songs = songs
        self.films = films
        self.notes = notes
        self.software = software
        self.tags = tags
        self.playlist = playlist
        self.options = options
        self.retrying = retrying
    }

    /// `reason` as something to switch on.
    public var reasonKind: InboxReason? {
        guard let reason, !reason.isBlank else { return nil }
        return InboxReason(serverValue: reason)
    }
}

extension InboxData: Decodable {
    private enum CodingKeys: String, CodingKey { case sourceUrl, reason, songs, films, notes, software, tags, playlist, options, retrying }

    private struct PlaylistBody: Decodable {
        let id: String?
        let name: String?
        let added: Int?
        private enum CodingKeys: String, CodingKey { case id, name, added }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? nil
            name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil
            added = (try? c.decodeIfPresent(Int.self, forKey: .added)) ?? nil
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func number(_ key: CodingKeys) -> Int? { (try? c.decodeIfPresent(Int.self, forKey: key)) ?? nil }
        sourceUrl = (try? c.decodeIfPresent(String.self, forKey: .sourceUrl)) ?? nil
        reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? nil
        songs = number(.songs)
        films = number(.films)
        notes = number(.notes)
        software = number(.software)
        tags = number(.tags)
        if let body = (try? c.decodeIfPresent(PlaylistBody.self, forKey: .playlist)) ?? nil, let id = body.id {
            playlist = InboxPlaylistInfo(id: id, name: body.name ?? id, added: body.added)
        } else {
            playlist = nil
        }
        options = (try? c.decodeIfPresent(InboxRetryOptions.self, forKey: .options)) ?? nil
        retrying = (try? c.decodeIfPresent(Bool.self, forKey: .retrying)) ?? false
    }
}

public struct InboxNotification: Identifiable, Equatable, Sendable {
    public let id: String
    /// `share_result` (the outcome of one of MY shares) · `share_received` (someone shared with me).
    public let kind: String
    public let level: InboxLevel
    public let title: String
    public let body: String
    public let entryId: String?
    /// The entry on the SoundReel site.
    public let url: String?
    public let createdAt: Date?
    public var readAt: Date?
    /// nil for errors (they never expire).
    public let expiresAt: Date?
    public let data: InboxData

    public var isError: Bool { level == .error }
    public var isRead: Bool { readAt != nil }

    public init(
        id: String, kind: String = "share_result", level: InboxLevel = .info, title: String = "", body: String = "",
        entryId: String? = nil, url: String? = nil, createdAt: Date? = nil, readAt: Date? = nil, expiresAt: Date? = nil,
        data: InboxData = InboxData()
    ) {
        self.id = id
        self.kind = kind
        self.level = level
        self.title = title
        self.body = body
        self.entryId = entryId
        self.url = url
        self.createdAt = createdAt
        self.readAt = readAt
        self.expiresAt = expiresAt
        self.data = data
    }
}

extension InboxNotification: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, kind, level, title, body, entryId, url, createdAt, readAt, expiresAt, data
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func text(_ key: CodingKeys) -> String? { (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil }
        id = try c.decode(String.self, forKey: .id)
        kind = text(.kind) ?? "share_result"
        level = InboxLevel(serverValue: text(.level))
        title = text(.title) ?? ""
        body = text(.body) ?? ""
        entryId = text(.entryId)
        url = text(.url)
        createdAt = ISO.parse(text(.createdAt))
        readAt = ISO.parse(text(.readAt))
        expiresAt = ISO.parse(text(.expiresAt))
        data = ((try? c.decodeIfPresent(InboxData.self, forKey: .data)) ?? nil) ?? InboxData()
    }
}

public struct ShareCounts: Equatable, Sendable {
    public var songs: Int
    public var films: Int
    public var notes: Int
    public var software: Int

    public init(songs: Int = 0, films: Int = 0, notes: Int = 0, software: Int = 0) {
        self.songs = songs
        self.films = films
        self.notes = notes
        self.software = software
    }

    /// «2 canzoni, 1 film»; empty when there is nothing to count.
    public var summary: String {
        var parts: [String] = []
        if songs > 0 { parts.append(songs == 1 ? "1 canzone" : "\(songs) canzoni") }
        if films > 0 { parts.append("\(films) film") }
        if notes > 0 { parts.append(notes == 1 ? "1 nota" : "\(notes) note") }
        if software > 0 { parts.append("\(software) software") }
        return parts.joined(separator: ", ")
    }
}

/// An entry someone else shared with me (`entry_shares`). Not a notification: it does not expire.
public struct ReceivedShare: Identifiable, Equatable, Sendable {
    public var id: String { entryId }
    public let entryId: String
    public let from: String
    public let sharedAt: Date?
    public let title: String
    public let kind: String
    public let counts: ShareCounts
    public var seen: Bool
    public let url: String?

    public init(
        entryId: String, from: String, sharedAt: Date? = nil, title: String = "", kind: String = "",
        counts: ShareCounts = ShareCounts(), seen: Bool = false, url: String? = nil
    ) {
        self.entryId = entryId
        self.from = from
        self.sharedAt = sharedAt
        self.title = title
        self.kind = kind
        self.counts = counts
        self.seen = seen
        self.url = url
    }
}

extension ReceivedShare: Decodable {
    private enum CodingKeys: String, CodingKey { case entryId, from, sharedAt, title, kind, counts, seen, url }

    private struct CountsBody: Decodable {
        let songs: Int?, films: Int?, notes: Int?, software: Int?
        private enum CodingKeys: String, CodingKey { case songs, films, notes, software }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            songs = (try? c.decodeIfPresent(Int.self, forKey: .songs)) ?? nil
            films = (try? c.decodeIfPresent(Int.self, forKey: .films)) ?? nil
            notes = (try? c.decodeIfPresent(Int.self, forKey: .notes)) ?? nil
            software = (try? c.decodeIfPresent(Int.self, forKey: .software)) ?? nil
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func text(_ key: CodingKeys) -> String? { (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil }
        entryId = try c.decode(String.self, forKey: .entryId)
        from = text(.from) ?? ""
        sharedAt = ISO.parse(text(.sharedAt))
        title = text(.title) ?? ""
        kind = text(.kind) ?? ""
        let counted = ((try? c.decodeIfPresent(CountsBody.self, forKey: .counts)) ?? nil)
        counts = ShareCounts(songs: counted?.songs ?? 0, films: counted?.films ?? 0, notes: counted?.notes ?? 0, software: counted?.software ?? 0)
        seen = (try? c.decodeIfPresent(Bool.self, forKey: .seen)) ?? false
        url = text(.url)
    }
}

/// `GET /api/mondrop/inbox`
public struct InboxSnapshot: Decodable, Equatable, Sendable {
    public let notifications: [InboxNotification]
    public let received: [ReceivedShare]
    /// With `since`: the ids of the notifications that disappeared meanwhile — deleted on another device, errors the
    /// server closed because the same link later succeeded, information that expired. Empty on an older server.
    public let removedIds: [String]
    /// The badge, counted by the server: unread notifications + received shares not seen yet, each received share
    /// ONCE (its notice and the share itself are the same thing). nil when the server left it out.
    public let unread: Int?
    /// The instant of this answer: the next light read sends it back as `since`.
    public let serverTime: String?

    public init(
        notifications: [InboxNotification] = [], received: [ReceivedShare] = [], removedIds: [String] = [],
        unread: Int? = nil, serverTime: String? = nil
    ) {
        self.notifications = notifications
        self.received = received
        self.removedIds = removedIds
        self.unread = unread
        self.serverTime = serverTime
    }

    private enum CodingKeys: String, CodingKey { case notifications, received, removedIds, unread, serverTime }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        notifications = ((try? c.decodeIfPresent([LossyDecodable<InboxNotification>].self, forKey: .notifications)) ?? nil)?
            .compactMap { $0.value } ?? []
        received = ((try? c.decodeIfPresent([LossyDecodable<ReceivedShare>].self, forKey: .received)) ?? nil)?
            .compactMap { $0.value } ?? []
        removedIds = ((try? c.decodeIfPresent([LossyDecodable<String>].self, forKey: .removedIds)) ?? nil)?
            .compactMap { $0.value } ?? []
        unread = (try? c.decodeIfPresent(Int.self, forKey: .unread)) ?? nil
        serverTime = (try? c.decodeIfPresent(String.self, forKey: .serverTime)) ?? nil
    }
}

// MARK: - What the inbox shows

public enum InboxVisibility {
    /// Errors are always shown (they never expire, whatever their dates say); an info notification stops showing when
    /// its `expiresAt` has passed — the server sweeps once a day, the phone does not wait for it.
    public static func isVisible(_ n: InboxNotification, now: Date) -> Bool {
        if n.isError { return true }
        guard let expiresAt = n.expiresAt else { return true }
        return expiresAt > now
    }

    /// Newest first; the errors stay on top of their day because they are the ones to act on.
    public static func ordered(_ list: [InboxNotification], now: Date) -> [InboxNotification] {
        list.filter { isVisible($0, now: now) }.sorted { a, b in
            if a.isError != b.isError { return a.isError }
            return (a.createdAt ?? .distantPast) > (b.createdAt ?? .distantPast)
        }
    }
}

// MARK: - The badge, the way the server counts it

public enum InboxUnread {
    /// Unread, visible notifications + received shares not seen yet, where a share whose notice is still unread counts
    /// ONCE: the notice stands for it. That is the server's own rule (`unread` in the answer), so the optimistic
    /// numbers the app shows between two readings agree with the next reading instead of jumping.
    public static func count(notifications: [InboxNotification], received: [ReceivedShare], now: Date) -> Int {
        let unreadNotices = notifications.filter { !$0.isRead && InboxVisibility.isVisible($0, now: now) }
        let announced = Set(unreadNotices.filter { $0.kind == "share_received" }.compactMap(\.entryId))
        let unseenAlone = received.filter { !$0.seen && !announced.contains($0.entryId) }
        return unreadNotices.count + unseenAlone.count
    }
}

// MARK: - «Riprova»

/// How «Riprova» is offered for an error.
public struct InboxRetryAction: Equatable, Sendable {
    /// «Riprova», «Riprova senza playlist», «Riprova comunque».
    public let label: String
    /// The playlist was the problem: the link goes again without it.
    public let dropsPlaylist: Bool
    /// false while the server keeps trying by itself: sending the link again is then a second choice.
    public let isPrimary: Bool
}

extension InboxNotification {
    /// nil for what is not an error (information has nothing to send again).
    public var retryAction: InboxRetryAction? {
        guard isError else { return nil }
        if data.reasonKind?.isPlaylistProblem == true {
            return InboxRetryAction(label: "Riprova senza playlist", dropsPlaylist: true, isPrimary: true)
        }
        if data.retrying {
            return InboxRetryAction(label: "Riprova comunque", dropsPlaylist: false, isPrimary: false)
        }
        return InboxRetryAction(label: "Riprova", dropsPlaylist: false, isPrimary: true)
    }

    /// The small line under an error: it never expires, and says how it will be closed.
    public var errorFootnote: String {
        data.retrying
            ? "il server riprova da solo: si chiude quando il link riesce"
            : "non scade: resta finché non la togli o il link riesce"
    }
}

extension InboxRetryAction {
    /// The line under the error after a successful «Riprova»: it says when the playlist was left out.
    public func sentNote(_ headline: String) -> String {
        dropsPlaylist ? "Rimandato senza playlist: \(headline)" : "Rimandato: \(headline)"
    }
}

/// What «Riprova» sends.
public struct InboxRetryRequest: Equatable, Sendable {
    public let url: String
    public let comment: String?
    public let options: ShareOptions
}

public enum InboxRetry {
    /// The link of the error, sent THE WAY IT WAS SENT: from this phone's own record of the share when it has one,
    /// else from what the server kept (`data.options`) — so a share that started on another device can be retried
    /// too. When the playlist was the problem it is left out (the recipients and the comment stay).
    /// nil when the error carries no link.
    public static func request(for notification: InboxNotification, local: ShareLogEntry?) -> InboxRetryRequest? {
        guard let source = notification.data.sourceUrl, !source.isBlank else { return nil }
        var comment: String?
        var options = ShareOptions.none
        if let local {
            comment = local.comment
            options = local.options
        } else if let server = notification.data.options {
            comment = server.comment
            options = server.shareOptions
        }
        if notification.data.reasonKind?.isPlaylistProblem == true { options.playlistId = nil }
        return InboxRetryRequest(url: source, comment: comment, options: options)
    }
}

// MARK: - Calls

public protocol InboxTransport: Sendable {
    func inbox(since: String?, limit: Int?) async throws -> InboxSnapshot
    func markRead(id: String) async throws
    func markAllRead() async throws
    func deleteNotification(id: String) async throws
    func markSeen(entryId: String) async throws
}

public enum PushEnvironment: String, Sendable {
    case development
    case production

    /// Xcode / `install-iphone.sh` builds (Debug) get a SANDBOX token; anything else a production one.
    public static var current: PushEnvironment {
        #if DEBUG
        return .development
        #else
        return .production
        #endif
    }
}

public protocol PushTransport: Sendable {
    func registerPushDevice(token: String, environment: PushEnvironment) async throws
    func unregisterPushDevice(token: String) async throws
}

extension MondropAPI: InboxTransport, PushTransport {
    public func inbox(since: String?, limit: Int?) async throws -> InboxSnapshot {
        var pairs: [(String, String)] = []
        if let since, !since.isBlank { pairs.append(("since", since)) }
        if let limit { pairs.append(("limit", String(min(max(limit, 1), 500)))) }
        let data = try await sendRequest(path: "/api/mondrop/inbox", timeout: 30, query: pairs)
        return try decodeBody(InboxSnapshot.self, from: data)
    }

    public func markRead(id: String) async throws {
        _ = try await sendRequest(path: "/api/mondrop/inbox/\(Self.encodeSongKey(id))/read", method: "POST", body: Data("{}".utf8), timeout: 20)
    }

    public func markAllRead() async throws {
        _ = try await sendRequest(path: "/api/mondrop/inbox/read-all", method: "POST", body: Data("{}".utf8), timeout: 20)
    }

    public func deleteNotification(id: String) async throws {
        _ = try await sendRequest(path: "/api/mondrop/inbox/\(Self.encodeSongKey(id))", method: "DELETE", timeout: 20)
    }

    public func markSeen(entryId: String) async throws {
        _ = try await sendRequest(path: "/api/mondrop/received/\(Self.encodeSongKey(entryId))/seen", method: "POST", body: Data("{}".utf8), timeout: 20)
    }

    public func registerPushDevice(token: String, environment: PushEnvironment) async throws {
        struct Body: Encodable { let token: String; let environment: String }
        let body = try JSONEncoder().encode(Body(token: token, environment: environment.rawValue))
        _ = try await sendRequest(path: "/api/mondrop/push/devices", method: "POST", body: body, timeout: 20)
    }

    public func unregisterPushDevice(token: String) async throws {
        struct Body: Encodable { let token: String }
        let body = try JSONEncoder().encode(Body(token: token))
        _ = try await sendRequest(path: "/api/mondrop/push/devices", method: "DELETE", body: body, timeout: 20)
    }
}
