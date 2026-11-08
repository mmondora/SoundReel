// PlayEvents.swift — the wire models of docs/mondrop-stats.md §1–§2.
//
// The client records RAW FACTS and ships them in batches; the SERVER decides what counts as a "listen"
// (listenedMs ≥ min(30 s, 50 % of duration)), so the threshold changes without an app update.
// The one rule the client mirrors is `PlayCounting.isCounted`, only to keep local rankings right between syncs.

import Foundation

/// ISO 8601 in UTC, `2026-11-08T06:12:03Z`. Parsing also accepts fractional seconds (JS `toISOString()`).
public enum ISO {
    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return f
    }()

    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return f
    }()

    public static func string(_ date: Date) -> String { plain.string(from: date) }

    public static func parse(_ text: String?) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        return plain.date(from: text) ?? fractional.date(from: text)
    }
}

/// JSON the server sees (and the queue file stores): dates as `…Z` strings, sorted keys.
enum EventCoding {
    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, enc in
            var container = enc.singleValueContainer()
            try container.encode(ISO.string(date))
        }
        return encoder
    }

    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { dec in
            let container = try dec.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = ISO.parse(text) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "bad ISO date \(text)")
            }
            return date
        }
        return decoder
    }
}

public enum PlayCounting {
    /// The client records every session of at least this long (shorter ones are accidental taps).
    public static let minSessionMs = 3_000
    /// A listen counts after this long at most (or half of a shorter song).
    public static let countedCapMs = 30_000
    /// Hard ceiling accepted by the server for one session.
    public static let maxSessionMs = 86_400_000

    /// Same rule as the server: `listenedMs ≥ min(30 s, 50 % of durationMs)`; unknown duration → 30 s.
    public static func isCounted(listenedMs: Int, durationMs: Int?) -> Bool {
        var threshold = Double(countedCapMs)
        if let durationMs, durationMs > 0 { threshold = min(threshold, Double(durationMs) * 0.5) }
        return Double(listenedMs) >= threshold
    }

    /// Minutes EAST of UTC at that instant (`60` in Italian winter, `120` in summer): what the server needs to
    /// place a listen in "07–08 in the morning" by the phone's own clock, DST included.
    public static func tzOffsetMinutes(at date: Date, in timeZone: TimeZone = .current) -> Int {
        timeZone.secondsFromGMT(for: date) / 60
    }
}

public enum PlayOrigin: String, Codable, Sendable {
    /// A file on the phone.
    case local
    /// Streamed from the server (first play, or a skip-listed song).
    case stream
}

/// One listening session (docs/mondrop-stats.md §1).
public struct PlayEvent: Codable, Equatable, Sendable, Identifiable {
    /// Fresh UUID: resending the same event is safe, the server is idempotent by id.
    public let id: String
    public let songKey: String
    /// The REAL start, in UTC.
    public let startedAt: Date
    public let tzOffsetMin: Int
    /// Milliseconds really listened: pauses and seeks do not count.
    public let listenedMs: Int
    public let durationMs: Int?
    public let completed: Bool
    public let origin: PlayOrigin
    public let playlistId: String?

    public init(
        id: String, songKey: String, startedAt: Date, tzOffsetMin: Int, listenedMs: Int,
        durationMs: Int?, completed: Bool, origin: PlayOrigin, playlistId: String?
    ) {
        self.id = id
        self.songKey = songKey
        self.startedAt = startedAt
        self.tzOffsetMin = tzOffsetMin
        self.listenedMs = listenedMs
        self.durationMs = durationMs
        self.completed = completed
        self.origin = origin
        self.playlistId = playlistId
    }

    private enum CodingKeys: String, CodingKey {
        case id, songKey, startedAt, tzOffsetMin, listenedMs, durationMs, completed, origin, playlistId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        songKey = try c.decode(String.self, forKey: .songKey)
        startedAt = try c.decode(Date.self, forKey: .startedAt)
        tzOffsetMin = try c.decode(Int.self, forKey: .tzOffsetMin)
        listenedMs = try c.decode(Int.self, forKey: .listenedMs)
        durationMs = try c.decodeIfPresent(Int.self, forKey: .durationMs)
        completed = try c.decode(Bool.self, forKey: .completed)
        origin = try c.decode(PlayOrigin.self, forKey: .origin)
        playlistId = try c.decodeIfPresent(String.self, forKey: .playlistId)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(songKey, forKey: .songKey)
        try c.encode(startedAt, forKey: .startedAt)
        try c.encode(tzOffsetMin, forKey: .tzOffsetMin)
        try c.encode(listenedMs, forKey: .listenedMs)
        try c.encode(durationMs, forKey: .durationMs)   // explicit `null` when unknown, as in the contract
        try c.encode(completed, forKey: .completed)
        try c.encode(origin, forKey: .origin)
        try c.encode(playlistId, forKey: .playlistId)
    }

    /// Would the server count this as a listen?
    public var isCounted: Bool { PlayCounting.isCounted(listenedMs: listenedMs, durationMs: durationMs) }
}

/// `delete_songs` details (docs/mondrop-stats.md §2): what, when, why — the server logs the full list.
public struct DeleteSongsDetails: Codable, Equatable, Sendable {
    public struct Criteria: Codable, Equatable, Sendable {
        /// "Elimina le N meno ascoltate": the N that was asked for (nil for the other reasons).
        public let count: Int?
        public let olderThanDays: Int?
        /// "Libera X MB": the target. Extra key on top of the contract's example, kept for the audit trail.
        public let freeMB: Int?

        public init(count: Int?, olderThanDays: Int? = nil, freeMB: Int? = nil) {
            self.count = count
            self.olderThanDays = olderThanDays
            self.freeMB = freeMB
        }

        private enum CodingKeys: String, CodingKey { case count, olderThanDays, freeMB }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            count = try c.decodeIfPresent(Int.self, forKey: .count)
            olderThanDays = try c.decodeIfPresent(Int.self, forKey: .olderThanDays)
            freeMB = try c.decodeIfPresent(Int.self, forKey: .freeMB)
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(count, forKey: .count)                  // explicit null, like the contract's example
            try c.encode(olderThanDays, forKey: .olderThanDays)
            try c.encodeIfPresent(freeMB, forKey: .freeMB)
        }
    }

    public struct Song: Codable, Equatable, Sendable {
        public let songKey: String
        public let title: String
        public let artist: String
        public let bytes: Int
        public let plays: Int
        public let lastPlayedAt: Date?

        public init(songKey: String, title: String, artist: String, bytes: Int, plays: Int, lastPlayedAt: Date?) {
            self.songKey = songKey
            self.title = title
            self.artist = artist
            self.bytes = bytes
            self.plays = plays
            self.lastPlayedAt = lastPlayedAt
        }

        private enum CodingKeys: String, CodingKey { case songKey, title, artist, bytes, plays, lastPlayedAt }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            songKey = try c.decode(String.self, forKey: .songKey)
            title = try c.decode(String.self, forKey: .title)
            artist = try c.decode(String.self, forKey: .artist)
            bytes = try c.decode(Int.self, forKey: .bytes)
            plays = try c.decode(Int.self, forKey: .plays)
            lastPlayedAt = try c.decodeIfPresent(Date.self, forKey: .lastPlayedAt)
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(songKey, forKey: .songKey)
            try c.encode(title, forKey: .title)
            try c.encode(artist, forKey: .artist)
            try c.encode(bytes, forKey: .bytes)
            try c.encode(plays, forKey: .plays)
            try c.encode(lastPlayedAt, forKey: .lastPlayedAt)    // explicit null: never played
        }
    }

    /// manual | least_played | free_space
    public let reason: String
    public let criteria: Criteria
    /// 1 for a single song, 2 for a block (double confirmation).
    public let confirmations: Int
    public let count: Int
    public let bytes: Int
    public let songs: [Song]

    public init(reason: String, criteria: Criteria, confirmations: Int, count: Int, bytes: Int, songs: [Song]) {
        self.reason = reason
        self.criteria = criteria
        self.confirmations = confirmations
        self.count = count
        self.bytes = bytes
        self.songs = songs
    }
}

/// `POST /api/mondrop/device-events` item. `delete_songs` is the only type today.
public struct DeviceEvent: Codable, Equatable, Sendable, Identifiable {
    public static let deleteSongsType = "delete_songs"

    public let id: String
    public let type: String
    public let at: Date
    public let details: DeleteSongsDetails

    public init(id: String = UUID().uuidString, type: String = DeviceEvent.deleteSongsType, at: Date, details: DeleteSongsDetails) {
        self.id = id
        self.type = type
        self.at = at
        self.details = details
    }
}

/// `{ "accepted": 1, "duplicates": 0, "rejected": [{ "id": "…", "reason": "…" }] }`
public struct BatchAck: Decodable, Equatable, Sendable {
    public struct Rejection: Decodable, Equatable, Sendable {
        public let id: String
        public let reason: String
    }

    public let accepted: Int
    public let duplicates: Int
    public let rejected: [Rejection]

    public init(accepted: Int = 0, duplicates: Int = 0, rejected: [Rejection] = []) {
        self.accepted = accepted
        self.duplicates = duplicates
        self.rejected = rejected
    }

    private enum CodingKeys: String, CodingKey { case accepted, duplicates, rejected }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accepted = (try? c.decodeIfPresent(Int.self, forKey: .accepted)) ?? 0
        duplicates = (try? c.decodeIfPresent(Int.self, forKey: .duplicates)) ?? 0
        rejected = (try? c.decodeIfPresent([Rejection].self, forKey: .rejected)) ?? []
    }
}
