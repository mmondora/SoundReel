// QueueSnapshot.swift — the play queue, kept on the phone so that «Riprendi» still has something to resume after the system closed
// the app (spec 2026-11-08-mondrop-home-spotify-design.md H4). Until now the queue lived only in memory: an app closed in the
// background came back empty.
//
// What is kept is compact (key, title, artist, cover path of each song: no lyrics, no server state — the addresses and the state of a
// song are asked again at the first play), in a file; where the user was inside the current song is a few bytes kept apart, because
// that one changes every few seconds and the queue almost never does. It comes back PAUSED: the play is never automatic
// (Michele, 8 November: «il play non deve essere automatico»).

import Foundation

public struct QueueSnapshot: Codable, Equatable, Sendable {
    public struct Item: Codable, Equatable, Sendable {
        public let songKey: String
        public let title: String
        public let artist: String
        public let coverPath: String?
        public let coverURL: String?

        public init(songKey: String, title: String, artist: String, coverPath: String? = nil, coverURL: String? = nil) {
            self.songKey = songKey
            self.title = title
            self.artist = artist
            self.coverPath = coverPath
            self.coverURL = coverURL
        }
    }

    /// The most songs kept: a queue of the whole library would be a file of megabytes. A longer queue keeps a window around the song playing.
    public static let maxItems = 500
    /// How many songs before the current one a cut queue still keeps (to go back a few).
    static let keptBefore = 20

    public var items: [Item]
    public var index: Int
    public var label: String?
    public var playlistId: String?
    /// Where the user was inside the current song, in seconds. Not in the file: it has its own place (`QueueSnapshotStore`).
    public var positionSeconds: Double = 0
    public var durationSeconds: Double = 0

    enum CodingKeys: String, CodingKey { case items, index, label, playlistId }

    public init(items: [Item], index: Int, label: String? = nil, playlistId: String? = nil, positionSeconds: Double = 0, durationSeconds: Double = 0) {
        self.items = items
        self.index = index
        self.label = label
        self.playlistId = playlistId
        self.positionSeconds = positionSeconds
        self.durationSeconds = durationSeconds
    }

    /// The snapshot of a live queue; nil when there is nothing to keep. Never more than `maxItems` songs.
    public static func make(queue: [QueueItem], index: Int, label: String?, playlistId: String?) -> QueueSnapshot? {
        guard !queue.isEmpty else { return nil }
        let current = min(max(index, 0), queue.count - 1)
        var start = 0
        if queue.count > maxItems { start = max(0, min(current - keptBefore, queue.count - maxItems)) }
        let kept = queue[start..<min(queue.count, start + maxItems)].map {
            Item(songKey: $0.songKey, title: $0.title, artist: $0.artist, coverPath: $0.coverPath, coverURL: $0.coverURL)
        }
        return QueueSnapshot(items: kept, index: current - start, label: label, playlistId: playlistId)
    }

    /// The queue to give back to the player (songs without the server's view of them: the first play asks for it).
    public var queueItems: [QueueItem] {
        items.map { QueueItem(songKey: $0.songKey, title: $0.title, artist: $0.artist, coverURL: $0.coverURL, coverPath: $0.coverPath) }
    }

    /// Nil when there is nothing to resume; an index outside the list is brought back inside it, and a position that makes no sense is zero.
    func normalized() -> QueueSnapshot? {
        guard !items.isEmpty else { return nil }
        var fixed = self
        fixed.index = min(max(index, 0), items.count - 1)
        if !(positionSeconds.isFinite && positionSeconds >= 0) { fixed.positionSeconds = 0 }
        if !(durationSeconds.isFinite && durationSeconds >= 0) { fixed.durationSeconds = 0 }
        return fixed
    }
}

/// Where the queue is kept. Injected, so the tests use their own folder and their own `UserDefaults` suite.
public struct QueueSnapshotStore: @unchecked Sendable {
    private let fileURL: URL
    private let defaults: UserDefaults
    private let positionKey: String

    public init(
        directory: URL = OfflineStore.defaultRoot(),
        defaults: UserDefaults = .standard,
        positionKey: String = "mondrop.queue.position"
    ) {
        self.fileURL = directory.appendingPathComponent("queue.json")
        self.defaults = defaults
        self.positionKey = positionKey
    }

    private struct Position: Codable {
        let songKey: String
        let seconds: Double
        let duration: Double
    }

    /// What was kept, or nil (nothing kept, or a file that cannot be read: a damaged file is no queue, never a crash). The position is
    /// given back only if it is the position inside THE SONG THE QUEUE POINTS AT.
    public func load() -> QueueSnapshot? {
        guard let data = try? Data(contentsOf: fileURL),
              let stored = try? JSONDecoder().decode(QueueSnapshot.self, from: data),
              var snapshot = stored.normalized() else { return nil }
        if let raw = defaults.data(forKey: positionKey), let position = try? JSONDecoder().decode(Position.self, from: raw),
           position.songKey == snapshot.items[snapshot.index].songKey {
            snapshot.positionSeconds = position.seconds
            snapshot.durationSeconds = position.duration
        }
        return snapshot.normalized()
    }

    /// Keeps the queue (nil forgets it, and the position with it). Written whole and atomically: a crash in the middle leaves the old one.
    public func save(_ snapshot: QueueSnapshot?) {
        guard let snapshot else {
            try? FileManager.default.removeItem(at: fileURL)
            defaults.removeObject(forKey: positionKey)
            return
        }
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(snapshot).write(to: fileURL, options: .atomic)
        } catch {
            // Nothing to do about it: the queue still plays; it is only not resumed after a relaunch.
        }
    }

    /// Where the user is inside this song (a few bytes, kept often).
    public func save(position songKey: String, seconds: Double, duration: Double) {
        guard seconds.isFinite, seconds >= 0 else { return }
        let value = Position(songKey: songKey, seconds: seconds, duration: duration.isFinite ? max(duration, 0) : 0)
        if let data = try? JSONEncoder().encode(value) { defaults.set(data, forKey: positionKey) }
    }
}
