// SyncModels.swift — manifest / net / ack models of the sync contract (docs/mondrop-sync.md)
//
// Everything here is decoded defensively: the app must keep working against the OLD manifest
// (no `state`, no `mediaUrl`, no `version`, `entry_*` sources) and against fields the backend
// may add later. Unknown values never crash decoding.

import Foundation

/// Server-side life cycle of a track's file (contract: `state`).
public enum TrackState: String, Sendable, Equatable {
    case ready
    case preparing
    case failed
    case noSource = "no_source"
    case missing

    /// Tolerant: anything unknown behaves like `missing` (it just needs a `prepare`).
    public init(serverValue: String?) {
        switch serverValue?.trimmingCharacters(in: .whitespaces).lowercased() {
        case "ready": self = .ready
        case "preparing", "queued", "downloading": self = .preparing
        case "failed": self = .failed
        case "no_source": self = .noSource
        default: self = .missing
        }
    }
}

public struct OfflineTrack: Codable, Identifiable, Sendable, Equatable {
    public var id: String { songKey }
    public let songKey: String
    public let title: String
    public let artist: String
    /// Legacy (`ready` / `missing`). New clients use `resolvedState`.
    public let status: String?
    /// Raw server `state`; absent on the old manifest.
    public let state: String?
    public let source: String?
    /// Relative API path, always valid when the track is ready (needs auth, supports Range).
    public let downloadPath: String?
    /// Absolute HTTP URL on the media server, LAN only, never to be sent the API key.
    public let mediaUrl: String?
    /// Changes when the file changes (`<bytes>-<mtimeMs>`); equal version = nothing to download.
    public let version: String?
    public let bytes: Int?
    public let durationS: Int?
    public let error: String?
    public let spotifyUrl: String?
    public let entryId: String?
    public let canEnqueueSpooty: Bool
    public let coverUrl: String?
    public let lyrics: String?
    /// Counted listens of the user on ALL devices, ever (docs/mondrop-stats.md §3). nil on an older backend.
    public let plays: Int?
    /// ISO date of the last counted listen; nil = never played (or an older backend).
    public let lastPlayedAt: String?
    /// Album (the provider's spelling when known, else the mention's); nil when unknown or on an older backend (ADR-0013).
    public let album: String?
    /// Canonical genres, the «tipo» of the song; `[]` when unknown or on an older backend.
    public let genres: [String]
    /// Release year; nil when unknown or on an older backend. The decade is derived (`DecadeFilter.of(year:)`).
    public let year: Int?

    public var lastPlayedDate: Date? { ISO.parse(lastPlayedAt) }

    /// `state` when the server sent it, otherwise derived from the legacy `status`.
    public var resolvedState: TrackState {
        if let state, !state.isEmpty { return TrackState(serverValue: state) }
        return status?.lowercased() == "ready" ? .ready : .missing
    }

    public init(
        songKey: String,
        title: String = "",
        artist: String = "",
        status: String? = nil,
        state: String? = nil,
        source: String? = nil,
        downloadPath: String? = nil,
        mediaUrl: String? = nil,
        version: String? = nil,
        bytes: Int? = nil,
        durationS: Int? = nil,
        error: String? = nil,
        spotifyUrl: String? = nil,
        entryId: String? = nil,
        canEnqueueSpooty: Bool = false,
        coverUrl: String? = nil,
        lyrics: String? = nil,
        plays: Int? = nil,
        lastPlayedAt: String? = nil,
        album: String? = nil,
        genres: [String] = [],
        year: Int? = nil
    ) {
        self.songKey = songKey
        self.title = title.isEmpty ? songKey : title
        self.artist = artist
        self.status = status
        self.state = state
        self.source = source
        self.downloadPath = downloadPath
        self.mediaUrl = mediaUrl
        self.version = version
        self.bytes = bytes
        self.durationS = durationS
        self.error = error
        self.spotifyUrl = spotifyUrl
        self.entryId = entryId
        self.canEnqueueSpooty = canEnqueueSpooty
        self.coverUrl = coverUrl
        self.lyrics = lyrics
        self.plays = plays
        self.lastPlayedAt = lastPlayedAt
        self.album = Self.tidy(album)
        self.genres = Self.tidyList(genres)
        self.year = Self.plausibleYear(year)
    }

    private enum CodingKeys: String, CodingKey {
        case songKey, title, artist, status, state, source, downloadPath, mediaUrl, version
        case bytes, durationS, error, spotifyUrl, entryId, canEnqueueSpooty, coverUrl, lyrics
        case plays, lastPlayedAt, album, genres, year
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let key = try c.decode(String.self, forKey: .songKey)
        songKey = key
        let decodedTitle = try? c.decodeIfPresent(String.self, forKey: .title)
        title = (decodedTitle?.isEmpty == false) ? decodedTitle! : key
        artist = (try? c.decodeIfPresent(String.self, forKey: .artist)) ?? ""
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        state = try? c.decodeIfPresent(String.self, forKey: .state)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        downloadPath = try? c.decodeIfPresent(String.self, forKey: .downloadPath)
        mediaUrl = try? c.decodeIfPresent(String.self, forKey: .mediaUrl)
        version = try? c.decodeIfPresent(String.self, forKey: .version)
        bytes = Self.flexibleInt(c, .bytes)
        durationS = Self.flexibleInt(c, .durationS)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        spotifyUrl = try? c.decodeIfPresent(String.self, forKey: .spotifyUrl)
        entryId = try? c.decodeIfPresent(String.self, forKey: .entryId)
        canEnqueueSpooty = (try? c.decodeIfPresent(Bool.self, forKey: .canEnqueueSpooty)) ?? false
        coverUrl = try? c.decodeIfPresent(String.self, forKey: .coverUrl)
        lyrics = try? c.decodeIfPresent(String.self, forKey: .lyrics)
        plays = Self.flexibleInt(c, .plays)
        lastPlayedAt = try? c.decodeIfPresent(String.self, forKey: .lastPlayedAt)
        // 2.9.0 (ADR-0013): all three are optional — an older server simply does not send them.
        album = Self.tidy(try? c.decodeIfPresent(String.self, forKey: .album))
        genres = Self.decodeGenres(c)
        year = Self.plausibleYear(Self.flexibleInt(c, .year))
    }

    /// Collapses whitespace; blank → nil.
    static func tidy(_ text: String?) -> String? {
        guard let text else { return nil }
        let joined = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return joined.isEmpty ? nil : joined
    }

    /// Tidy, no blanks, no repeats, order kept.
    static func tidyList(_ items: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for item in items {
            guard let t = tidy(item), seen.insert(t).inserted else { continue }
            out.append(t)
        }
        return out
    }

    /// An array of names (anything that is not a string is skipped), or one bare name.
    private static func decodeGenres(_ c: KeyedDecodingContainer<CodingKeys>) -> [String] {
        if let items = try? c.decodeIfPresent([LossyDecodable<String>].self, forKey: .genres) {
            return tidyList(items.compactMap { $0.value })
        }
        if let single = try? c.decodeIfPresent(String.self, forKey: .genres) { return tidyList([single]) }
        return []
    }

    /// The server only keeps 1900…next year; anything outside is garbage and must not invent a decade.
    static func plausibleYear(_ year: Int?) -> Int? {
        guard let year, (1900...2099).contains(year) else { return nil }
        return year
    }

    private static func flexibleInt(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: key) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: key), d.isFinite { return Int(d.rounded()) }
        return nil
    }
}

/// Decodes an element or yields nil, so one malformed track never hides the whole playlist.
struct LossyDecodable<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

public struct OfflineManifest: Codable, Sendable, Equatable {
    public let playlistId: String
    public let name: String
    public let tracks: [OfflineTrack]
    public let user: String?
    /// A dynamic playlist (docs/mondrop-stats.md §4): its tracks are recomputed by the server at every request.
    public let dynamic: Bool
    public let generatedAt: String?

    public var generatedDate: Date? { ISO.parse(generatedAt) }

    public init(
        playlistId: String, name: String, tracks: [OfflineTrack], user: String? = nil,
        dynamic: Bool = false, generatedAt: String? = nil
    ) {
        self.playlistId = playlistId
        self.name = name
        self.tracks = tracks
        self.user = user
        self.dynamic = dynamic
        self.generatedAt = generatedAt
    }

    private enum CodingKeys: String, CodingKey { case playlistId, name, tracks, user, dynamic, generatedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        playlistId = try c.decode(String.self, forKey: .playlistId)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        let lossy = (try? c.decodeIfPresent([LossyDecodable<OfflineTrack>].self, forKey: .tracks)) ?? []
        tracks = lossy.compactMap { $0.value }
        user = try? c.decodeIfPresent(String.self, forKey: .user)
        dynamic = (try? c.decodeIfPresent(Bool.self, forKey: .dynamic)) ?? false
        generatedAt = try? c.decodeIfPresent(String.self, forKey: .generatedAt)
    }

    // Counts are derived from the tracks (the server sends them too, but they are redundant).
    public var readyCount: Int { tracks.filter { $0.resolvedState == .ready }.count }
    public var preparingCount: Int { tracks.filter { $0.resolvedState == .preparing }.count }
    public var failedCount: Int { tracks.filter { $0.resolvedState == .failed }.count }
    public var noSourceCount: Int { tracks.filter { $0.resolvedState == .noSource }.count }
    /// Contract compat: everything that is not ready.
    public var missingCount: Int { tracks.count - readyCount }
}

/// `GET /api/mondrop/net`
public struct NetInfo: Codable, Sendable, Equatable {
    public let viaCloudflare: Bool
    /// True when the request reached Traefik directly (split-horizon DNS): the media server is reachable.
    public let home: Bool

    public init(viaCloudflare: Bool, home: Bool) {
        self.viaCloudflare = viaCloudflare
        self.home = home
    }

    private enum CodingKeys: String, CodingKey { case viaCloudflare, home }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let cf = (try? c.decodeIfPresent(Bool.self, forKey: .viaCloudflare)) ?? false
        viaCloudflare = cf
        home = (try? c.decodeIfPresent(Bool.self, forKey: .home)) ?? !cf
    }
}

public enum DownloadPriority: String, Sendable {
    /// A track the user is waiting for: jumps the Sync queue on the server.
    case play
    case sync
}

/// `POST /api/mondrop/songs/:songKey/download`
public struct DownloadAck: Codable, Sendable, Equatable {
    public let ok: Bool
    public let state: String?
    public let track: OfflineTrack?

    public init(ok: Bool, state: String?, track: OfflineTrack?) {
        self.ok = ok
        self.state = state
        self.track = track
    }

    private enum CodingKeys: String, CodingKey { case ok, state, track }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? true
        state = try? c.decodeIfPresent(String.self, forKey: .state)
        track = try? c.decodeIfPresent(OfflineTrack.self, forKey: .track)
    }
}
