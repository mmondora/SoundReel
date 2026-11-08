import XCTest
@testable import Mondrop

@MainActor
final class EventUploaderTests: XCTestCase {
    private struct Rig {
        let queue: EventQueue
        let store: OfflineStore
        let transport: FakeEventTransport
        let clock: FakeClock
        let runner: FakeBackgroundRunner
        let uploader: EventUploader
        let dir: URL
    }

    private func rig(config: UploaderConfig = UploaderConfig()) throws -> Rig {
        let dir = try TestSupport.tempDir("uploader")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let queue = EventQueue(directory: dir.appendingPathComponent("queue"))
        let store = OfflineStore(root: dir.appendingPathComponent("store"))
        let transport = FakeEventTransport()
        let clock = FakeClock()
        let runner = FakeBackgroundRunner()
        let uploader = EventUploader(queue: queue, transport: transport, store: store, clock: clock.clock, config: config, backgroundRunner: runner)
        return Rig(queue: queue, store: store, transport: transport, clock: clock, runner: runner, uploader: uploader, dir: dir)
    }

    private func fill(_ queue: EventQueue, plays: Int, prefix: String = "p") throws {
        for i in 1...max(1, plays) where plays > 0 { try queue.append(.play(TestSupport.playEvent("\(prefix)\(i)"))) }
    }

    // MARK: batching, order, "leaves the queue only after a 200"

    func testNothingQueuedMeansNoRequest() async throws {
        let r = try rig()
        await r.uploader.flush(.manual)
        XCTAssertTrue(r.transport.order.isEmpty)
        XCTAssertEqual(r.uploader.status, .idle)
    }

    func testBatchesOf200AndEachLeavesTheQueueOnlyAfterItsAnswer() async throws {
        let r = try rig()
        try fill(r.queue, plays: 450)
        var queued: [Int] = []
        r.transport.onPlays = { events in
            queued.append(r.queue.count)                         // what is still queued WHILE the request is in flight
            return BatchAck(accepted: events.count)
        }

        await r.uploader.flush(.manual)

        XCTAssertEqual(r.transport.playCalls.map(\.count), [200, 200, 50], "≤ 200 per batch (the server takes 500)")
        XCTAssertEqual(queued, [450, 250, 50], "a batch is removed only after its own 200")
        XCTAssertEqual(r.queue.count, 0)
        XCTAssertEqual(r.transport.playCalls.first?.first, "p1", "oldest first")
        XCTAssertEqual(r.uploader.pendingCount, 0)
        XCTAssertEqual(r.uploader.status, .idle)
        XCTAssertNotNil(r.uploader.lastUploadAt)
    }

    func testDeviceEventsGoBeforePlays() async throws {
        let r = try rig()
        try r.queue.append(.play(TestSupport.playEvent("p1")))
        try r.queue.append(.device(TestSupport.deviceEvent("d1")))
        try r.queue.append(.play(TestSupport.playEvent("p2")))
        await r.uploader.flush(.manual)
        XCTAssertEqual(r.transport.order, ["device", "plays"])
        XCTAssertEqual(r.transport.deviceCalls, [["d1"]])
        XCTAssertEqual(r.transport.playCalls, [["p1", "p2"]])
    }

    func testAFailedRequestKeepsEveryEvent() async throws {
        let r = try rig()
        try fill(r.queue, plays: 5)
        r.transport.onPlays = { _ in throw MondropAPIError.http(500, "boom") }
        await r.uploader.flush(.manual)
        XCTAssertEqual(r.queue.count, 5, "nothing leaves the queue without a 200")
        XCTAssertEqual(r.uploader.pendingCount, 5)
        guard case .backoff = r.uploader.status else { return XCTFail("expected backoff, got \(r.uploader.status)") }
        XCTAssertNil(r.uploader.lastUploadAt)
    }

    func testTheSameEventsAreResentAfterALostAnswer() async throws {
        // The server received the batch but the answer never arrived (transport error): the retry sends the SAME ids.
        let r = try rig()
        try fill(r.queue, plays: 3)
        var first = true
        r.transport.onPlays = { events in
            if first { first = false; throw MondropAPIError.transport("rete persa") }
            return BatchAck(accepted: 0, duplicates: events.count)       // the server already has them
        }
        await r.uploader.flush(.manual)
        await r.uploader.flush(.manual)
        let calls = r.transport.playCalls
        XCTAssertEqual(calls.count, 2, "the second flush must retry")
        XCTAssertEqual(calls.first, calls.last, "idempotent by id: resending is safe")
        XCTAssertEqual(r.queue.count, 0, "a duplicate answer is a 200: the events are done")
    }

    func testRejectedEventsInA200AreDroppedToo() async throws {
        let r = try rig()
        try fill(r.queue, plays: 3)
        r.transport.onPlays = { _ in BatchAck(accepted: 2, duplicates: 0, rejected: [.init(id: "p2", reason: "bad_start")]) }
        await r.uploader.flush(.manual)
        XCTAssertEqual(r.queue.count, 0, "an event the server refuses would otherwise block the queue forever")
        XCTAssertEqual(r.uploader.rejectedCount, 1)
    }

    // MARK: backoff

    func testBackoffIsExponentialAndCapped() async throws {
        let r = try rig()
        try fill(r.queue, plays: 1)
        r.transport.onPlays = { _ in throw MondropAPIError.http(503, nil) }
        var delays: [TimeInterval] = []
        for _ in 0..<7 {
            await r.uploader.flush(.manual)
            guard case .backoff(let retryAt, _) = r.uploader.status else { return XCTFail("expected backoff") }
            delays.append(retryAt.timeIntervalSince(r.clock.current))
        }
        XCTAssertEqual(delays, [30, 60, 120, 240, 480, 900, 900], "30 s doubling up to 15 minutes")
    }

    func testBackoffIsRespectedExceptForInviaOra() async throws {
        let r = try rig()
        try fill(r.queue, plays: 2)
        var healthy = false
        r.transport.onPlays = { events in
            if !healthy { throw MondropAPIError.http(502, nil) }
            return BatchAck(accepted: events.count)
        }
        await r.uploader.flush(.timer)
        XCTAssertEqual(r.transport.playCalls.count, 1)

        await r.uploader.flush(.timer)                              // inside the 30 s window
        await r.uploader.flush(.threshold)
        await r.uploader.flush(.launch)
        XCTAssertEqual(r.transport.playCalls.count, 1, "automatic flushes wait for the backoff")

        await r.uploader.flush(.manual)                             // "Invia ora" does not
        XCTAssertEqual(r.transport.playCalls.count, 2)

        r.clock.advance(3600)                                       // the backoff is long over
        healthy = true
        await r.uploader.flush(.timer)
        XCTAssertEqual(r.transport.playCalls.count, 3)
        XCTAssertEqual(r.queue.count, 0)
    }

    func testASuccessResetsTheBackoff() async throws {
        let r = try rig()
        try fill(r.queue, plays: 1)
        var fail = true
        r.transport.onPlays = { events in
            if fail { throw MondropAPIError.http(500, nil) }
            return BatchAck(accepted: events.count)
        }
        await r.uploader.flush(.manual)
        await r.uploader.flush(.manual)                             // second failure: 60 s
        fail = false
        await r.uploader.flush(.manual)
        XCTAssertEqual(r.uploader.status, .idle)

        try fill(r.queue, plays: 1, prefix: "again")
        fail = true
        await r.uploader.flush(.manual)
        guard case .backoff(let retryAt, _) = r.uploader.status else { return XCTFail("expected backoff") }
        XCTAssertEqual(retryAt.timeIntervalSince(r.clock.current), 30, "back to the first step after a success")
    }

    func testAnOldBackendWithoutTheEndpointsJustBacksOff() async throws {
        let r = try rig()
        try fill(r.queue, plays: 2)
        r.transport.onPlays = { _ in throw MondropAPIError.http(404, nil) }
        await r.uploader.flush(.launch)
        XCTAssertEqual(r.queue.count, 2, "nothing is lost while the backend is old")
        guard case .backoff(_, let message) = r.uploader.status else { return XCTFail("expected backoff") }
        XCTAssertTrue(message.contains("non supporta"))
    }

    // MARK: 401

    func test401PausesUploadingAndKeepsEveryEvent() async throws {
        let r = try rig()
        try fill(r.queue, plays: 3)
        var key = "old"
        r.transport.onPlays = { events in
            if key == "old" { throw MondropAPIError.http(401, "invalid or missing X-SoundReel-Key") }
            return BatchAck(accepted: events.count)
        }

        await r.uploader.flush(.launch)
        XCTAssertEqual(r.uploader.status, .needsKey, "the Settings hint: the key is invalid")
        XCTAssertEqual(r.queue.count, 3, "no event dropped")

        let calls = r.transport.playCalls.count
        await r.uploader.flush(.timer)
        await r.uploader.flush(.threshold)
        await r.uploader.flush(.background)
        await r.uploader.flush(.deviceEvent)
        XCTAssertEqual(r.transport.playCalls.count, calls, "paused: automatic flushes do not hammer the server with a dead key")

        await r.uploader.flush(.manual)                              // still the old key
        XCTAssertEqual(r.uploader.status, .needsKey)

        key = "new"
        r.uploader.clearAuthPause()                                  // a new key was issued
        await r.uploader.flush(.keyChanged)
        XCTAssertEqual(r.queue.count, 0)
        XCTAssertEqual(r.uploader.status, .idle)
    }

    func test403AndMissingCredentialsPauseTheSameWay() async throws {
        for failure in [MondropAPIError.http(403, nil), .missingApiKey, .missingUser] {
            let r = try rig()
            try fill(r.queue, plays: 1)
            r.transport.onPlays = { _ in throw failure }
            await r.uploader.flush(.launch)
            XCTAssertEqual(r.uploader.status, .needsKey, "\(failure)")
            XCTAssertEqual(r.queue.count, 1)
        }
    }

    func testInviaOraWorksWhilePausedAndResumesOnSuccess() async throws {
        let r = try rig()
        try fill(r.queue, plays: 2)
        var dead = true
        r.transport.onPlays = { events in
            if dead { throw MondropAPIError.http(401, nil) }
            return BatchAck(accepted: events.count)
        }
        await r.uploader.flush(.launch)
        XCTAssertEqual(r.uploader.status, .needsKey)
        dead = false                                                 // the user pasted a good key in Settings
        await r.uploader.flush(.manual)
        XCTAssertEqual(r.uploader.status, .idle)
        XCTAssertEqual(r.queue.count, 0)
    }

    // MARK: a batch the server refuses as a whole

    func testAPoisonBatchIsSplitUntilTheCulpritIsAloneThenOnlyThatOneIsDropped() async throws {
        let r = try rig()
        try fill(r.queue, plays: 8)
        r.transport.onPlays = { events in
            if events.contains(where: { $0.id == "p5" }) { throw MondropAPIError.http(400, "invalid event") }
            return BatchAck(accepted: events.count)
        }
        await r.uploader.flush(.manual)

        XCTAssertEqual(r.queue.count, 0, "the 7 good events went through")
        XCTAssertEqual(r.uploader.rejectedCount, 1, "only the culprit was dropped")
        let uploaded = Set(r.transport.playCalls.flatMap { $0 })
        XCTAssertTrue(uploaded.isSuperset(of: ["p1", "p2", "p3", "p4", "p6", "p7", "p8"]))
        XCTAssertEqual(r.transport.playCalls.first?.count, 8, "first the whole batch, then halves")
        XCTAssertEqual(r.uploader.status, .idle, "this is not an outage: no backoff")
    }

    func testAnOversizedBatchAnswer413IsHalvedToo() async throws {
        let r = try rig(config: { var c = UploaderConfig(); c.batchSize = 8; return c }())
        try fill(r.queue, plays: 8)
        r.transport.onPlays = { events in
            if events.count > 3 { throw MondropAPIError.http(413, nil) }
            return BatchAck(accepted: events.count)
        }
        await r.uploader.flush(.manual)
        XCTAssertEqual(r.queue.count, 0)
        XCTAssertEqual(r.uploader.rejectedCount, 0, "413 is about size, nothing was dropped")
    }

    // MARK: when it flushes

    func testTheThresholdOf20TriggersAFlush() async throws {
        let r = try rig()
        for i in 1...19 {
            try r.queue.append(.play(TestSupport.playEvent("p\(i)")))
            r.uploader.noteAppended()
        }
        await r.uploader.waitForScheduledFlush()
        XCTAssertTrue(r.transport.order.isEmpty, "19 events: not yet")

        try r.queue.append(.play(TestSupport.playEvent("p20")))
        r.uploader.noteAppended()
        await r.uploader.waitForScheduledFlush()
        XCTAssertEqual(r.transport.playCalls.map(\.count), [20])
        XCTAssertEqual(r.queue.count, 0)
    }

    func testADeletionEventIsSentWithoutWaitingForTwentyEvents() async throws {
        let r = try rig()
        try r.queue.append(.device(TestSupport.deviceEvent("d1")))
        r.uploader.noteDeviceEvent()
        await r.uploader.waitForScheduledFlush()
        XCTAssertEqual(r.transport.deviceCalls, [["d1"]])
    }

    func testGoingToBackgroundUploadsInsideABackgroundTask() async throws {
        let r = try rig()
        try fill(r.queue, plays: 3)
        await r.uploader.flush(.background)
        XCTAssertEqual(r.runner.names, ["SoundReel events"], "beginBackgroundTask wraps the upload")
        XCTAssertEqual(r.queue.count, 0)
    }

    func testOtherReasonsDoNotNeedABackgroundTask() async throws {
        let r = try rig()
        try fill(r.queue, plays: 3)
        await r.uploader.flush(.launch)
        XCTAssertTrue(r.runner.names.isEmpty)
        XCTAssertEqual(r.queue.count, 0)
    }

    func testTheForegroundTimerFlushesEvery15Minutes() async throws {
        let r = try rig()
        try fill(r.queue, plays: 2)
        await r.uploader.runTimer(cycles: 3)
        XCTAssertEqual(r.clock.sleeps, [900, 900, 900], "every 15 minutes")
        XCTAssertEqual(r.transport.playCalls.count, 1, "the first tick empties the queue, the next ones have nothing to send")
        try fill(r.queue, plays: 1, prefix: "later")
        await r.uploader.runTimer(cycles: 1)
        XCTAssertEqual(r.transport.playCalls.count, 2)
    }

    func testACancelledUploadIsNotAFailure() async throws {
        let r = try rig()
        try fill(r.queue, plays: 2)
        r.transport.onPlays = { _ in throw CancellationError() }
        await r.uploader.flush(.manual)
        XCTAssertEqual(r.uploader.status, .idle, "the OS ended the background time: nothing to punish")
        XCTAssertEqual(r.queue.count, 2)
        r.transport.onPlays = nil
        await r.uploader.flush(.timer)
        XCTAssertEqual(r.queue.count, 0, "no backoff was set")
    }

    // MARK: bookkeeping

    func testTheLastUploadTimeIsKeptAcrossARelaunch() async throws {
        let r = try rig()
        try fill(r.queue, plays: 1)
        await r.uploader.flush(.manual)
        let relaunched = EventQueue(directory: r.dir.appendingPathComponent("queue"))
        XCTAssertEqual(relaunched.lastUploadAt, r.uploader.lastUploadAt)
        XCTAssertNotNil(relaunched.lastUploadAt)
    }

    func testAcknowledgedCountedPlaysStopBeingPendingInTheLocalNumbers() async throws {
        let r = try rig()
        _ = try r.store.install(
            stagedFile: try { let u = r.store.stagingURL(); try Data(count: 10).write(to: u); return u }(),
            songKey: "a::b",
            metadata: InstallMetadata(title: "T", artist: "A", plays: 3)
        )
        let counted = TestSupport.playEvent("e1", songKey: "a::b", listenedMs: 60_000, durationMs: 200_000)
        let skipped = TestSupport.playEvent("e2", songKey: "a::b", listenedMs: 5_000, durationMs: 200_000)
        r.store.bumpLocalPlay(songKey: "a::b", at: counted.startedAt)       // what the recorder does for a counted listen
        try r.queue.append(.play(counted))
        try r.queue.append(.play(skipped))
        XCTAssertEqual(r.store.stat(songKey: "a::b")?.unsynced, 1)

        await r.uploader.flush(.manual)

        XCTAssertEqual(r.store.stat(songKey: "a::b")?.unsynced, 0, "acknowledged: the server counts it from now on")
        XCTAssertEqual(r.store.stat(songKey: "a::b")?.plays, 4, "the displayed number does not dip while waiting for the next sync")
    }
}

/// The real HTTP layer for the two endpoints, against a URLProtocol stub (no network).
final class EventEndpointsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    private func api() -> MondropAPI {
        MondropAPI(session: StubURLProtocol.session(), config: { .test })
    }

    private var captured: StubURLProtocol.Captured {
        // A failing expectation must fail the test, not crash the host app.
        StubURLProtocol.captured.last ?? StubURLProtocol.Captured(request: URLRequest(url: URL(string: "about:blank")!), body: nil)
    }

    func testPlaysBodyMatchesTheContract() async throws {
        StubURLProtocol.handler = { _ in (200, Data(#"{"accepted":1,"duplicates":0,"rejected":[]}"#.utf8)) }
        let started = try XCTUnwrap(ISO.parse("2026-11-08T06:12:03Z"))
        let event = PlayEvent(
            id: "6F1C2D6E-0000-0000-0000-000000000001", songKey: "bishop briggs::white flag", startedAt: started,
            tzOffsetMin: 60, listenedMs: 183_000, durationMs: 231_000, completed: true, origin: .local, playlistId: "p1"
        )

        let ack = try await api().postPlays([event])

        XCTAssertEqual(ack, BatchAck(accepted: 1, duplicates: 0, rejected: []))
        XCTAssertEqual(captured.request.httpMethod, "POST")
        XCTAssertEqual(captured.request.url?.path, "/api/mondrop/plays")
        XCTAssertEqual(captured.request.value(forHTTPHeaderField: "X-SoundReel-Key"), "sr_test_key_0123456789abcdef")
        XCTAssertEqual(captured.request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try TestSupport.jsonObject(try XCTUnwrap(captured.body))
        let expected: NSDictionary = [
            "events": [[
                "id": "6F1C2D6E-0000-0000-0000-000000000001",
                "songKey": "bishop briggs::white flag",
                "startedAt": "2026-11-08T06:12:03Z",
                "tzOffsetMin": 60,
                "listenedMs": 183_000,
                "durationMs": 231_000,
                "completed": true,
                "origin": "local",
                "playlistId": "p1",
            ]],
        ]
        XCTAssertEqual(body, expected)
    }

    func testUnknownDurationAndPlaylistAreExplicitNulls() async throws {
        StubURLProtocol.handler = { _ in (200, Data("{}".utf8)) }
        _ = try await api().postPlays([TestSupport.playEvent("e1", durationMs: nil, origin: .stream, playlistId: nil)])
        let body = try TestSupport.jsonObject(try XCTUnwrap(captured.body))
        let event = try XCTUnwrap((body["events"] as? [NSDictionary])?.first)
        XCTAssertTrue(event["durationMs"] is NSNull, "durationMs: null as in the contract")
        XCTAssertTrue(event["playlistId"] is NSNull)
        XCTAssertEqual(event["origin"] as? String, "stream")
    }

    func testDeviceEventBodyMatchesTheContract() async throws {
        StubURLProtocol.handler = { _ in (200, Data(#"{"accepted":1,"duplicates":0,"rejected":[]}"#.utf8)) }
        let at = try XCTUnwrap(ISO.parse("2026-11-08T09:40:00Z"))
        let event = DeviceEvent(
            id: "9A7B0000-0000-0000-0000-000000000001",
            at: at,
            details: DeleteSongsDetails(
                reason: "least_played",
                criteria: .init(count: 25),
                confirmations: 2,
                count: 1,
                bytes: 6_291_456,
                songs: [.init(songKey: "k", title: "T", artist: "A", bytes: 6_291_456, plays: 0, lastPlayedAt: nil)]
            )
        )
        _ = try await api().postDeviceEvents([event])

        XCTAssertEqual(captured.request.url?.path, "/api/mondrop/device-events")
        let body = try TestSupport.jsonObject(try XCTUnwrap(captured.body))
        let expected: NSDictionary = [
            "events": [[
                "id": "9A7B0000-0000-0000-0000-000000000001",
                "type": "delete_songs",
                "at": "2026-11-08T09:40:00Z",
                "details": [
                    "reason": "least_played",
                    "criteria": ["count": 25, "olderThanDays": NSNull()],
                    "confirmations": 2,
                    "count": 1,
                    "bytes": 6_291_456,
                    "songs": [["songKey": "k", "title": "T", "artist": "A", "bytes": 6_291_456, "plays": 0, "lastPlayedAt": NSNull()]],
                ],
            ]],
        ]
        XCTAssertEqual(body, expected)
    }

    func testAnAckWithRejectionsDecodes() async throws {
        StubURLProtocol.handler = { _ in (200, Data(#"{"accepted":2,"duplicates":1,"rejected":[{"id":"x","reason":"startedAt out of range"}]}"#.utf8)) }
        let ack = try await api().postPlays([TestSupport.playEvent("e1")])
        XCTAssertEqual(ack, BatchAck(accepted: 2, duplicates: 1, rejected: [.init(id: "x", reason: "startedAt out of range")]))
    }

    func testA200WithAnUnreadableBodyStillMeansReceived() async throws {
        StubURLProtocol.handler = { _ in (200, Data("<html>ok</html>".utf8)) }
        let ack = try await api().postPlays([TestSupport.playEvent("e1")])
        XCTAssertEqual(ack, BatchAck(), "never re-send because the answer could not be parsed")
    }

    func testHttpFailuresSurfaceAsApiErrors() async {
        StubURLProtocol.handler = { _ in (401, Data(#"{"error":"invalid or missing X-SoundReel-Key"}"#.utf8)) }
        do {
            _ = try await api().postPlays([TestSupport.playEvent("e1")])
            XCTFail("should have thrown")
        } catch {
            XCTAssertEqual(error as? MondropAPIError, .http(401, #"{"error":"invalid or missing X-SoundReel-Key"}"#))
        }
    }

    @MainActor
    func testEndToEndOverTheStubbedServer() async throws {
        let dir = try TestSupport.tempDir("e2e")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let queue = EventQueue(directory: dir.appendingPathComponent("q"))
        let store = OfflineStore(root: dir.appendingPathComponent("s"))
        try queue.append(.play(TestSupport.playEvent("e1")))
        try queue.append(.device(TestSupport.deviceEvent("d1")))
        let uploader = EventUploader(queue: queue, transport: api(), store: store, clock: FakeClock().clock)

        StubURLProtocol.handler = { request in
            guard request.value(forHTTPHeaderField: "X-SoundReel-Key") == "sr_test_key_0123456789abcdef" else { return (401, Data()) }
            return (200, Data(#"{"accepted":1,"duplicates":0,"rejected":[]}"#.utf8))
        }
        await uploader.flush(.manual)
        XCTAssertEqual(queue.count, 0)
        XCTAssertEqual(StubURLProtocol.captured.compactMap { $0.request.url?.path }, ["/api/mondrop/device-events", "/api/mondrop/plays"])

        try queue.append(.play(TestSupport.playEvent("e2")))
        StubURLProtocol.handler = { _ in (401, Data()) }
        await uploader.flush(.manual)
        XCTAssertEqual(uploader.status, .needsKey)
        XCTAssertEqual(queue.count, 1, "a 401 keeps the event")
    }
}
