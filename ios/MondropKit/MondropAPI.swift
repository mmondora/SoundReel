// MondropAPI.swift — playlists + sync endpoints (X-SoundReel-Key), contract: docs/mondrop-sync.md

import Foundation

public struct MondropPlaylist: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let songCount: Int
    public let createdAt: String?
    public let updatedAt: String?
    /// `static` | `dynamic` (docs/mondrop-stats.md §4); nil on an older backend = static.
    public let kind: String?
    /// Readable rule of a dynamic playlist, e.g. «Più ascoltate · 07:00–08:00 · ultimi 30 giorni».
    public let ruleSummary: String?

    /// Dynamic playlists are read-only on the phone: the rule decides which songs are in.
    public var isDynamic: Bool { kind?.lowercased() == "dynamic" }

    enum CodingKeys: String, CodingKey {
        case id, name, songCount, createdAt, updatedAt, kind, ruleSummary
    }

    public init(
        id: String, name: String, songCount: Int, createdAt: String? = nil, updatedAt: String? = nil,
        kind: String? = nil, ruleSummary: String? = nil
    ) {
        self.id = id
        self.name = name
        self.songCount = songCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.kind = kind
        self.ruleSummary = ruleSummary
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        songCount = (try? c.decodeIfPresent(Int.self, forKey: .songCount)) ?? 0   // a rule-built list may not carry it
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try? c.decodeIfPresent(String.self, forKey: .updatedAt)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        ruleSummary = try? c.decodeIfPresent(String.self, forKey: .ruleSummary)
    }
}

public enum MondropAPIError: Error, CustomStringConvertible, Equatable {
    case badUrl
    case missingApiKey
    case missingUser
    case http(Int, String?)
    case decode(String)
    case transport(String)

    public var description: String {
        switch self {
        case .badUrl: return "URL non valido"
        case .missingApiKey: return "Manca API key"
        case .missingUser: return "Manca utente Authelia"
        case .http(let c, let b): return "HTTP \(c)\(b.map { ": \($0.prefix(120))" } ?? "")"
        case .decode: return "Risposta non valida"
        case .transport(let message): return message
        }
    }
}

/// Where and as whom the app talks to the backend. Injected so tests never touch `Settings`.
public struct MondropAPIConfig: Sendable, Equatable {
    public var baseURL: String
    public var apiKey: String
    public var user: String

    public init(baseURL: String, apiKey: String, user: String) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.user = user
    }

    public static func current() -> MondropAPIConfig {
        MondropAPIConfig(
            baseURL: Settings.shared.backendBaseUrl,
            apiKey: Settings.shared.apiKey,
            user: Settings.shared.autheliaUsername
        )
    }

    /// Headers the proxy path (`downloadPath`) needs. NEVER sent to the media server.
    public var authHeaders: [String: String] {
        [
            "X-SoundReel-Key": apiKey.trimmingCharacters(in: .whitespacesAndNewlines),
            "X-SoundReel-User": user.trimmingCharacters(in: .whitespacesAndNewlines),
        ]
    }
}

/// What the sync / first-play logic needs from the backend (a fake in tests).
public protocol MondropAPIProtocol: Sendable {
    func listPlaylists() async throws -> [MondropPlaylist]
    func offlineManifest(playlistId: String) async throws -> OfflineManifest
    func prepare(playlistId: String, retryFailed: Bool) async throws -> OfflineManifest
    func net() async throws -> NetInfo
    func track(songKey: String) async throws -> OfflineTrack
    func requestDownload(songKey: String, priority: DownloadPriority) async throws -> DownloadAck
    func setSource(songKey: String, youtubeUrl: String) async throws
}

public final class MondropAPI: MondropAPIProtocol, @unchecked Sendable {
    private let session: URLSession
    private let configProvider: @Sendable () -> MondropAPIConfig

    public init(
        session: URLSession = .shared,
        config: @escaping @Sendable () -> MondropAPIConfig = { MondropAPIConfig.current() }
    ) {
        self.session = session
        self.configProvider = config
    }

    // MARK: - URL helpers

    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    )

    /// RFC 3986 unreserved (ASCII) only: `::`, `/`, `?`, `#` and non-ASCII letters inside a songKey are all escaped,
    /// so a key can never break out of its path segment.
    public static func encodeSongKey(_ songKey: String) -> String {
        songKey.addingPercentEncoding(withAllowedCharacters: unreserved) ?? songKey
    }

    public static func songPath(_ songKey: String, suffix: String = "") -> String {
        "/api/mondrop/songs/\(encodeSongKey(songKey))\(suffix)"
    }

    private func authedRequest(
        path: String,
        method: String = "GET",
        body: Data? = nil,
        timeout: TimeInterval = 120
    ) throws -> URLRequest {
        let cfg = configProvider()
        let key = cfg.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw MondropAPIError.missingApiKey }
        let user = cfg.user.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !user.isEmpty else { throw MondropAPIError.missingUser }
        let base = cfg.baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/ \n"))
        guard var comps = URLComponents(string: "\(base)\(path)") else { throw MondropAPIError.badUrl }
        var items = comps.queryItems ?? []
        items.append(URLQueryItem(name: "user", value: user))
        comps.queryItems = items
        guard let url = comps.url else { throw MondropAPIError.badUrl }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(key, forHTTPHeaderField: "X-SoundReel-Key")
        req.setValue(user, forHTTPHeaderField: "X-SoundReel-User")
        req.timeoutInterval = timeout
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    private func send(_ req: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled { throw error }
            throw MondropAPIError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw MondropAPIError.http(-1, nil) }
        guard (200..<300).contains(http.statusCode) else {
            throw MondropAPIError.http(http.statusCode, String(data: data, encoding: .utf8))
        }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw MondropAPIError.decode(String(describing: error))
        }
    }

    // MARK: - Endpoints

    public func listPlaylists() async throws -> [MondropPlaylist] {
        let data = try await send(try authedRequest(path: "/api/mondrop/playlists"))
        struct Wrap: Decodable { let playlists: [MondropPlaylist] }
        return try decode(Wrap.self, from: data).playlists
    }

    public func offlineManifest(playlistId: String) async throws -> OfflineManifest {
        let enc = Self.encodeSongKey(playlistId)
        let data = try await send(try authedRequest(path: "/api/mondrop/playlists/\(enc)/offline"))
        return try decode(OfflineManifest.self, from: data)
    }

    /// Starts the server-side preparation of every non-ready track; answers immediately with the manifest.
    public func prepare(playlistId: String, retryFailed: Bool = false) async throws -> OfflineManifest {
        let enc = Self.encodeSongKey(playlistId)
        let body = Data((retryFailed ? #"{"retryFailed":true}"# : "{}").utf8)
        let data = try await send(try authedRequest(path: "/api/mondrop/playlists/\(enc)/prepare", method: "POST", body: body))
        return try decode(OfflineManifest.self, from: data)
    }

    public func net() async throws -> NetInfo {
        let data = try await send(try authedRequest(path: "/api/mondrop/net", timeout: 5))
        return try decode(NetInfo.self, from: data)
    }

    /// One track, same object as in the manifest. Tolerates a `{ "track": {…} }` envelope too.
    public func track(songKey: String) async throws -> OfflineTrack {
        let data = try await send(try authedRequest(path: Self.songPath(songKey), timeout: 30))
        return try Self.decodeTrack(data)
    }

    static func decodeTrack(_ data: Data) throws -> OfflineTrack {
        let decoder = JSONDecoder()
        if let bare = try? decoder.decode(OfflineTrack.self, from: data) { return bare }
        struct Envelope: Decodable { let track: OfflineTrack? }
        if let wrapped = try? decoder.decode(Envelope.self, from: data), let track = wrapped.track { return track }
        throw MondropAPIError.decode("track")
    }

    public func requestDownload(songKey: String, priority: DownloadPriority) async throws -> DownloadAck {
        let body = Data(#"{"priority":"\#(priority.rawValue)"}"#.utf8)
        let data = try await send(
            try authedRequest(path: Self.songPath(songKey, suffix: "/download"), method: "POST", body: body, timeout: 30)
        )
        return try decode(DownloadAck.self, from: data)
    }

    public func setSource(songKey: String, youtubeUrl: String) async throws {
        struct Body: Encodable { let youtubeUrl: String }
        let body = try JSONEncoder().encode(Body(youtubeUrl: youtubeUrl))
        _ = try await send(try authedRequest(path: Self.songPath(songKey, suffix: "/source"), method: "PUT", body: body, timeout: 30))
    }

    /// Legacy (pre-sync) Spooty enqueue; the new flow uses `prepare` / `requestDownload`.
    public func enqueueSpooty(songKey: String) async throws {
        _ = try await send(
            try authedRequest(path: Self.songPath(songKey, suffix: "/spooty"), method: "POST", body: Data("{}".utf8))
        )
    }
}


// MARK: - Listening events + device events (docs/mondrop-stats.md §1–§2)

extension MondropAPI: EventTransport {
    private struct Batch<E: Encodable>: Encodable { let events: [E] }

    /// `POST /api/mondrop/plays` — idempotent by event id, max 500 per request.
    public func postPlays(_ events: [PlayEvent]) async throws -> BatchAck {
        try await postBatch(path: "/api/mondrop/plays", events: events)
    }

    /// `POST /api/mondrop/device-events` (e.g. `delete_songs`).
    public func postDeviceEvents(_ events: [DeviceEvent]) async throws -> BatchAck {
        try await postBatch(path: "/api/mondrop/device-events", events: events)
    }

    private func postBatch<E: Encodable>(path: String, events: [E]) async throws -> BatchAck {
        let body: Data
        do {
            body = try EventCoding.encoder().encode(Batch(events: events))
        } catch {
            throw MondropAPIError.decode("encode events: \(error)")
        }
        let data = try await send(try authedRequest(path: path, method: "POST", body: body, timeout: 30))
        // A 200 with an unreadable body still means "received": never re-send because of a decode problem.
        return (try? JSONDecoder().decode(BatchAck.self, from: data)) ?? BatchAck()
    }
}
