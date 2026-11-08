import XCTest
@testable import Mondrop

final class PlayCountingTests: XCTestCase {
    func testTheServerRuleMirroredLocally() {
        // counted = listenedMs ≥ min(30 s, 50 % of duration)
        XCTAssertFalse(PlayCounting.isCounted(listenedMs: 29_999, durationMs: 231_000))
        XCTAssertTrue(PlayCounting.isCounted(listenedMs: 30_000, durationMs: 231_000))
        XCTAssertTrue(PlayCounting.isCounted(listenedMs: 30_000, durationMs: nil), "unknown duration → 30 s")
        XCTAssertFalse(PlayCounting.isCounted(listenedMs: 29_999, durationMs: nil))
        XCTAssertFalse(PlayCounting.isCounted(listenedMs: 29_999, durationMs: 0), "0 is not a duration")
    }

    func testAShortSongCountsAtHalfItsLength() {
        XCTAssertFalse(PlayCounting.isCounted(listenedMs: 19_999, durationMs: 40_000))
        XCTAssertTrue(PlayCounting.isCounted(listenedMs: 20_000, durationMs: 40_000))
        XCTAssertFalse(PlayCounting.isCounted(listenedMs: 3_500, durationMs: 7_001), "half of 7.001 s is 3.5005 s")
        XCTAssertTrue(PlayCounting.isCounted(listenedMs: 3_501, durationMs: 7_001))
    }

    func testTzOffsetIsMinutesEastOfUtcAtThatInstantDstIncluded() throws {
        let rome = try XCTUnwrap(TimeZone(identifier: "Europe/Rome"))
        let winter = try XCTUnwrap(ISO.parse("2026-11-08T06:12:03Z"))
        let summer = try XCTUnwrap(ISO.parse("2026-07-08T06:12:03Z"))
        XCTAssertEqual(PlayCounting.tzOffsetMinutes(at: winter, in: rome), 60)
        XCTAssertEqual(PlayCounting.tzOffsetMinutes(at: summer, in: rome), 120)
        XCTAssertEqual(PlayCounting.tzOffsetMinutes(at: winter, in: try XCTUnwrap(TimeZone(identifier: "America/New_York"))), -300)
        XCTAssertEqual(PlayCounting.tzOffsetMinutes(at: summer, in: try XCTUnwrap(TimeZone(identifier: "America/New_York"))), -240)
        XCTAssertEqual(PlayCounting.tzOffsetMinutes(at: winter, in: try XCTUnwrap(TimeZone(identifier: "Asia/Kolkata"))), 330, "half-hour zones")
        XCTAssertEqual(PlayCounting.tzOffsetMinutes(at: winter, in: try XCTUnwrap(TimeZone(identifier: "UTC"))), 0)
    }

    func testIsoDatesAcceptFractionalSecondsButAreWrittenWithoutThem() throws {
        let plain = try XCTUnwrap(ISO.parse("2026-11-05T21:03:11Z"))
        let fractional = try XCTUnwrap(ISO.parse("2026-11-05T21:03:11.123Z"))
        XCTAssertEqual(fractional.timeIntervalSince(plain), 0.123, accuracy: 0.001)
        XCTAssertEqual(ISO.string(plain), "2026-11-05T21:03:11Z")
        XCTAssertNil(ISO.parse("ieri"))
        XCTAssertNil(ISO.parse(nil))
    }
}

final class PlayTrackerTests: XCTestCase {
    private var clock = FakeTrackerClock()
    private var events: [PlayEvent] = []
    private var journal = MemoryJournal()
    private let rome = TimeZone(identifier: "Europe/Rome")!

    override func setUp() {
        super.setUp()
        clock = FakeTrackerClock()
        events = []
        journal = MemoryJournal()
    }

    private func makeTracker(journal: SessionJournal? = nil, zone: TimeZone? = nil, checkpointEvery: TimeInterval = 10, sink: ((PlayEvent) -> Void)? = nil) -> PlayTracker {
        PlayTracker(
            clock: clock.clock,
            timeZone: { zone ?? self.rome },
            journal: journal ?? self.journal,
            checkpointEvery: checkpointEvery,
            sink: sink ?? { self.events.append($0) }
        )
    }

    // MARK: the event

    func testAnEventCarriesEveryFieldOfTheContract() throws {
        let tracker = makeTracker()
        let started = clock.wall
        tracker.begin(songKey: "bishop briggs::white flag", durationMs: 231_000, origin: .local, playlistId: "p1")
        tracker.setPlaying(true)
        clock.advance(183)
        tracker.finish(completed: true)

        let e = try XCTUnwrap(events.first)
        XCTAssertEqual(events.count, 1)
        XCTAssertNotNil(UUID(uuidString: e.id), "id = a fresh UUID")
        XCTAssertEqual(e.songKey, "bishop briggs::white flag")
        XCTAssertEqual(e.startedAt, started, "startedAt = the real start")
        XCTAssertEqual(e.tzOffsetMin, 60)
        XCTAssertEqual(e.listenedMs, 183_000)
        XCTAssertEqual(e.durationMs, 231_000)
        XCTAssertTrue(e.completed)
        XCTAssertEqual(e.origin, .local)
        XCTAssertEqual(e.playlistId, "p1")
    }

    func testAStreamedListenFromNoPlaylist() throws {
        let tracker = makeTracker()
        tracker.begin(songKey: "a", durationMs: nil, origin: .stream, playlistId: nil)
        tracker.setPlaying(true)
        clock.advance(40)
        tracker.finish(completed: false)
        let e = try XCTUnwrap(events.first)
        XCTAssertEqual(e.origin, .stream)
        XCTAssertNil(e.playlistId)
        XCTAssertNil(e.durationMs)
        XCTAssertFalse(e.completed)
    }

    func testEveryEventGetsItsOwnId() {
        let tracker = makeTracker()
        for _ in 0..<5 {
            tracker.begin(songKey: "a", durationMs: nil, origin: .local, playlistId: nil)
            tracker.setPlaying(true)
            clock.advance(10)
            tracker.finish(completed: false)
        }
        XCTAssertEqual(Set(events.map(\.id)).count, 5)
    }

    // MARK: what counts as listened

    func testPausesDoNotCount() {
        let tracker = makeTracker()
        tracker.begin(songKey: "a", durationMs: 200_000, origin: .local, playlistId: nil)
        tracker.setPlaying(true)
        clock.advance(10)
        tracker.setPlaying(false)                 // pause
        clock.advance(100)                        // …for a long time
        tracker.setPlaying(true)
        clock.advance(5)
        tracker.finish(completed: false)
        XCTAssertEqual(events.first?.listenedMs, 15_000)
    }

    func testSeekingDoesNotMakeListeningTime() {
        // 200 s song: 5 s from the start, jump to 3:10, 5 s, the song ends. The position went 0:05 → 3:10, the ears
        // heard 10 s. The tracker never sees positions, only time spent really playing.
        let tracker = makeTracker()
        tracker.begin(songKey: "a", durationMs: 200_000, origin: .local, playlistId: nil)
        tracker.setPlaying(true)
        clock.advance(5)
        // …seek happens here: AVPlayer keeps playing, nothing changes for the tracker…
        clock.advance(5)
        tracker.finish(completed: true)
        XCTAssertEqual(events.first?.listenedMs, 10_000)
        XCTAssertEqual(events.first?.completed, true)
    }

    func testBufferingStallsAndInterruptionsDoNotCount() {
        let tracker = makeTracker()
        tracker.begin(songKey: "a", durationMs: 200_000, origin: .stream, playlistId: nil)
        tracker.setPlaying(true)
        clock.advance(5)
        tracker.setPlaying(false)                 // timeControlStatus = waitingToPlayAtSpecifiedRate
        clock.advance(20)
        tracker.setPlaying(true)
        clock.advance(5)
        tracker.finish(completed: false)
        XCTAssertEqual(events.first?.listenedMs, 10_000)
    }

    func testTimeBeforePlaybackActuallyStartsDoesNotCount() {
        let tracker = makeTracker()
        tracker.begin(songKey: "a", durationMs: nil, origin: .stream, playlistId: nil)
        clock.advance(8)                          // "Preparo il brano…" / loading
        tracker.setPlaying(true)
        clock.advance(4)
        tracker.finish(completed: false)
        XCTAssertEqual(events.first?.listenedMs, 4_000)
    }

    func testRepeatedPlayingCallsDoNotRestartTheInterval() {
        let tracker = makeTracker()
        tracker.begin(songKey: "a", durationMs: nil, origin: .local, playlistId: nil)
        tracker.setPlaying(true)
        clock.advance(5)
        tracker.setPlaying(true)                  // KVO fired again
        clock.advance(5)
        tracker.finish(completed: false)
        XCTAssertEqual(events.first?.listenedMs, 10_000)
    }

    func testListenedTimeIsCappedAtTheServerMaximum() {
        let tracker = makeTracker()
        tracker.begin(songKey: "a", durationMs: nil, origin: .local, playlistId: nil)
        tracker.setPlaying(true)
        clock.advance(100_000)                    // 27 hours without a pause
        tracker.finish(completed: false)
        XCTAssertEqual(events.first?.listenedMs, PlayCounting.maxSessionMs)
    }

    // MARK: sessions

    func testSessionsUnderThreeSecondsEmitNothing() {
        let tracker = makeTracker()
        tracker.begin(songKey: "a", durationMs: nil, origin: .local, playlistId: nil)
        tracker.setPlaying(true)
        clock.advance(2.9)
        tracker.finish(completed: false)
        XCTAssertTrue(events.isEmpty, "a skip is not a listen")

        tracker.begin(songKey: "a", durationMs: nil, origin: .local, playlistId: nil)
        tracker.setPlaying(true)
        clock.advance(3.0)
        tracker.finish(completed: false)
        XCTAssertEqual(events.count, 1, "exactly 3 s is recorded")
    }

    func testANewSongClosesThePreviousSession() {
        let tracker = makeTracker()
        tracker.begin(songKey: "first", durationMs: nil, origin: .local, playlistId: "p")
        tracker.setPlaying(true)
        clock.advance(10)
        tracker.begin(songKey: "second", durationMs: nil, origin: .local, playlistId: "p")   // skipped to the next
        XCTAssertEqual(events.map(\.songKey), ["first"])
        XCTAssertEqual(events.first?.listenedMs, 10_000)
        XCTAssertEqual(events.first?.completed, false)

        tracker.setPlaying(true)
        clock.advance(5)
        tracker.finish(completed: true)
        XCTAssertEqual(events.map(\.songKey), ["first", "second"])
    }

    func testTerminationClosesTheOpenSession() {
        let tracker = makeTracker()
        tracker.begin(songKey: "a", durationMs: nil, origin: .local, playlistId: nil)
        tracker.setPlaying(true)
        clock.advance(20)
        tracker.applicationWillTerminate()
        XCTAssertEqual(events.first?.listenedMs, 20_000)
        XCTAssertNil(tracker.openSession)
    }

    func testRestartingTheSameSongIsANewListen() {
        let tracker = makeTracker()
        tracker.begin(songKey: "a", durationMs: 200_000, origin: .local, playlistId: "p")
        tracker.setPlaying(true)
        clock.advance(10)
        tracker.restart()                          // "previous" after 3 s: back to the start
        clock.advance(5)
        tracker.finish(completed: false)

        XCTAssertEqual(events.map(\.listenedMs), [10_000, 5_000])
        XCTAssertEqual(Set(events.map(\.id)).count, 2)
        XCTAssertEqual(events.map(\.songKey), ["a", "a"])
        XCTAssertEqual(events.last?.playlistId, "p")
        XCTAssertEqual(events.last?.durationMs, 200_000)
    }

    func testDurationLearnedAfterTheStartEndsUpInTheEvent() {
        let tracker = makeTracker()
        tracker.begin(songKey: "a", durationMs: nil, origin: .stream, playlistId: nil)
        tracker.setPlaying(true)
        clock.advance(40)
        tracker.updateDuration(ms: 200_000)
        tracker.finish(completed: false)
        XCTAssertEqual(events.first?.durationMs, 200_000)
    }

    func testEventsBeforeAnySongAreIgnored() {
        let tracker = makeTracker()
        tracker.setPlaying(true)
        tracker.updateDuration(ms: 1000)
        tracker.tick()
        tracker.finish(completed: true)
        XCTAssertTrue(events.isEmpty)
        XCTAssertNil(tracker.openSession)
    }

    // MARK: time zone

    func testTzOffsetIsTheOneAtTheStartNotAtTheEnd() throws {
        // Italy goes to summer time at 01:00 UTC on 2026-03-29. A song that starts at 00:59 UTC (UTC+1) and ends after
        // the change was started in "+60", whatever the offset is when it ends.
        clock.wall = try XCTUnwrap(ISO.parse("2026-03-29T00:59:00Z"))
        let tracker = makeTracker()
        tracker.begin(songKey: "a", durationMs: nil, origin: .local, playlistId: nil)
        tracker.setPlaying(true)
        clock.advance(300)
        tracker.finish(completed: false)
        XCTAssertEqual(events.first?.tzOffsetMin, 60)

        clock.wall = try XCTUnwrap(ISO.parse("2026-03-29T01:01:00Z"))
        tracker.begin(songKey: "a", durationMs: nil, origin: .local, playlistId: nil)
        tracker.setPlaying(true)
        clock.advance(60)
        tracker.finish(completed: false)
        XCTAssertEqual(events.last?.tzOffsetMin, 120)
    }

    func testTheOffsetFollowsThePhonesCurrentZone() throws {
        let tracker = makeTracker(zone: try XCTUnwrap(TimeZone(identifier: "Asia/Kolkata")))
        tracker.begin(songKey: "a", durationMs: nil, origin: .local, playlistId: nil)
        tracker.setPlaying(true)
        clock.advance(10)
        tracker.finish(completed: false)
        XCTAssertEqual(events.first?.tzOffsetMin, 330)
    }

    // MARK: crash recovery

    func testACrashedSessionIsRecoveredOnceWithTheSameIdAndStart() throws {
        let first = makeTracker()
        first.begin(songKey: "a::b", durationMs: 231_000, origin: .stream, playlistId: "p1")
        first.setPlaying(true)
        clock.advance(20)
        first.checkpoint()
        let open = try XCTUnwrap(first.openSession)
        // …the app is killed here: `first` is never told…

        var recovered: [PlayEvent] = []
        let second = makeTracker(sink: { recovered.append($0) })   // next launch, same journal file
        second.recoverInterruptedSession()

        let e = try XCTUnwrap(recovered.first)
        XCTAssertEqual(recovered.count, 1)
        XCTAssertEqual(e.id, open.id, "same id: if it had been emitted already, it is the SAME event")
        XCTAssertEqual(e.startedAt, open.startedAt)
        XCTAssertEqual(e.songKey, "a::b")
        XCTAssertEqual(e.listenedMs, 20_000)
        XCTAssertFalse(e.completed)
        XCTAssertEqual(e.origin, .stream)
        XCTAssertEqual(e.playlistId, "p1")
        XCTAssertEqual(e.durationMs, 231_000)

        second.recoverInterruptedSession()
        XCTAssertEqual(recovered.count, 1, "recovered once: the journal is cleared")
        XCTAssertNil(journal.saved)
    }

    func testRecoveryKeepsWhatWasCheckpointedAndLosesAtMostTheLastInterval() throws {
        let first = makeTracker()
        first.begin(songKey: "a", durationMs: nil, origin: .local, playlistId: nil)
        first.setPlaying(true)
        clock.advance(20)
        first.tick()                               // 20 s ≥ 10 s since the begin: checkpointed
        clock.advance(4)                           // …4 more seconds, then the kill
        var recovered: [PlayEvent] = []
        makeTracker(sink: { recovered.append($0) }).recoverInterruptedSession()
        XCTAssertEqual(recovered.first?.listenedMs, 20_000)
    }

    func testAPausedSessionIsCheckpointedAtThePause() {
        let first = makeTracker()
        first.begin(songKey: "a", durationMs: nil, origin: .local, playlistId: nil)
        first.setPlaying(true)
        clock.advance(30)
        first.setPlaying(false)                    // pause: the moment an app is most likely to be killed
        var recovered: [PlayEvent] = []
        makeTracker(sink: { recovered.append($0) }).recoverInterruptedSession()
        XCTAssertEqual(recovered.first?.listenedMs, 30_000)
    }

    func testANormalCloseLeavesNothingToRecover() {
        let tracker = makeTracker()
        tracker.begin(songKey: "a", durationMs: nil, origin: .local, playlistId: nil)
        tracker.setPlaying(true)
        clock.advance(30)
        tracker.finish(completed: true)
        XCTAssertNil(journal.saved)

        var recovered: [PlayEvent] = []
        makeTracker(sink: { recovered.append($0) }).recoverInterruptedSession()
        XCTAssertTrue(recovered.isEmpty)
        XCTAssertEqual(events.count, 1)
    }

    func testACrashRightAfterTheEventWasQueuedYieldsTheSameEventNotANewOne() throws {
        // The event was emitted (queued durably) but the app died before the journal was cleared.
        journal.failToClear = true
        let first = makeTracker()
        first.begin(songKey: "a", durationMs: nil, origin: .local, playlistId: nil)
        first.setPlaying(true)
        clock.advance(30)
        first.checkpoint()                         // the journal holds the last checkpoint (≤ 10 s old in real life)
        first.finish(completed: true)
        let emitted = try XCTUnwrap(events.first)

        journal.failToClear = false
        var recovered: [PlayEvent] = []
        makeTracker(sink: { recovered.append($0) }).recoverInterruptedSession()

        XCTAssertEqual(recovered.first?.id, emitted.id, "the queue ignores a known id, the server is idempotent: no duplicate")
    }

    func testAShortRecoveredSessionIsDropped() {
        let first = makeTracker()
        first.begin(songKey: "a", durationMs: nil, origin: .local, playlistId: nil)
        first.setPlaying(true)
        clock.advance(2)
        first.checkpoint()
        var recovered: [PlayEvent] = []
        makeTracker(sink: { recovered.append($0) }).recoverInterruptedSession()
        XCTAssertTrue(recovered.isEmpty)
        XCTAssertNil(journal.saved)
    }

    func testRecoveryNeverTouchesALiveSession() {
        let old = makeTracker()
        old.begin(songKey: "old", durationMs: nil, origin: .local, playlistId: nil)
        old.setPlaying(true)
        clock.advance(30)
        old.checkpoint()

        var recovered: [PlayEvent] = []
        let live = makeTracker(sink: { recovered.append($0) })
        live.begin(songKey: "live", durationMs: nil, origin: .local, playlistId: nil)
        live.recoverInterruptedSession()           // a late call must not steal or duplicate the live one
        XCTAssertTrue(recovered.isEmpty)
        XCTAssertEqual(live.openSession?.songKey, "live")
    }

    func testCheckpointsAreThrottledButPausesAreImmediate() {
        let tracker = makeTracker()
        tracker.begin(songKey: "a", durationMs: nil, origin: .local, playlistId: nil)
        XCTAssertEqual(journal.saveCount, 1, "begin writes the journal")
        tracker.setPlaying(true)
        for _ in 0..<19 {                          // the player's 0.5 s observer for 9.5 s
            clock.advance(0.5)
            tracker.tick()
        }
        XCTAssertEqual(journal.saveCount, 1, "no write inside the 10 s window")
        clock.advance(0.5)
        tracker.tick()
        XCTAssertEqual(journal.saveCount, 2, "10 s: one checkpoint")
        tracker.setPlaying(false)
        XCTAssertEqual(journal.saveCount, 3, "a pause checkpoints at once")
    }

    func testTheJournalFileRoundTrips() throws {
        let dir = try TestSupport.tempDir("journal")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let file = FileSessionJournal(url: dir.appendingPathComponent("play-session.json"))
        let session = PlayTracker.Session(
            id: "id-1", songKey: "a::b", startedAt: clock.wall, tzOffsetMin: 60, accumulatedMs: 12_000,
            durationMs: nil, origin: .stream, playlistId: nil
        )
        XCTAssertNil(file.load())
        file.save(session)
        XCTAssertEqual(file.load(), session)
        file.clear()
        XCTAssertNil(file.load())
    }
}
