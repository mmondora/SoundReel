// ios/MondropKit/BackendClient.swift
//
// `POST /api/share` (docs/share.md, docs/mondrop-inbox.md): the call the share sheet, the deep link and the inbox's
// «Riprova» all go through. Every field added in 2.10.0 is optional on both sides: an older server ignores them, an
// older response simply does not have them.

import Foundation

public struct ShareDeviceInfo: Codable {
    public let name: String?
    public let model: String?
    public let system: String?
    public let timeZone: String?

    public init(name: String? = nil, model: String? = nil, system: String? = nil, timeZone: String? = nil) {
        self.name = name
        self.model = model
        self.system = system
        self.timeZone = timeZone
    }
}

public struct ShareRequest: Codable {
    public let url: String
    public let comment: String?
    public let tags: [String]?
    public let channel: String
    public let user: String?
    public let sharedAt: String?
    public let device: ShareDeviceInfo?
    /// 2.10.0: absent = no playlist. A static playlist of the user; the songs of the link go in it.
    public let playlistId: String?
    /// 2.10.0: absent = nobody. A subset of the family, never the sender; the server shares the entry with them.
    public let shareWith: [String]?

    public init(
        url: String,
        comment: String? = nil,
        tags: [String]? = nil,
        channel: String = "ios",
        user: String? = nil,
        sharedAt: String? = nil,
        device: ShareDeviceInfo? = nil,
        playlistId: String? = nil,
        shareWith: [String]? = nil
    ) {
        self.url = url
        self.comment = comment
        self.tags = tags
        self.channel = channel
        self.user = user
        self.sharedAt = sharedAt
        self.device = device
        self.playlistId = playlistId
        // «nobody» is the field being absent, not an empty list.
        self.shareWith = (shareWith?.isEmpty == false) ? shareWith : nil
    }
}

/// What the server did with the playlist the user chose (`playlist` in the response).
public enum SharePlaylistResult: Equatable, Sendable {
    /// `added` songs went in now.
    case added(id: String, name: String, count: Int)
    /// The songs will go in when the analysis ends.
    case pending(id: String, name: String)
    /// The playlist could not be used; the link was saved all the same.
    case invalid(id: String?, reason: SharePlaylistProblem)
}

public enum SharePlaylistProblem: Equatable, Sendable {
    case notFound
    /// A dynamic playlist: the rule decides its songs.
    case dynamic
    /// Shared with the user, not theirs.
    case readOnly
    case other(String)

    init(serverValue: String) {
        switch serverValue.lowercased() {
        case "not_found": self = .notFound
        case "dynamic": self = .dynamic
        case "read_only": self = .readOnly
        default: self = .other(serverValue)
        }
    }
}

/// A recipient the server did not share with.
public struct ShareRejection: Equatable, Sendable {
    public let user: String
    /// `self` · `unknown_user`, or whatever a newer server says.
    public let reason: String

    public init(user: String, reason: String) {
        self.user = user
        self.reason = reason
    }
}

public struct ShareResponse: Decodable, Equatable, Sendable {
    public let success: Bool
    public let entryId: String?
    public let tags: [String]?
    public let status: String?
    public let error: String?
    public let kind: String?
    public let title: String?
    public let artist: String?
    /// nil = no playlist was asked for (or an older server).
    public let playlist: SharePlaylistResult?
    public let sharedWith: [String]
    public let rejected: [ShareRejection]

    public init(
        success: Bool, entryId: String? = nil, tags: [String]? = nil, status: String? = nil, error: String? = nil,
        kind: String? = nil, title: String? = nil, artist: String? = nil, playlist: SharePlaylistResult? = nil,
        sharedWith: [String] = [], rejected: [ShareRejection] = []
    ) {
        self.success = success
        self.entryId = entryId
        self.tags = tags
        self.status = status
        self.error = error
        self.kind = kind
        self.title = title
        self.artist = artist
        self.playlist = playlist
        self.sharedWith = sharedWith
        self.rejected = rejected
    }

    private enum CodingKeys: String, CodingKey {
        case success, entryId, tags, status, error, kind, title, artist, playlist, sharedWith, rejected
    }

    private struct PlaylistBody: Decodable {
        let id: String?
        let name: String?
        let error: String?
        let added: Added?

        enum Added: Decodable {
            case count(Int)
            case pending

            init(from decoder: Decoder) throws {
                let c = try decoder.singleValueContainer()
                if let n = try? c.decode(Int.self) {
                    self = .count(n)
                } else if let text = try? c.decode(String.self), text.lowercased() == "pending" {
                    self = .pending
                } else {
                    throw DecodingError.dataCorruptedError(in: c, debugDescription: "unknown playlist.added")
                }
            }
        }

        private enum CodingKeys: String, CodingKey { case id, name, error, added }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? nil
            name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil
            error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
            added = (try? c.decodeIfPresent(Added.self, forKey: .added)) ?? nil
        }

        var result: SharePlaylistResult? {
            if let error { return .invalid(id: id, reason: SharePlaylistProblem(serverValue: error)) }
            guard let id else { return nil }
            let shown = (name?.isBlank == false) ? name! : id
            switch added {
            case .count(let n)?: return .added(id: id, name: shown, count: n)
            case .pending?: return .pending(id: id, name: shown)
            case nil: return nil
            }
        }
    }

    private struct Rejection: Decodable {
        let user: String
        let reason: String?
    }

    /// Tolerant on purpose: this is the answer to a share the server has already accepted, and a field this build does
    /// not understand must not turn it into an error the user would answer by sending the link again.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        success = (try? c.decode(Bool.self, forKey: .success)) ?? false
        entryId = (try? c.decodeIfPresent(String.self, forKey: .entryId)) ?? nil
        tags = (try? c.decodeIfPresent([String].self, forKey: .tags)) ?? nil
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? nil
        error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? nil
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? nil
        artist = (try? c.decodeIfPresent(String.self, forKey: .artist)) ?? nil
        playlist = ((try? c.decodeIfPresent(PlaylistBody.self, forKey: .playlist)) ?? nil)?.result
        sharedWith = ((try? c.decodeIfPresent([LossyDecodable<String>].self, forKey: .sharedWith)) ?? nil)?.compactMap { $0.value } ?? []
        rejected = ((try? c.decodeIfPresent([LossyDecodable<Rejection>].self, forKey: .rejected)) ?? nil)?
            .compactMap { $0.value }
            .map { ShareRejection(user: $0.user, reason: $0.reason ?? "") } ?? []
    }
}

public enum BackendError: Error, CustomStringConvertible {
    case badUrl
    case missingApiKey
    case missingUser
    case transport(Error)
    case http(Int, String?)
    case decode(Error)

    public var description: String {
        switch self {
        case .badUrl: return "URL del backend non valido"
        case .missingApiKey: return "API key mancante — aprila in Impostazioni Mondrop"
        case .missingUser: return "Utente Authelia mancante — sceglilo in Impostazioni"
        case .transport(let e): return "Errore di rete: \(e.localizedDescription)"
        case .http(let code, let body): return "HTTP \(code)\(body.map { ": \($0)" } ?? "")"
        case .decode(let e): return "Risposta non valida: \(e.localizedDescription)"
        }
    }
}

/// What the share sheet, the deep link and the inbox's «Riprova» need: send a link with its options (a fake in tests).
public protocol ShareSending: Sendable {
    func share(url: String, comment: String?, tags: [String]?, options: ShareOptions) async throws -> ShareResponse
}

/// The two things the sheet lets the user choose besides the tags.
public struct ShareOptions: Equatable, Hashable, Sendable {
    /// nil = «Nessuna».
    public var playlistId: String?
    /// Family user ids, in family order; empty = nobody.
    public var shareWith: [String]

    public init(playlistId: String? = nil, shareWith: [String] = []) {
        self.playlistId = playlistId
        self.shareWith = shareWith
    }

    public static let none = ShareOptions()
}

public actor BackendClient: ShareSending {
    private let session: URLSession
    private let configProvider: @Sendable () -> MondropAPIConfig

    public init() {
        self.session = .shared
        self.configProvider = { MondropAPIConfig.current() }
    }

    /// For tests: a stubbed session and a fixed configuration, so nothing touches the network or `Settings`.
    init(session: URLSession, config: @escaping @Sendable () -> MondropAPIConfig) {
        self.session = session
        self.configProvider = config
    }

    /// Fast share: stub + queue on the server (Share Extension friendly).
    public func share(url: String, comment: String?, tags: [String]?) async throws -> ShareResponse {
        try await share(url: url, comment: comment, tags: tags, options: .none)
    }

    public func share(url: String, comment: String?, tags: [String]?, options: ShareOptions) async throws -> ShareResponse {
        let config = configProvider()
        let key = config.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw BackendError.missingApiKey }

        let user = config.user.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !user.isEmpty else { throw BackendError.missingUser }

        let base = config.baseURL.trimmedTrailingSlash
        guard let endpoint = URL(string: "\(base)/api/share") else {
            throw BackendError.badUrl
        }

        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(key, forHTTPHeaderField: "X-SoundReel-Key")
        req.timeoutInterval = 25
        #if os(macOS)
        let channel = "macos"
        #else
        let channel = "ios"
        #endif

        let sharedAt = ISO8601DateFormatter.mondrop.string(from: Date())
        let device = ShareDeviceInfo(
            name: Settings.deviceDisplayName(),
            model: Settings.deviceModel(),
            system: Settings.systemVersion(),
            timeZone: TimeZone.current.identifier
        )

        req.httpBody = try JSONEncoder().encode(
            ShareRequest(
                url: url,
                comment: comment,
                tags: tags,
                channel: channel,
                user: user,
                sharedAt: sharedAt,
                device: device,
                playlistId: options.playlistId,
                shareWith: options.shareWith
            )
        )

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw BackendError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw BackendError.http(-1, nil)
        }
        let bodyText = String(data: data, encoding: .utf8)
        guard (200..<300).contains(http.statusCode) else {
            throw BackendError.http(http.statusCode, bodyText)
        }

        do {
            return try JSONDecoder().decode(ShareResponse.self, from: data)
        } catch {
            throw BackendError.decode(error)
        }
    }
}

private extension ISO8601DateFormatter {
    static let mondrop: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = TimeZone.current
        return f
    }()
}
