// PlayRecorder.swift — glue between the tracker, the durable queue, the local numbers and the uploader.

import Foundation

@MainActor
public final class PlayRecorder {
    public static let shared = PlayRecorder(queue: .shared, store: .shared, uploader: .shared)

    private let queue: EventQueue
    private let store: OfflineStore
    private let uploader: EventUploader?
    private let journal: SessionJournal?
    private let clock: TrackerClock
    private let timeZone: () -> TimeZone

    /// The player feeds this one.
    public lazy var tracker: PlayTracker = PlayTracker(clock: clock, timeZone: timeZone, journal: journal) { [unowned self] event in
        self.record(event)
    }

    public init(
        queue: EventQueue,
        store: OfflineStore,
        uploader: EventUploader?,
        journal: SessionJournal? = FileSessionJournal(url: OfflineStore.defaultRoot().appendingPathComponent("play-session.json")),
        clock: TrackerClock = .system,
        timeZone: @escaping () -> TimeZone = { .current }
    ) {
        self.queue = queue
        self.store = store
        self.uploader = uploader
        self.journal = journal
        self.clock = clock
        self.timeZone = timeZone
        // A play event dropped because the queue was full will never be acknowledged: stop counting it as pending.
        queue.onDrop = { [weak store] record in
            if case .play(let event) = record { store?.settleAckedPlays([event]) }
        }
    }

    /// Durable first (the queue fsyncs), then the local numbers, then maybe an upload. A recovered session whose id is
    /// already queued is a no-op: it is neither queued nor counted twice.
    func record(_ event: PlayEvent) {
        do {
            if try queue.append(.play(event)) == .added, event.isCounted {
                store.bumpLocalPlay(songKey: event.songKey, at: event.startedAt)
            }
        } catch {
            // The disk refused the write: this listen is lost, but playing must never crash because of statistics.
        }
        uploader?.noteAppended()
    }

    /// Launch: a session cut short by a crash becomes its event now.
    public func recoverInterruptedSession() {
        tracker.recoverInterruptedSession()
    }

    public func checkpoint() { tracker.checkpoint() }

    public func applicationWillTerminate() { tracker.applicationWillTerminate() }
}
