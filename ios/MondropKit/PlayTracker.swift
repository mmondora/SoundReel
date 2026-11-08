// PlayTracker.swift — turns what the player does into listening sessions.
//
// A plain state machine: the player feeds it facts (a song started, playing / not playing, duration known,
// song ended) and it emits ONE `PlayEvent` per session of at least 3 s. Time comes from an injected clock, so the
// rules are testable without AVPlayer. Call it from one thread (the main actor in the app).
//
// What counts as listened: only the wall-clock time during which audio was REALLY playing. Pauses, stalls
// (buffering) and seeks add nothing — a jump from 0:05 to 3:10 does not make 3 minutes of listening.
//
// Crash safety: the open session is checkpointed to a small journal file (every ~10 s while playing, and on every
// pause). At the next launch `recoverInterruptedSession()` turns a leftover journal into its event. The event id is
// fixed when the session starts, so a session that was already emitted before the crash is the SAME event again
// (the queue ignores a known id, the server is idempotent by id): never lost, never duplicated.

import Foundation

public struct TrackerClock: @unchecked Sendable {
    /// Wall clock: `startedAt` and the time-zone offset.
    public var now: () -> Date
    /// Monotonic seconds, used to measure how long audio played (immune to clock changes and DST).
    public var uptime: () -> TimeInterval

    public init(now: @escaping () -> Date, uptime: @escaping () -> TimeInterval) {
        self.now = now
        self.uptime = uptime
    }

    public static let system = TrackerClock(now: { Date() }, uptime: { ProcessInfo.processInfo.systemUptime })
}

/// Where the open session is checkpointed.
public protocol SessionJournal: AnyObject {
    func save(_ session: PlayTracker.Session)
    func load() -> PlayTracker.Session?
    func clear()
}

public final class FileSessionJournal: SessionJournal {
    private let url: URL

    public init(url: URL) {
        self.url = url
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    }

    public func save(_ session: PlayTracker.Session) {
        guard let data = try? EventCoding.encoder().encode(session) else { return }
        try? data.write(to: url, options: .atomic)
        OfflineStore.excludeFromBackup(url)
    }

    public func load() -> PlayTracker.Session? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? EventCoding.decoder().decode(PlayTracker.Session.self, from: data)
    }

    public func clear() {
        try? FileManager.default.removeItem(at: url)
    }
}

public final class PlayTracker {
    /// The open session, as checkpointed.
    public struct Session: Codable, Equatable, Sendable {
        public var id: String
        public var songKey: String
        public var startedAt: Date
        public var tzOffsetMin: Int
        /// Listened so far (as of the checkpoint).
        public var accumulatedMs: Int
        public var durationMs: Int?
        public var origin: PlayOrigin
        public var playlistId: String?
    }

    private struct Live {
        var session: Session
        /// Monotonic instant audio started playing; nil while paused / stalled / not started yet.
        var playingSince: TimeInterval?
        var lastCheckpoint: TimeInterval
    }

    private struct Params {
        let songKey: String
        let durationMs: Int?
        let origin: PlayOrigin
        let playlistId: String?
    }

    private let clock: TrackerClock
    private let timeZone: () -> TimeZone
    private let journal: SessionJournal?
    private let checkpointEvery: TimeInterval
    private let sink: (PlayEvent) -> Void
    private var live: Live?
    private var lastParams: Params?

    /// `sink` receives every finished session. It must make the event DURABLE (the queue appends it to a file)
    /// before returning: the journal is cleared right after.
    public init(
        clock: TrackerClock = .system,
        timeZone: @escaping () -> TimeZone = { .current },
        journal: SessionJournal? = nil,
        checkpointEvery: TimeInterval = 10,
        sink: @escaping (PlayEvent) -> Void
    ) {
        self.clock = clock
        self.timeZone = timeZone
        self.journal = journal
        self.checkpointEvery = checkpointEvery
        self.sink = sink
    }

    /// The session in progress (for tests and the journal).
    public var openSession: Session? { live.map { snapshot($0, at: clock.uptime()) } }

    public var isPlaying: Bool { live?.playingSince != nil }

    // MARK: - Facts from the player

    /// A song starts (any way: tap, next, previous, auto-advance). Closes the previous session first.
    public func begin(songKey: String, durationMs: Int?, origin: PlayOrigin, playlistId: String?) {
        finish(completed: false)
        let started = clock.now()
        let zone = timeZone()
        let session = Session(
            id: UUID().uuidString,
            songKey: songKey,
            startedAt: started,
            tzOffsetMin: PlayCounting.tzOffsetMinutes(at: started, in: zone),
            accumulatedMs: 0,
            durationMs: (durationMs ?? 0) > 0 ? durationMs : nil,
            origin: origin,
            playlistId: playlistId
        )
        live = Live(session: session, playingSince: nil, lastCheckpoint: clock.uptime())
        lastParams = Params(songKey: songKey, durationMs: session.durationMs, origin: origin, playlistId: playlistId)
        journal?.save(session)
    }

    /// Audio is really playing (true) or not (paused, stalled, interrupted, still loading).
    public func setPlaying(_ playing: Bool) {
        guard var l = live else { return }
        let now = clock.uptime()
        if playing {
            if l.playingSince == nil { l.playingSince = now }
            live = l
        } else if let since = l.playingSince {
            l.session.accumulatedMs += Self.ms(now - since)
            l.playingSince = nil
            live = l
            checkpoint()                       // a pause is the moment the app is most likely to be killed
        }
    }

    public func updateDuration(ms: Int) {
        guard var l = live, ms > 0, l.session.durationMs != ms else { return }
        l.session.durationMs = ms
        live = l
    }

    /// Called often (the player's time observer): checkpoints at most every `checkpointEvery` seconds.
    public func tick() {
        guard let l = live, clock.uptime() - l.lastCheckpoint >= checkpointEvery else { return }
        checkpoint()
    }

    /// Persists the open session now (app going to background, pause).
    public func checkpoint() {
        guard var l = live, let journal else { return }
        let now = clock.uptime()
        journal.save(snapshot(l, at: now))
        l.lastCheckpoint = now
        live = l
    }

    /// The song ended (`completed: true`) or was left (`false`). Emits the event when the session lasted ≥ 3 s.
    public func finish(completed: Bool) {
        guard let l = live else { return }
        live = nil
        emit(snapshot(l, at: clock.uptime()), completed: completed)
    }

    /// Same song again from the start ("previous" after 3 s): the first listen ends, a new one begins.
    public func restart() {
        guard let p = lastParams else { return }
        let wasPlaying = isPlaying
        begin(songKey: p.songKey, durationMs: live?.session.durationMs ?? p.durationMs, origin: p.origin, playlistId: p.playlistId)
        if wasPlaying { setPlaying(true) }
    }

    /// App termination: close what is open, it will not get another chance.
    public func applicationWillTerminate() {
        finish(completed: false)
    }

    /// Launch: a journal left behind by a crash / kill becomes its event (not completed), once.
    public func recoverInterruptedSession() {
        guard live == nil, let leftover = journal?.load() else { return }
        emit(leftover, completed: false)
    }

    // MARK: - Internals

    private func snapshot(_ l: Live, at now: TimeInterval) -> Session {
        var s = l.session
        if let since = l.playingSince { s.accumulatedMs += Self.ms(now - since) }
        return s
    }

    private func emit(_ s: Session, completed: Bool) {
        let listened = min(s.accumulatedMs, PlayCounting.maxSessionMs)
        defer { journal?.clear() }
        guard listened >= PlayCounting.minSessionMs else { return }   // a few seconds: a skip, not a listen
        sink(
            PlayEvent(
                id: s.id,
                songKey: s.songKey,
                startedAt: s.startedAt,
                tzOffsetMin: s.tzOffsetMin,
                listenedMs: listened,
                durationMs: s.durationMs,
                completed: completed,
                origin: s.origin,
                playlistId: s.playlistId
            )
        )
    }

    private static func ms(_ seconds: TimeInterval) -> Int {
        max(0, Int((seconds * 1000).rounded()))
    }
}
