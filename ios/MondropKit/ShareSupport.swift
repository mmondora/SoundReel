// ShareSupport.swift — the small pure pieces the share sheet is made of (spec 2026-11-08-mondrop-share-inbox-design.md
// SH2–SH6): which links get a playlist picker, what the link preview says, who the sheet can share with, and the two
// files the sheet and the app exchange through the App Group (the playlists the sheet may offer, and what each link
// was sent with, so the inbox's «Riprova» can send it again the same way).
//
// Foundation only: MondropKit is compiled into the share extensions and the macOS targets.

import Foundation

// MARK: - Which links get a playlist picker

public enum MediaLinkClassifier {
    /// A domain and every subdomain of it (`music.youtube.com`, `m.youtube.com`, `vm.tiktok.com`…).
    static let domains = [
        "music.apple.com", "shazam.com", "youtube.com", "youtu.be", "soundcloud.com", "instagram.com", "tiktok.com",
    ]
    /// Spotify: the player and the short links only — the rest of spotify.com is not a track.
    static let exactHosts: Set<String> = ["open.spotify.com", "spotify.link"]

    /// Links that can hold songs: the sheet offers a playlist for these (SH4) and for nothing else. Reels and TikToks
    /// are in because they carry songs; ordinary web pages are not.
    public static func isMusicOrMedia(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().hasPrefix("spotify:") { return true }
        guard let url = URL(string: trimmed) else { return false }
        return isMusicOrMedia(url)
    }

    public static func isMusicOrMedia(_ url: URL) -> Bool {
        if url.scheme?.lowercased() == "spotify" { return true }
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              var host = url.host?.lowercased() else { return false }
        if host.hasSuffix(".") { host.removeLast() }
        if exactHosts.contains(host) { return true }
        return domains.contains { host == $0 || host.hasSuffix("." + $0) }
    }
}

// MARK: - The link preview

public struct LinkPreview: Equatable, Sendable {
    /// «open.spotify.com» (without «www.»).
    public let host: String
    /// What follows the host, cut to fit one or two lines.
    public let shortURL: String

    public static func make(_ url: URL, maxLength: Int = 56) -> LinkPreview {
        var host = url.host?.lowercased() ?? url.absoluteString
        if host.hasPrefix("www.") { host.removeFirst(4) }
        var rest = url.path
        if let query = url.query, !query.isEmpty { rest += "?" + query }
        if rest == "/" { rest = "" }
        let text = host + rest
        guard text.count > maxLength else { return LinkPreview(host: host, shortURL: text) }
        return LinkPreview(host: host, shortURL: String(text.prefix(maxLength - 1)) + "…")
    }
}

// MARK: - Who can be shared with

public enum ShareRecipients {
    /// The family: the three users of the house (`FAMILY_USERS` on the server).
    public static var family: [String] { Settings.autheliaUsers.map(\.id) }

    /// The others: «archi» and «sara» for mike. Never the sender.
    public static func available(for user: String, family: [String] = ShareRecipients.family) -> [String] {
        let me = user.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return family.filter { $0.lowercased() != me }
    }

    /// Only family ids that are allowed for this sender, each once, in family order.
    public static func sanitize(_ ids: [String], for user: String, family: [String] = ShareRecipients.family) -> [String] {
        let wanted = Set(ids.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() })
        return available(for: user, family: family).filter { wanted.contains($0.lowercased()) }
    }
}

// MARK: - App Group files

/// Where the app and the share extension meet. On a device that is the App Group container; where it does not exist
/// (the simulator, unit tests) a folder of the process' own Application Support.
public enum AppGroupFiles {
    public static func directory(fileManager: FileManager = .default) -> URL {
        if let group = fileManager.containerURL(forSecurityApplicationGroupIdentifier: Settings.appGroupId) { return group }
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? fileManager.temporaryDirectory
        return base.appendingPathComponent("Mondrop-group", isDirectory: true)
    }

    public static func url(_ name: String) -> URL { directory().appendingPathComponent(name) }

    static func write(_ data: Data, to url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

// MARK: - The playlists the sheet may offer (playlists-cache.json)

public struct CachedPlaylist: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// The app writes it (every opening, every sync); the sheet only reads it — a share extension has no time to wait for
/// the network, and the list changes rarely. Only playlists the user may add songs to are kept (`canEdit == true`:
/// their own static ones).
public final class PlaylistsCache: @unchecked Sendable {
    public static let shared = PlaylistsCache(url: AppGroupFiles.url("playlists-cache.json"))

    private struct File: Codable {
        var user: String
        var updatedAt: Date
        var playlists: [CachedPlaylist]
    }

    private let url: URL
    private let lock = NSLock()

    public init(url: URL) { self.url = url }

    /// Keeps the editable ones. Returns what was stored.
    @discardableResult
    public func store(_ playlists: [MondropPlaylist], user: String, at date: Date = Date()) -> [CachedPlaylist] {
        let editable = playlists
            .filter { $0.canEdit == true && !$0.isDynamic }
            .map { CachedPlaylist(id: $0.id, name: $0.name) }
        let file = File(user: user.lowercased(), updatedAt: date, playlists: editable)
        lock.lock(); defer { lock.unlock() }
        if let data = try? AppGroupFiles.encoder().encode(file) { AppGroupFiles.write(data, to: url) }
        return editable
    }

    /// nil = no usable cache (never written, unreadable, or written for another user: a renewed key may belong to
    /// someone else and their playlists must not be offered). An empty list means «the user has none to offer».
    public func load(forUser user: String) -> (playlists: [CachedPlaylist], updatedAt: Date)? {
        lock.lock(); defer { lock.unlock() }
        guard let data = try? Data(contentsOf: url),
              let file = try? AppGroupFiles.decoder().decode(File.self, from: data),
              file.user == user.lowercased() else { return nil }
        return (file.playlists, file.updatedAt)
    }

    public func clear() {
        lock.lock(); defer { lock.unlock() }
        try? FileManager.default.removeItem(at: url)
    }
}

// MARK: - What each link was sent with (share-log.json)

public struct ShareLogEntry: Codable, Equatable, Sendable {
    public var url: String
    public var comment: String?
    public var playlistId: String?
    public var shareWith: [String]
    public var sentAt: Date

    public var options: ShareOptions { ShareOptions(playlistId: playlistId, shareWith: shareWith) }
}

/// The inbox lists an error with the link that failed (`data.sourceUrl`) but not with the options it was sent with:
/// «Riprova» must send it again THE SAME WAY, so every share written from this phone leaves a line here. Small and
/// short-lived on purpose.
public final class ShareLog: @unchecked Sendable {
    public static let shared = ShareLog(url: AppGroupFiles.url("share-log.json"))
    static let capacity = 60
    static let maxAge: TimeInterval = 30 * 86_400

    private let url: URL
    private let lock = NSLock()

    public init(url: URL) { self.url = url }

    /// The same link spelled with and without tracking parameters is one link. The server canonicalises the URLs it
    /// stores (`?si=`, `utm_*`…), so the `sourceUrl` of an error may not be the exact string that was sent.
    public static func key(for url: String) -> String {
        guard var comps = URLComponents(string: url.trimmingCharacters(in: .whitespacesAndNewlines)) else { return url }
        comps.scheme = comps.scheme?.lowercased()
        comps.host = comps.host?.lowercased()
        comps.fragment = nil
        let noise: Set<String> = ["si", "igsh", "igshid", "fbclid", "gclid", "feature", "referrer", "mc_cid", "mc_eid", "ref"]
        let kept = (comps.queryItems ?? [])
            .filter { !noise.contains($0.name.lowercased()) && !$0.name.lowercased().hasPrefix("utm_") }
            .sorted { $0.name < $1.name }
        comps.queryItems = kept.isEmpty ? nil : kept
        var out = comps.string ?? url
        if out.hasSuffix("/") { out.removeLast() }
        return out
    }

    public func record(url sent: String, comment: String?, options: ShareOptions, at date: Date = Date()) {
        lock.lock(); defer { lock.unlock() }
        var entries = readLocked(now: date)
        let key = Self.key(for: sent)
        entries.removeAll { Self.key(for: $0.url) == key }
        entries.insert(
            ShareLogEntry(url: sent, comment: comment, playlistId: options.playlistId, shareWith: options.shareWith, sentAt: date),
            at: 0
        )
        if entries.count > Self.capacity { entries.removeLast(entries.count - Self.capacity) }
        if let data = try? AppGroupFiles.encoder().encode(entries) { AppGroupFiles.write(data, to: self.url) }
    }

    /// Something was shared from this phone (the app then knows a result will come back to the Posta).
    public var hasEntries: Bool {
        lock.lock(); defer { lock.unlock() }
        return !readLocked(now: Date()).isEmpty
    }

    public func lastEntry(forURL sent: String, now: Date = Date()) -> ShareLogEntry? {
        lock.lock(); defer { lock.unlock() }
        let key = Self.key(for: sent)
        return readLocked(now: now).first { Self.key(for: $0.url) == key }
    }

    private func readLocked(now: Date) -> [ShareLogEntry] {
        guard let data = try? Data(contentsOf: url),
              let entries = try? AppGroupFiles.decoder().decode([ShareLogEntry].self, from: data) else { return [] }
        return entries.filter { now.timeIntervalSince($0.sentAt) < Self.maxAge }
    }
}
