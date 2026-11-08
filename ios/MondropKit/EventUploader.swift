// EventUploader.swift — ships the queue to SoundReel "from time to time" (docs/mondrop-stats.md §1, decision D2).
//
// Flush rules: when the queue reaches 20 events, when the app goes to background (inside a background task),
// at launch, every 15 minutes while in foreground, and on demand ("Invia ora"). Batches of ≤ 200 (the server
// takes 500). An event leaves the queue ONLY after the server answered 200 — the server is idempotent by id, so
// a retry after a lost answer is safe. A failure backs off exponentially (30 s … 15 min); a 401/403 pauses
// uploading with a hint (invalid key) and keeps every event.

import Foundation

public protocol EventTransport: Sendable {
    func postPlays(_ events: [PlayEvent]) async throws -> BatchAck
    func postDeviceEvents(_ events: [DeviceEvent]) async throws -> BatchAck
}

/// `beginBackgroundTask` lives in UIKit, which the share extension cannot link: the app target provides it.
public protocol BackgroundTaskRunner: Sendable {
    /// Runs `work` while the app is allowed to finish what it started after going to background.
    func run(name: String, _ work: @escaping @Sendable () async -> Void) async
}

public struct NoBackgroundTask: BackgroundTaskRunner {
    public init() {}
    public func run(name: String, _ work: @escaping @Sendable () async -> Void) async { await work() }
}

public struct UploaderConfig: Sendable, Equatable {
    /// The server accepts up to 500 per request.
    public var batchSize = 200
    /// Flush as soon as this many events are waiting.
    public var threshold = 20
    public var foregroundInterval: TimeInterval = 15 * 60
    public var backoffBase: TimeInterval = 30
    public var backoffCap: TimeInterval = 15 * 60

    public init() {}
}

@MainActor
public final class EventUploader: ObservableObject {
    public enum Reason: Equatable, Sendable {
        case threshold, launch, timer, background, manual, keyChanged, deviceEvent
        /// "Invia ora" and a freshly issued key try again even during a backoff / an auth pause.
        var overridesPause: Bool { self == .manual || self == .keyChanged }
    }

    public enum Status: Equatable, Sendable {
        case idle
        case uploading
        case backoff(retryAt: Date, message: String)
        /// 401/403: the key is invalid. Events stay queued until a new key (or "Invia ora") works.
        case needsKey
    }

    private enum Failure: Error {
        case auth
        case transient(String)
    }

    public static let shared = EventUploader(
        queue: .shared,
        transport: MondropAPI(),
        store: .shared,
        clock: .real,
        backgroundRunner: NoBackgroundTask()
    )

    @Published public private(set) var pendingCount = 0
    @Published public private(set) var droppedCount = 0
    @Published public private(set) var lastUploadAt: Date?
    @Published public private(set) var status: Status = .idle
    /// Events the server refused (or that were poison on their own) since launch.
    @Published public private(set) var rejectedCount = 0

    public var backgroundRunner: BackgroundTaskRunner
    public let config: UploaderConfig

    private let queue: EventQueue
    private let transport: EventTransport
    private let store: OfflineStore
    private let clock: PreparationClock
    private var isFlushing = false
    private var consecutiveFailures = 0
    private var nextAttemptAt: Date?
    private var pendingFlush: Task<Void, Never>?
    private var timerTask: Task<Void, Never>?

    public init(
        queue: EventQueue,
        transport: EventTransport,
        store: OfflineStore,
        clock: PreparationClock = .real,
        config: UploaderConfig = UploaderConfig(),
        backgroundRunner: BackgroundTaskRunner = NoBackgroundTask()
    ) {
        self.queue = queue
        self.transport = transport
        self.store = store
        self.clock = clock
        self.config = config
        self.backgroundRunner = backgroundRunner
        refreshCounts()
    }

    // MARK: - Triggers

    /// A record was just appended: flush when the threshold is reached.
    public func noteAppended() {
        refreshCounts()
        guard queue.count >= config.threshold else { return }
        scheduleFlush(.threshold)
    }

    /// A deletion event should reach the server soon, whatever the threshold.
    public func noteDeviceEvent() {
        refreshCounts()
        scheduleFlush(.deviceEvent)
    }

    private func scheduleFlush(_ reason: Reason) {
        guard pendingFlush == nil else { return }
        pendingFlush = Task { [weak self] in
            await self?.flush(reason)
            self?.pendingFlush = nil
        }
    }

    /// For tests: wait for a flush scheduled by `noteAppended` / `noteDeviceEvent`.
    func waitForScheduledFlush() async {
        await pendingFlush?.value
    }

    public func startForegroundTimer() {
        guard timerTask == nil else { return }
        timerTask = Task { [weak self] in await self?.runTimer(cycles: nil) }
    }

    public func stopForegroundTimer() {
        timerTask?.cancel()
        timerTask = nil
    }

    /// Every `foregroundInterval` while in foreground. `cycles` bounds it for tests.
    func runTimer(cycles: Int?) async {
        var done = 0
        while !Task.isCancelled {
            do { try await clock.sleep(config.foregroundInterval) } catch { return }
            await flush(.timer)
            done += 1
            if let cycles, done >= cycles { return }
        }
    }

    /// A new key was issued (or pasted): the pause was about the OLD one.
    public func clearAuthPause() {
        if status == .needsKey { status = .idle }
        consecutiveFailures = 0
        nextAttemptAt = nil
    }

    // MARK: - Flush

    public func flush(_ reason: Reason) async {
        if reason == .background {
            // The OS gives a few seconds after the app is backgrounded: use them to empty the queue.
            await backgroundRunner.run(name: "SoundReel events") { [self] in
                await self.flushNow(.background)
            }
        } else {
            await flushNow(reason)
        }
    }

    private func flushNow(_ reason: Reason) async {
        refreshCounts()
        guard !isFlushing, queue.count > 0 else { return }
        if !reason.overridesPause {
            if status == .needsKey { return }
            if let nextAttemptAt, clock.now() < nextAttemptAt { return }
        }
        isFlushing = true
        status = .uploading
        defer { isFlushing = false }
        do {
            try await drain()
            consecutiveFailures = 0
            nextAttemptAt = nil
            status = .idle
        } catch is CancellationError {
            status = .idle                       // the OS ended the background time: nothing was lost, nothing to punish
        } catch Failure.auth {
            status = .needsKey
        } catch Failure.transient(let message) {
            consecutiveFailures += 1
            let delay = min(config.backoffCap, config.backoffBase * pow(2, Double(consecutiveFailures - 1)))
            let retryAt = clock.now().addingTimeInterval(delay)
            nextAttemptAt = retryAt
            status = .backoff(retryAt: retryAt, message: message)
        } catch {
            status = .idle
        }
        refreshCounts()
    }

    /// Device events first (the audit of deletions), then plays. Each batch is removed only after its 200.
    private func drain() async throws {
        var size = config.batchSize
        deviceLoop: while true {
            try Task.checkCancellation()
            let batch = queue.pendingDeviceEvents(limit: size)
            if batch.isEmpty { break deviceLoop }
            do {
                let ack = try await transport.postDeviceEvents(batch)
                acknowledged(ids: batch.map(\.id), plays: [], ack: ack)
                size = config.batchSize
            } catch {
                size = try handle(error, batchCount: batch.count, size: size) { self.dropPoison(ids: [batch[0].id], plays: []) }
            }
        }
        playLoop: while true {
            try Task.checkCancellation()
            let batch = queue.pendingPlays(limit: size)
            if batch.isEmpty { break playLoop }
            do {
                let ack = try await transport.postPlays(batch)
                acknowledged(ids: batch.map(\.id), plays: batch, ack: ack)
                size = config.batchSize
            } catch {
                size = try handle(error, batchCount: batch.count, size: size) { self.dropPoison(ids: [batch[0].id], plays: [batch[0]]) }
            }
        }
    }

    /// Returns the next batch size, or throws what ends this flush.
    private func handle(_ error: Error, batchCount: Int, size: Int, dropSingle: () -> Void) throws -> Int {
        if error is CancellationError { throw error }
        guard let api = error as? MondropAPIError else { throw Failure.transient(error.localizedDescription) }
        switch api {
        case .missingApiKey, .missingUser, .http(401, _), .http(403, _):
            throw Failure.auth
        case .http(400, _), .http(413, _), .http(422, _):
            // The server refuses the batch as a whole. Halve it until the culprit is alone, then drop only that one.
            if batchCount > 1 { return max(1, batchCount / 2) }
            dropSingle()
            return config.batchSize
        case .http(404, _), .http(405, _), .http(501, _):
            throw Failure.transient("il server non supporta ancora le statistiche")
        case .http(let code, _):
            throw Failure.transient("il server risponde HTTP \(code)")
        case .transport(let message):
            throw Failure.transient(message)
        case .badUrl, .decode:
            throw Failure.transient(api.description)
        }
    }

    /// 200 answered: every event of the batch (accepted, duplicate or rejected) is done with.
    private func acknowledged(ids: [String], plays: [PlayEvent], ack: BatchAck) {
        queue.remove(ids: Set(ids))
        store.settleAckedPlays(plays)
        rejectedCount += ack.rejected.count
        let now = clock.now()
        queue.markUploaded(at: now)
        lastUploadAt = now
        refreshCounts()
    }

    private func dropPoison(ids: [String], plays: [PlayEvent]) {
        queue.remove(ids: Set(ids))
        store.settleAckedPlays(plays)
        rejectedCount += ids.count
        refreshCounts()
    }

    public func refreshCounts() {
        pendingCount = queue.count
        droppedCount = queue.droppedCount
        lastUploadAt = queue.lastUploadAt ?? lastUploadAt
    }
}
