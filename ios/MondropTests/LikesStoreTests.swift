import XCTest
@testable import Mondrop

// MARK: - Fakes

/// A server that keeps the likes of one person, answers like the contract (docs/mondrop-likes.md) and fails when told to.
final class FakeLikesTransport: LikesTransport, @unchecked Sendable {
    enum Call: Equatable { case fetch, put(String), delete(String) }

    private let lock = NSLock()
    private var _calls: [Call] = []
    private var _putDates: [Date] = []
    private var _server: [String] = []
    private var _putHandler: (@Sendable (String) async throws -> Void)?
    private var _deleteHandler: (@Sendable (String) async throws -> Void)?
    private var _fetchHandler: (@Sendable () async throws -> Void)?

    var calls: [Call] { lock.withLock { _calls } }
    var putDates: [Date] { lock.withLock { _putDates } }
    var server: [String] { lock.withLock { _server } }
    var putHandler: (@Sendable (String) async throws -> Void)? {
        get { lock.withLock { _putHandler } }
        set { lock.withLock { _putHandler = newValue } }
    }
    var deleteHandler: (@Sendable (String) async throws -> Void)? {
        get { lock.withLock { _deleteHandler } }
        set { lock.withLock { _deleteHandler = newValue } }
    }
    var fetchHandler: (@Sendable () async throws -> Void)? {
        get { lock.withLock { _fetchHandler } }
        set { lock.withLock { _fetchHandler = newValue } }
    }

    func setServer(_ keys: [String]) { lock.withLock { _server = keys } }
    func count(_ call: Call) -> Int { calls.filter { $0 == call }.count }

    func fetchLikes() async throws -> LikesSnapshot {
        try Task.checkCancellation()                                    // a call whose task was cancelled never goes out, like a real one
        lock.withLock { _calls.append(.fetch) }
        try await fetchHandler?()
        let keys = server
        return LikesSnapshot(user: "mike", total: keys.count, likes: keys.map { LikeRecord(songKey: $0, likedAt: nil) })
    }

    func putLike(songKey: String, at: Date) async throws -> LikeAck {
        lock.withLock { _calls.append(.put(songKey)); _putDates.append(at) }
        try await putHandler?(songKey)
        lock.withLock { if !_server.contains(songKey) { _server.insert(songKey, at: 0) } }
        return LikeAck(songKey: songKey, liked: true, likedAt: at)
    }

    func deleteLike(songKey: String) async throws -> LikeAck {
        lock.withLock { _calls.append(.delete(songKey)) }
        try await deleteHandler?(songKey)
        lock.withLock { _server.removeAll { $0 == songKey } }
        return LikeAck(songKey: songKey, liked: false, likedAt: nil)
    }
}

/// The clock of the retries: it writes down how long the store asked to wait, and then either lets it pass at once or never.
final class SleepLog: @unchecked Sendable {
    private let lock = NSLock()
    private var _delays: [TimeInterval] = []
    private let instant: Bool

    init(instant: Bool = false) { self.instant = instant }

    var delays: [TimeInterval] { lock.withLock { _delays } }

    var clock: PreparationClock {
        PreparationClock(
            sleep: { [self] seconds in
                lock.withLock { _delays.append(seconds) }
                if !instant { try await Task.sleep(nanoseconds: UInt64.max / 4) }       // until the test (or the store) cancels it
            },
            now: { Date() }
        )
    }
}

final class UserBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _name: String
    init(_ name: String) { _name = name }
    var name: String {
        get { lock.withLock { _name } }
        set { lock.withLock { _name = newValue } }
    }
}

// MARK: - The store

/// The like on the phone (docs/mondrop-likes.md, spec 2026-11-10-mondrop-like-and-repeat-design.md L1, L3): the heart shows at once, the
/// operation waits on the phone and goes when there is a network, in order; the server's set is the truth; a 404 is an old server and says
/// nothing; a 400 is dropped; another person on the same phone never inherits the likes of the first.
@MainActor
final class LikesStoreTests: XCTestCase {
    private var dir: URL!
    private let moment = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUpWithError() throws {
        continueAfterFailure = false
        dir = try TestSupport.tempDir("likes")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: dir)
    }

    private func make(
        _ transport: FakeLikesTransport = FakeLikesTransport(), user: @escaping @Sendable () -> String = { "mike" },
        autoFlush: Bool = false, sleeps: SleepLog = SleepLog()
    ) -> LikesStore {
        LikesStore(directory: dir, transport: transport, currentUser: user, clock: sleeps.clock, autoFlush: autoFlush)
    }

    private func settle(_ condition: @MainActor () -> Bool) async {
        for _ in 0..<500 where !condition() {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }

    // MARK: the heart and the flush

    func testALikeShowsAtOnceAndIsSentWithTheMomentItWasGivenThenTheServersSetIsRead() async {
        let transport = FakeLikesTransport()
        let store = make(transport)
        store.setLiked(true, songKey: "a::b", at: moment)
        XCTAssertTrue(store.isLiked("a::b"), "before any network")
        XCTAssertEqual(store.pendingCount, 1)
        await store.flush()
        XCTAssertEqual(transport.calls, [.put("a::b"), .fetch])
        XCTAssertEqual(transport.putDates, [moment])
        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertTrue(store.isLiked("a::b"))
    }

    func testAnUnlikeIsADelete() async {
        let transport = FakeLikesTransport()
        transport.setServer(["a::b"])
        let store = make(transport)
        await store.flush()
        XCTAssertTrue(store.isLiked("a::b"), "the server said so")
        store.setLiked(false, songKey: "a::b")
        XCTAssertFalse(store.isLiked("a::b"))
        await store.flush()
        XCTAssertEqual(transport.count(.delete("a::b")), 1)
        XCTAssertEqual(transport.server, [])
        XCTAssertFalse(store.isLiked("a::b"))
    }

    func testOperationsGoInTheOrderTheyWereGiven() async {
        let transport = FakeLikesTransport()
        transport.setServer(["c"])
        let store = make(transport)
        await store.flush()
        transport.fetchHandler = nil
        let before = transport.calls.count
        store.setLiked(true, songKey: "a", at: moment)
        store.setLiked(false, songKey: "c", at: moment.addingTimeInterval(1))
        store.setLiked(true, songKey: "b", at: moment.addingTimeInterval(2))
        await store.flush()
        XCTAssertEqual(Array(transport.calls.dropFirst(before)), [.put("a"), .delete("c"), .put("b"), .fetch], "the set is read AFTER what was sent")
    }

    func testTheServersSetIsReadAfterWhatWaitedWasSentAndThatIsTheTruth() async {
        let transport = FakeLikesTransport()
        transport.setServer(["x", "y"])
        let store = make(transport)
        store.setLiked(true, songKey: "mine")
        transport.putHandler = { _ in throw MondropAPIError.transport("offline") }        // the like cannot go yet
        await store.flush()
        XCTAssertTrue(store.isLiked("mine"), "given in a tunnel: the heart stays full")
        XCTAssertFalse(store.isLiked("x"), "nothing was read: the put failed first, and nothing goes on after a failure")
        transport.putHandler = nil
        await store.flush()
        XCTAssertTrue(store.isLiked("x") && store.isLiked("y") && store.isLiked("mine"))
        XCTAssertFalse(store.isLiked("z"))
    }

    func testAToggleOfTheSameStateTwiceNeverTalksToTheServerTwice() async {
        let transport = FakeLikesTransport()
        let store = make(transport)
        XCTAssertTrue(store.setLiked(true, songKey: "a"))
        XCTAssertFalse(store.setLiked(true, songKey: "a"))
        await store.flush()
        XCTAssertEqual(transport.count(.put("a")), 1)
    }

    func testToggleGivesTheNewStateOfTheHeart() {
        let store = make()
        XCTAssertTrue(store.toggle(songKey: "a"))
        XCTAssertTrue(store.isLiked("a"))
        XCTAssertFalse(store.toggle(songKey: "a"))
        XCTAssertFalse(store.isLiked("a"))
        XCTAssertEqual(store.pendingCount, 0, "liked and unliked before leaving: nothing to tell")
    }

    func testALikeThatCameBackToWhatTheServerHasIsNeverSent() async {
        let transport = FakeLikesTransport()
        let store = make(transport)
        store.setLiked(true, songKey: "a")
        store.setLiked(false, songKey: "a")
        await store.flush()
        XCTAssertEqual(transport.calls, [.fetch], "no put, no delete: the server never heard of it")
    }

    // MARK: with no network, or with a server that is not well

    func testALikeGivenOfflineStaysAndTravelsWhenTheNetworkIsBack() async {
        let transport = FakeLikesTransport()
        transport.putHandler = { _ in throw MondropAPIError.transport("offline") }
        let store = make(transport)
        store.setLiked(true, songKey: "a")
        await store.flush()
        XCTAssertEqual(store.pendingCount, 1)
        XCTAssertTrue(store.isLiked("a"))
        transport.putHandler = nil
        await store.flush()
        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertEqual(transport.count(.put("a")), 2)
        XCTAssertEqual(transport.server, ["a"])
    }

    func testAFailureStopsTheOthersAndKeepsTheOrder() async {
        let transport = FakeLikesTransport()
        transport.putHandler = { key in if key == "a" { throw MondropAPIError.http(503, nil) } }
        let store = make(transport)
        store.setLiked(true, songKey: "a", at: moment)
        store.setLiked(true, songKey: "b", at: moment.addingTimeInterval(1))
        await store.flush()
        XCTAssertEqual(transport.calls, [.put("a")], "b is not tried before a, and the set is not read")
        XCTAssertEqual(store.pendingCount, 2)
        transport.putHandler = nil
        await store.flush()
        XCTAssertEqual(Array(transport.calls.dropFirst()), [.put("a"), .put("b"), .fetch])
        XCTAssertEqual(store.pendingCount, 0)
    }

    func testA400IsDroppedAndTheOthersGoOn() async {
        let transport = FakeLikesTransport()
        transport.putHandler = { key in if key == "bad" { throw MondropAPIError.http(400, #"{"error":"invalid_song_key"}"#) } }
        let store = make(transport)
        store.setLiked(true, songKey: "bad", at: moment)
        store.setLiked(true, songKey: "good", at: moment.addingTimeInterval(1))
        await store.flush()
        XCTAssertEqual(transport.calls, [.put("bad"), .put("good"), .fetch])
        XCTAssertEqual(store.pendingCount, 0, "a refused operation does not stay in the queue for ever")
        XCTAssertFalse(store.isLiked("bad"), "the heart goes back: the server never took it")
        XCTAssertTrue(store.isLiked("good"))
    }

    func testOtherClientErrorsAreRefusalsToo() async {
        let transport = FakeLikesTransport()
        transport.putHandler = { _ in throw MondropAPIError.http(422, nil) }
        let store = make(transport)
        store.setLiked(true, songKey: "a")
        await store.flush()
        XCTAssertEqual(store.pendingCount, 0, "the server says the request is wrong: sending it again will not change that")
        XCTAssertFalse(store.isLiked("a"))
    }

    func testA5xxIsKeptAndRetriedWithABackoffThatGrowsAndIsCapped() async {
        let transport = FakeLikesTransport()
        transport.putHandler = { _ in throw MondropAPIError.http(503, nil) }
        let sleeps = SleepLog()
        let store = make(transport, sleeps: sleeps)
        store.setLiked(true, songKey: "a")
        for _ in 0..<9 { await store.flush() }
        await settle { sleeps.delays.count == 9 }                 // the retry of the last failure has started to wait
        XCTAssertEqual(sleeps.delays, [30, 60, 120, 240, 480, 900, 900, 900, 900], "30 s, doubling, never more than 15 minutes")
        XCTAssertEqual(store.pendingCount, 1)
        // a success starts the count again
        transport.putHandler = nil
        await store.flush()
        XCTAssertEqual(store.pendingCount, 0)
        transport.putHandler = { _ in throw MondropAPIError.http(500, nil) }
        store.setLiked(true, songKey: "b")
        await store.flush()
        await settle { sleeps.delays.count == 10 }
        XCTAssertEqual(sleeps.delays.last, 30)
    }

    func testTheRetryFiresByItselfWhileTheAppKeepsPlayingInTheBackground() async {
        let transport = FakeLikesTransport()
        let failures = FailureCounter(1)
        transport.putHandler = { _ in if failures.take() { throw MondropAPIError.transport("no signal") } }
        let sleeps = SleepLog(instant: true)
        let store = make(transport, sleeps: sleeps)
        store.setLiked(true, songKey: "a")
        await store.flush()                                  // the tunnel: it fails and schedules the retry
        await store.waitForRetry()                           // the signal is back: the retry goes by itself
        XCTAssertEqual(sleeps.delays, [30])
        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertEqual(transport.server, ["a"])
        XCTAssertEqual(transport.calls, [.put("a"), .put("a"), .fetch], "and the retry goes on to read the set: it is not cancelled by what it just did")
    }

    func testAnOldServerAnswers404KeepsEverythingAndSaysNothing() async {
        let transport = FakeLikesTransport()
        transport.putHandler = { _ in throw MondropAPIError.http(404, nil) }
        let sleeps = SleepLog()
        let store = make(transport, sleeps: sleeps)
        store.setLiked(true, songKey: "a")
        await store.flush()
        XCTAssertEqual(store.pendingCount, 1, "the queue is kept")
        XCTAssertTrue(store.isLiked("a"), "the heart stays full: no error on screen")
        XCTAssertTrue(store.serverLooksOld)
        try? await Task.sleep(nanoseconds: 60_000_000)                  // a timer would have started to wait by now
        XCTAssertTrue(sleeps.delays.isEmpty, "no timer: it is tried again at the next launch or the next time the app is in front")
        XCTAssertEqual(transport.calls, [.put("a")], "and nothing else is asked of an old server")
        // the server is updated: the next flush works
        transport.putHandler = nil
        await store.flush()
        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertFalse(store.serverLooksOld)
    }

    func testAnOldServerForTheSetKeepsWhatThePhoneKnew() async {
        let transport = FakeLikesTransport()
        transport.fetchHandler = { throw MondropAPIError.http(404, nil) }
        let store = make(transport)
        store.setLiked(true, songKey: "a")
        transport.putHandler = nil
        await store.flush()
        XCTAssertTrue(store.isLiked("a"))
        XCTAssertTrue(store.serverLooksOld)
    }

    func testAMissingOrRefusedKeyKeepsEverythingAndDoesNotRetryByItself() async {
        for error in [MondropAPIError.missingApiKey, .missingUser, .http(401, nil), .http(403, nil)] {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent("likes.json"))      // each one starts from nothing
            let transport = FakeLikesTransport()
            transport.putHandler = { _ in throw error }
            let sleeps = SleepLog()
            let store = make(transport, sleeps: sleeps)
            store.setLiked(true, songKey: "a")
            await store.flush()
            XCTAssertEqual(store.pendingCount, 1, "\(error)")
            try? await Task.sleep(nanoseconds: 60_000_000)                  // a timer would have started to wait by now
            XCTAssertTrue(sleeps.delays.isEmpty, "\(error): a timer would not give the app a key")
        }
    }

    func testAnUnreadableSetChangesNothing() async {
        let transport = FakeLikesTransport()
        transport.fetchHandler = { throw MondropAPIError.decode("garbage") }
        let store = make(transport)
        transport.setServer(["x"])
        store.setLiked(true, songKey: "a")
        await store.flush()
        XCTAssertEqual(store.pendingCount, 0, "the put went")
        XCTAssertTrue(store.isLiked("a"))
        XCTAssertFalse(store.isLiked("x"), "what could not be read is not guessed")
    }

    // MARK: asked while a call is in the air

    func testAToggleWhileTheOperationIsOnItsWayIsSentAfterItNotInsteadOfIt() async {
        let transport = FakeLikesTransport()
        let gate = AsyncGate()
        transport.putHandler = { _ in await gate.wait() }
        let store = make(transport)
        store.setLiked(true, songKey: "a")
        let flushing = Task { await store.flush() }
        await settle { transport.calls.contains(.put("a")) }
        XCTAssertTrue(store.setLiked(false, songKey: "a"), "the user took it back while the like was in the air")
        XCTAssertFalse(store.isLiked("a"), "the heart follows the user")
        XCTAssertEqual(store.pendingCount, 2, "the like is on its way and the unlike follows it")
        await gate.open()
        await flushing.value
        XCTAssertEqual(transport.calls, [.put("a"), .delete("a"), .fetch])
        XCTAssertEqual(transport.server, [])
        XCTAssertFalse(store.isLiked("a"))
    }

    func testTwoFlushesAtOnceSendOnce() async {
        let transport = FakeLikesTransport()
        let gate = AsyncGate()
        transport.putHandler = { _ in await gate.wait() }
        let store = make(transport)
        store.setLiked(true, songKey: "a")
        let first = Task { await store.flush() }
        await settle { transport.calls.contains(.put("a")) }
        await store.flush()                                  // the second one: the first is already at work
        XCTAssertEqual(transport.count(.put("a")), 1)
        await gate.open()
        await first.value
        XCTAssertEqual(transport.count(.put("a")), 1)
    }

    func testALikeGivenWhileTheSetIsBeingReadIsSentAnyway() async {
        let transport = FakeLikesTransport()
        let gate = AsyncGate()
        transport.fetchHandler = { await gate.wait() }
        let store = make(transport, autoFlush: true)
        let first = Task { await store.flush() }
        await settle { transport.calls.contains(.fetch) }
        store.setLiked(true, songKey: "late")                // autoFlush: a flush is asked while one is reading the set
        await gate.open()
        await first.value
        await store.waitForScheduledFlush()
        await settle { transport.calls.contains(.put("late")) }
        XCTAssertEqual(transport.count(.put("late")), 1)
        XCTAssertTrue(store.isLiked("late"))
    }

    func testEveryOperationIsSentRightAfterItIsGiven() async {
        let transport = FakeLikesTransport()
        let store = make(transport, autoFlush: true)
        store.setLiked(true, songKey: "a")
        await store.waitForScheduledFlush()
        XCTAssertEqual(transport.calls, [.put("a"), .fetch])
        XCTAssertEqual(store.pendingCount, 0)
    }

    // MARK: the file

    func testTheLikesSurviveARelaunchAndWhatWasWaitingStillGoes() async {
        let offline = FakeLikesTransport()
        offline.putHandler = { _ in throw MondropAPIError.transport("offline") }
        let first = make(offline)
        offline.setServer(["old"])
        first.setLiked(true, songKey: "new", at: moment)
        await first.flush()
        let second = make(FakeLikesTransport())             // the app was closed and opened again
        XCTAssertTrue(second.isLiked("new"))
        XCTAssertEqual(second.pendingCount, 1)
        let online = FakeLikesTransport()
        let third = make(online)
        await third.flush()
        XCTAssertEqual(online.calls, [.put("new"), .fetch])
        XCTAssertEqual(online.putDates.count, 1)
    }

    func testAFileThatCannotBeReadIsAnEmptyStateNotACrash() async throws {
        try Data("not json at all {".utf8).write(to: dir.appendingPathComponent("likes.json"))
        let transport = FakeLikesTransport()
        let store = make(transport)
        XCTAssertFalse(store.isLiked("a"))
        XCTAssertEqual(store.pendingCount, 0)
        store.setLiked(true, songKey: "a")
        await store.flush()
        XCTAssertEqual(transport.server, ["a"])
        XCTAssertTrue(make(FakeLikesTransport()).isLiked("a"), "and it is written again")
    }

    // MARK: another person

    func testAnotherPersonOnThisPhoneNeverSeesOrSendsTheLikesOfTheFirst() async {
        let user = UserBox("mike")
        let transport = FakeLikesTransport()
        let store = make(transport, user: { user.name })
        store.setLiked(true, songKey: "a")
        XCTAssertTrue(store.isLiked("a"))
        user.name = "sara"
        store.userMayHaveChanged()
        XCTAssertFalse(store.isLiked("a"))
        XCTAssertEqual(store.pendingCount, 0, "the like of mike is not sent as the like of sara")
        await store.flush()
        XCTAssertEqual(transport.calls, [.fetch])
    }

    func testTheSamePersonKeepsTheirLikesWhenTheyRenewTheKey() async {
        let user = UserBox("mike")
        let store = make(user: { user.name })
        store.setLiked(true, songKey: "a")
        store.userMayHaveChanged()
        XCTAssertTrue(store.isLiked("a"))
        XCTAssertEqual(store.pendingCount, 1)
    }

    func testNobodySignedInChangesNothing() {
        let user = UserBox("mike")
        let store = make(user: { user.name })
        store.setLiked(true, songKey: "a")
        user.name = "   "
        store.userMayHaveChanged()
        XCTAssertTrue(store.isLiked("a"), "an empty name is no other person: the likes wait for a key")
        XCTAssertEqual(store.pendingCount, 1)
    }

    func testTheNameOfThePersonIsComparedWithoutCaseOrSpaces() {
        let user = UserBox("mike")
        let store = make(user: { user.name })
        store.setLiked(true, songKey: "a")
        user.name = "  Mike "
        store.userMayHaveChanged()
        XCTAssertTrue(store.isLiked("a"))
    }

    // MARK: what the screens watch

    func testTheScreensAreToldWhenTheHeartsChange() async {
        let transport = FakeLikesTransport()
        let store = make(transport)
        let start = store.revision
        store.setLiked(true, songKey: "a")
        XCTAssertGreaterThan(store.revision, start)
        let afterLike = store.revision
        store.setLiked(true, songKey: "a")
        XCTAssertEqual(store.revision, afterLike, "nothing changed: nobody is told")
        transport.setServer(["a", "b"])
        await store.flush()
        XCTAssertGreaterThan(store.revision, afterLike, "the set that arrived has a heart more")
        let settled = store.revision
        await store.flush()
        XCTAssertEqual(store.revision, settled, "the same set again: nothing to redraw")
    }
}

/// Fails the first `n` calls.
final class FailureCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var remaining: Int
    init(_ n: Int) { remaining = n }
    func take() -> Bool {
        lock.withLock {
            guard remaining > 0 else { return false }
            remaining -= 1
            return true
        }
    }
}
