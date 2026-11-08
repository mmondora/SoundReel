// EventQueue.swift — the ONE durable queue for play events and device events.
//
// JSON lines in Application Support (excluded from backup): one `{"k":"play"|"device","e":{…}}` per line.
// An event stays in the file until the server answered 200; offline nothing is lost. Appending a known id is a
// no-op, so a session recovered after a crash can never be queued twice.
//
// Bounded: at 5000 events the OLDEST are dropped (play events first — the audit trail of deleted songs is worth
// more than one listen) and a counter, shown in Settings, says how many.

import Foundation

public final class EventQueue: @unchecked Sendable {
    public enum Record: Equatable, Sendable {
        case play(PlayEvent)
        case device(DeviceEvent)

        public var id: String {
            switch self {
            case .play(let e): return e.id
            case .device(let e): return e.id
            }
        }

        public var isPlay: Bool {
            if case .play = self { return true }
            return false
        }
    }

    public enum AppendResult: Equatable, Sendable {
        case added
        /// The id is already queued: nothing was written.
        case duplicate
    }

    /// `{"k":"play","e":{…}}`
    private struct Line: Codable {
        let record: Record

        init(_ record: Record) { self.record = record }

        private enum CodingKeys: String, CodingKey { case k, e }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            switch try c.decode(String.self, forKey: .k) {
            case "play": record = .play(try c.decode(PlayEvent.self, forKey: .e))
            case "device": record = .device(try c.decode(DeviceEvent.self, forKey: .e))
            default: throw DecodingError.dataCorruptedError(forKey: .k, in: c, debugDescription: "unknown record kind")
            }
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch record {
            case .play(let e):
                try c.encode("play", forKey: .k)
                try c.encode(e, forKey: .e)
            case .device(let e):
                try c.encode("device", forKey: .k)
                try c.encode(e, forKey: .e)
            }
        }
    }

    private struct Meta: Codable {
        var dropped: Int = 0
        var lastUploadAt: Date?
    }

    public static let defaultCapacity = 5000

    public static let shared = EventQueue(directory: OfflineStore.defaultRoot())

    /// Called for every record dropped because the queue was full (outside the lock).
    public var onDrop: ((Record) -> Void)?

    public let capacity: Int
    private let directory: URL
    private let fm: FileManager
    private let lock = NSLock()
    private var records: [Record] = []
    private var ids = Set<String>()
    private var meta = Meta()

    public init(directory: URL, capacity: Int = EventQueue.defaultCapacity, fileManager: FileManager = .default) {
        self.directory = directory
        self.capacity = max(10, capacity)
        self.fm = fileManager
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        OfflineStore.excludeFromBackup(directory)
        load()
    }

    var queueURL: URL { directory.appendingPathComponent("event-queue.jsonl") }
    private var metaURL: URL { directory.appendingPathComponent("event-queue-meta.json") }

    // MARK: - Reading

    public var count: Int { lock.withLock { records.count } }
    public var playCount: Int { lock.withLock { records.filter(\.isPlay).count } }
    public var deviceCount: Int { lock.withLock { records.filter { !$0.isPlay }.count } }
    public var droppedCount: Int { lock.withLock { meta.dropped } }
    public var lastUploadAt: Date? { lock.withLock { meta.lastUploadAt } }

    public func contains(id: String) -> Bool { lock.withLock { ids.contains(id) } }

    /// Oldest first.
    public func pendingPlays(limit: Int) -> [PlayEvent] {
        lock.withLock {
            Array(records.compactMap { record -> PlayEvent? in
                if case .play(let e) = record { return e }
                return nil
            }.prefix(limit))
        }
    }

    public func pendingDeviceEvents(limit: Int) -> [DeviceEvent] {
        lock.withLock {
            Array(records.compactMap { record -> DeviceEvent? in
                if case .device(let e) = record { return e }
                return nil
            }.prefix(limit))
        }
    }

    // MARK: - Writing

    /// Durable on return (the line is fsync'ed). Throws when it could NOT be written — a caller about to delete
    /// files because of this event must then not delete them.
    @discardableResult
    public func append(_ record: Record) throws -> AppendResult {
        var dropped: [Record] = []
        let result: AppendResult = try lock.withLock {
            guard ids.insert(record.id).inserted else { return .duplicate }
            do {
                try appendLine(record)
            } catch {
                ids.remove(record.id)
                throw error
            }
            records.append(record)
            if records.count > capacity { dropped = trimLocked() }
            return .added
        }
        if let onDrop { dropped.forEach(onDrop) }
        return result
    }

    /// Removes records the server has answered for (accepted, duplicate or rejected).
    public func remove(ids removing: Set<String>) {
        guard !removing.isEmpty else { return }
        lock.withLock {
            let before = records.count
            records.removeAll { removing.contains($0.id) }
            ids.subtract(removing)
            if records.count != before { rewriteLocked() }
        }
    }

    public func markUploaded(at date: Date) {
        lock.withLock {
            meta.lastUploadAt = date
            saveMetaLocked()
        }
    }

    // MARK: - Capacity

    /// Down to 90 % of capacity in one rewrite, oldest play events first.
    private func trimLocked() -> [Record] {
        let target = Int(Double(capacity) * 0.9)
        var dropped: [Record] = []
        var remaining = records
        while remaining.count > target {
            if let i = remaining.firstIndex(where: \.isPlay) {
                dropped.append(remaining.remove(at: i))
            } else {
                dropped.append(remaining.removeFirst())   // only device events left: oldest goes
            }
        }
        records = remaining
        ids = Set(remaining.map(\.id))
        meta.dropped += dropped.count
        saveMetaLocked()
        rewriteLocked()
        return dropped
    }

    // MARK: - File

    private func load() {
        var needsRewrite = false
        if let data = try? Data(contentsOf: queueURL), !data.isEmpty {
            let decoder = EventCoding.decoder()
            if data.last != UInt8(ascii: "\n") { needsRewrite = true }     // crash mid-write: a partial last line
            for slice in data.split(separator: UInt8(ascii: "\n"), omittingEmptySubsequences: true) {
                guard let line = try? decoder.decode(Line.self, from: Data(slice)) else {
                    needsRewrite = true                                     // a torn line is skipped, never fatal
                    continue
                }
                if ids.insert(line.record.id).inserted { records.append(line.record) } else { needsRewrite = true }
            }
        }
        if let data = try? Data(contentsOf: metaURL), let decoded = try? EventCoding.decoder().decode(Meta.self, from: data) {
            meta = decoded
        }
        if needsRewrite { rewriteLocked() }
    }

    private func appendLine(_ record: Record) throws {
        var data = try EventCoding.encoder().encode(Line(record))
        data.append(UInt8(ascii: "\n"))
        if !fm.fileExists(atPath: queueURL.path) {
            guard fm.createFile(atPath: queueURL.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
            OfflineStore.excludeFromBackup(queueURL)
        }
        let handle = try FileHandle(forWritingTo: queueURL)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
        try handle.synchronize()
    }

    private func rewriteLocked() {
        let encoder = EventCoding.encoder()
        var data = Data()
        for record in records {
            if let line = try? encoder.encode(Line(record)) {
                data.append(line)
                data.append(UInt8(ascii: "\n"))
            }
        }
        try? data.write(to: queueURL, options: .atomic)
        OfflineStore.excludeFromBackup(queueURL)
    }

    private func saveMetaLocked() {
        guard let data = try? EventCoding.encoder().encode(meta) else { return }
        try? data.write(to: metaURL, options: .atomic)
        OfflineStore.excludeFromBackup(metaURL)
    }
}
