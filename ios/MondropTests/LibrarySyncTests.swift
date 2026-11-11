import XCTest
@testable import Mondrop

/// The sync of every playlist at once: the first access (Michele, 10 November: «al primo accesso viene fatto un sync automatico … Se sono molti gb deve
/// avvisare oppure limitare») and the «Sync» of the Home. Spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U2.
@MainActor
final class LibrarySyncTests: XCTestCase {
    private let mb = 1_000_000
    private let gb = 1_000_000_000

    /// What the phone keeps (the limit, the key, the first-sync flag) and what it asked iOS, in a box the closures of the coordinator can reach.
    private final class Box: @unchecked Sendable {
        var limit: SyncWarnLimit = .gb2
        var hasKey = true
        var done = false
        var startedCalls = 0
    }

    private func make(limit: SyncWarnLimit = .gb2, hasKey: Bool = true, done: Bool = false) throws -> (LibrarySyncCoordinator, EngineRig, FakeAPI, Box) {
        let rig = try EngineRig()
        let api = FakeAPI()
        let box = Box()
        box.limit = limit
        box.hasKey = hasKey
        box.done = done
        let coordinator = LibrarySyncCoordinator(
            api: api, engine: rig.engine,
            limit: { box.limit },
            hasKey: { box.hasKey },
            isFirstSyncDone: { box.done },
            markFirstSyncDone: { box.done = true },
            onSyncStarted: { box.startedCalls += 1 }
        )
        return (coordinator, rig, api, box)
    }

    private func playlist(_ id: String) -> MondropPlaylist { MondropPlaylist(id: id, name: "Playlist \(id)", songCount: 0) }

    /// Playlist `id` with these tracks (ready, `size` bytes each by default).
    private func script(_ api: FakeAPI, _ id: String, _ keys: [String], size: Int = 100, state: String = "ready") {
        api.scriptPrepare(id, [TestSupport.manifest(id, keys.map { TestSupport.track($0, state: state, bytes: size) })])
    }

    private func queuedKeys(_ rig: EngineRig) -> Set<String> { Set(rig.engine.progress.keys) }

    // MARK: the first access

    func testTheFirstAccessSyncsEveryPlaylistOnceAndRemembersIt() async throws {
        let (sync, rig, api, box) = try make()
        api.setPlaylists([playlist("a"), playlist("b")])
        script(api, "a", ["a1", "a2"])
        script(api, "b", ["b1"])
        await sync.runFirstSyncIfNeeded()
        XCTAssertEqual(queuedKeys(rig), ["a1", "a2", "b1"])
        XCTAssertTrue(box.done, "the first sync is done")
        XCTAssertEqual(api.calls, ["playlists", "prepare:a:retry=false", "prepare:b:retry=false"])
        XCTAssertEqual(sync.phase, .idle)

        api.scriptPrepare("a", [TestSupport.manifest("a", [TestSupport.track("a1"), TestSupport.track("a2"), TestSupport.track("a3")])])
        await sync.runFirstSyncIfNeeded()
        XCTAssertEqual(api.calls.count, 3, "a second launch asks nothing: the first sync happens once")
        XCTAssertEqual(queuedKeys(rig), ["a1", "a2", "b1"])
    }

    func testWithNoKeyNothingHappensAndItIsTriedAgainAtTheNextLaunch() async throws {
        let (sync, rig, api, box) = try make(hasKey: false)
        api.setPlaylists([playlist("a")])
        script(api, "a", ["a1"])
        await sync.runFirstSyncIfNeeded()
        XCTAssertTrue(api.calls.isEmpty)
        XCTAssertTrue(queuedKeys(rig).isEmpty)
        XCTAssertFalse(box.done)

        box.hasKey = true
        await sync.runFirstSyncIfNeeded()
        XCTAssertEqual(queuedKeys(rig), ["a1"])
        XCTAssertTrue(box.done)
    }

    func testTheFirstAccessDoesNotAskIOSForNotificationsBehindTheUsersBack() async throws {
        let (sync, _, api, box) = try make()
        api.setPlaylists([playlist("a")])
        script(api, "a", ["a1"])
        await sync.runFirstSyncIfNeeded()
        XCTAssertEqual(box.startedCalls, 0, "the permission is asked when the user presses «Sync», never at the first launch")
        await sync.syncAll()
        XCTAssertEqual(box.startedCalls, 1)
    }

    func testAnErrorAtTheFirstAccessIsNotRememberedSoTheNextLaunchTriesAgain() async throws {
        let (sync, rig, api, box) = try make()
        api.setPlaylists([playlist("a")])
        // no script for «a»: the backend answers 404
        await sync.runFirstSyncIfNeeded()
        XCTAssertFalse(box.done)
        XCTAssertTrue(queuedKeys(rig).isEmpty)
        XCTAssertFalse(sync.message.isEmpty, "it says what went wrong")
        XCTAssertEqual(sync.phase, .idle)
    }

    func testNoPlaylistsIsAFinishedSyncNotAFailure() async throws {
        let (sync, _, api, box) = try make()
        api.setPlaylists([])
        await sync.runFirstSyncIfNeeded()
        XCTAssertTrue(box.done)
        XCTAssertEqual(sync.message, "Nulla da scaricare")
    }

    /// A backend that cannot even list the playlists.
    private final class Unreachable: MondropAPIProtocol, @unchecked Sendable {
        func listPlaylists() async throws -> [MondropPlaylist] { throw MondropAPIError.http(503, "down") }
        func offlineManifest(playlistId: String) async throws -> OfflineManifest { throw MondropAPIError.http(503, "down") }
        func prepare(playlistId: String, retryFailed: Bool) async throws -> OfflineManifest { throw MondropAPIError.http(503, "down") }
        func net() async throws -> NetInfo { throw MondropAPIError.http(503, "down") }
        func track(songKey: String) async throws -> OfflineTrack { throw MondropAPIError.http(503, "down") }
        func requestDownload(songKey: String, priority: DownloadPriority) async throws -> DownloadAck { throw MondropAPIError.http(503, "down") }
        func setSource(songKey: String, youtubeUrl: String) async throws { throw MondropAPIError.http(503, "down") }
    }

    func testWhenThePlaylistsCannotBeListedItSaysSoAndTheFirstSyncStaysUndone() async throws {
        let rig = try EngineRig()
        let box = Box()
        let sync = LibrarySyncCoordinator(
            api: Unreachable(), engine: rig.engine, limit: { .gb2 }, hasKey: { true },
            isFirstSyncDone: { box.done }, markFirstSyncDone: { box.done = true }
        )
        await sync.runFirstSyncIfNeeded()
        XCTAssertFalse(box.done)
        XCTAssertFalse(sync.message.isEmpty)
        XCTAssertTrue(rig.engine.progress.isEmpty)
        XCTAssertEqual(sync.phase, .idle)
    }

    // MARK: under the limit it just starts

    func testUnderTheLimitItDownloadsWithoutAsking() async throws {
        let (sync, rig, api, _) = try make(limit: .gb2)
        api.setPlaylists([playlist("a")])
        script(api, "a", ["a1", "a2", "a3"], size: 500 * mb)   // 1.5 GB
        await sync.syncAll()
        XCTAssertEqual(queuedKeys(rig), ["a1", "a2", "a3"])
        XCTAssertEqual(sync.phase, .idle)
    }

    func testWithTheLimitSetToNeverItNeverAsks() async throws {
        let (sync, rig, api, _) = try make(limit: .never)
        api.setPlaylists([playlist("a")])
        script(api, "a", ["a1", "a2"], size: 40 * gb)
        await sync.syncAll()
        XCTAssertEqual(queuedKeys(rig), ["a1", "a2"])
    }

    // MARK: over the limit it asks

    /// Starts a run that stops at the question, and gives the question.
    private func runUntilItAsks(_ sync: LibrarySyncCoordinator) async throws -> (Task<Void, Never>, SyncSizeQuestion) {
        let task = Task { await sync.syncAll() }
        for _ in 0..<400 {
            if case .asking(let question) = sync.phase { return (task, question) }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        task.cancel()
        XCTFail("the run never asked")
        throw CancellationError()
    }

    private func setUpBig(_ api: FakeAPI) {
        api.setPlaylists([playlist("a"), playlist("b")])
        script(api, "a", ["a1", "a2"], size: 1 * gb)
        script(api, "b", ["b1", "b2"], size: 1 * gb)   // 4 GB over a 2 GB limit
    }

    func testOverTheLimitItAsksHowMuchAndHowManyBeforeDownloadingAnything() async throws {
        let (sync, rig, api, _) = try make(limit: .gb2)
        setUpBig(api)
        let (task, question) = try await runUntilItAsks(sync)
        XCTAssertEqual(question.songs, 4)
        XCTAssertEqual(question.bytes, 4 * gb)
        XCTAssertEqual(question.limit, .gb2)
        XCTAssertTrue(queuedKeys(rig).isEmpty, "nothing is downloaded while the question is open")
        XCTAssertTrue(rig.transport.startedKeys.isEmpty)
        sync.answer(.cancel)
        await task.value
    }

    func testAllDownloadsEverything() async throws {
        let (sync, rig, api, box) = try make(limit: .gb2)
        setUpBig(api)
        let (task, _) = try await runUntilItAsks(sync)
        sync.answer(.all)
        await task.value
        XCTAssertEqual(queuedKeys(rig), ["a1", "a2", "b1", "b2"])
        XCTAssertFalse(box.done, "a manual sync does not touch the first-access flag")
        XCTAssertEqual(sync.phase, .idle)
    }

    func testLimitDownloadsInTheOrderOfThePlaylistsUntilTheLimitAndTheRestStaysOnline() async throws {
        let (sync, rig, api, _) = try make(limit: .gb2)
        setUpBig(api)
        let (task, _) = try await runUntilItAsks(sync)
        sync.answer(.limit)
        await task.value
        XCTAssertEqual(queuedKeys(rig), ["a1", "a2"], "the 2 GB of the first playlist, nothing of the second")
        XCTAssertTrue(sync.message.contains("gli altri 2 restano online"), "it says what stays online: \(sync.message)")
    }

    func testCancelDownloadsNothingAndTheFirstSyncCountsAsDone() async throws {
        let (sync, rig, api, box) = try make(limit: .gb2)
        setUpBig(api)
        let task = Task { await sync.runFirstSyncIfNeeded() }
        for _ in 0..<400 {
            if case .asking = sync.phase { break }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        sync.answer(.cancel)
        await task.value
        XCTAssertTrue(queuedKeys(rig).isEmpty)
        XCTAssertTrue(box.done, "«Annulla» at the first access: never asked again at every launch")
        XCTAssertEqual(sync.phase, .idle)
        XCTAssertEqual(sync.message, "Sync annullato: non scarico niente")
    }

    func testAnAnswerThatArrivesTwiceOrWhenNothingIsAskedIsIgnored() async throws {
        let (sync, rig, api, _) = try make(limit: .gb2)
        sync.answer(.all)   // nothing is asked: ignored, and it must not be remembered for the next question
        setUpBig(api)
        let (task, _) = try await runUntilItAsks(sync)
        sync.answer(.cancel)
        sync.answer(.all)   // the second one is too late
        await task.value
        XCTAssertTrue(queuedKeys(rig).isEmpty, "the first answer counts")
    }

    // MARK: what counts as «to download»

    func testSongsAlreadyOnThePhoneAreNotDownloadedNorCounted() async throws {
        let (sync, rig, api, _) = try make(limit: .gb2)
        api.setPlaylists([playlist("a")])
        // the planner keeps a file when it has the manifest's version and size: 100 bytes against a 100-byte song
        api.scriptPrepare("a", [TestSupport.manifest("a", [TestSupport.track("on", bytes: 100), TestSupport.track("off1", bytes: 100), TestSupport.track("off2", bytes: 100)])])
        try rig.installLocal("on", version: "100-1", bytes: 100)
        await sync.syncAll()
        XCTAssertEqual(queuedKeys(rig), ["off1", "off2"])
    }

    func testTheSizeOfWhatIsAlreadyOnThePhoneDoesNotMakeTheQuestionAppear() async throws {
        let (sync, rig, api, _) = try make(limit: .gb2)
        api.setPlaylists([playlist("a")])
        // 3 GB in the playlist, but 2 GB of it is already on the phone (same version, same size): 1 GB to download, under the limit
        api.scriptPrepare("a", [TestSupport.manifest("a", [
            TestSupport.track("on1", bytes: 1_000), TestSupport.track("on2", bytes: 1_000), TestSupport.track("off", bytes: 1 * gb),
        ])])
        try rig.installLocal("on1", version: "100-1", bytes: 1_000)
        try rig.installLocal("on2", version: "100-1", bytes: 1_000)
        await sync.syncAll()
        XCTAssertEqual(queuedKeys(rig), ["off"])
        XCTAssertEqual(sync.phase, .idle)
    }

    func testAFileWithTheServersSizeAndNoVersionIsAdoptedNotDownloadedAndItsVersionIsRemembered() async throws {
        let (sync, rig, api, _) = try make(limit: .gb2)
        api.setPlaylists([playlist("a")])
        api.scriptPrepare("a", [TestSupport.manifest("a", [TestSupport.track("old", version: "100-7", bytes: 100)])])
        try rig.installLocal("old", version: nil, bytes: 100)     // a file an earlier build downloaded: same size, no version
        await sync.syncAll()
        XCTAssertTrue(queuedKeys(rig).isEmpty, "nothing to download")
        XCTAssertEqual(rig.store.snapshot(songKey: "old")?.version, "100-7", "the server's version is remembered, so the next sync skips it")
    }

    func testASongTheUserDeletedFromThePhoneIsNotBroughtBack() async throws {
        let (sync, rig, api, _) = try make(limit: .gb2)
        api.setPlaylists([playlist("a")])
        script(api, "a", ["gone", "kept"])
        rig.store.addSkipped(["gone"])
        await sync.syncAll()
        XCTAssertEqual(queuedKeys(rig), ["kept"])
    }

    func testSongsTheServerHasNotPreparedAreNotDownloadedYetAndWeighNothing() async throws {
        let (sync, rig, api, _) = try make(limit: .gb2)
        api.setPlaylists([playlist("a")])
        api.scriptPrepare("a", [TestSupport.manifest("a", [
            TestSupport.track("ready", bytes: 100),
            TestSupport.track("preparing", state: "preparing", bytes: nil),
            TestSupport.track("failed", state: "failed", bytes: nil, error: "x"),
            TestSupport.track("nosrc", state: "no_source", bytes: nil),
            TestSupport.track("missing", state: "missing", bytes: nil),
        ])])
        await sync.syncAll()
        XCTAssertEqual(queuedKeys(rig), ["ready"])
    }

    func testASongInTwoPlaylistsIsDownloadedAndCountedOnce() async throws {
        let (sync, rig, api, _) = try make(limit: .gb2)
        api.setPlaylists([playlist("a"), playlist("b")])
        script(api, "a", ["x", "a1"], size: 1 * gb)
        script(api, "b", ["x", "b1"], size: 1 * gb)   // 3 GB distinct, 4 GB if «x» counted twice
        let (task, question) = try await runUntilItAsks(sync)
        XCTAssertEqual(question.songs, 3)
        XCTAssertEqual(question.bytes, 3 * gb)
        sync.answer(.all)
        await task.value
        XCTAssertEqual(queuedKeys(rig), ["x", "a1", "b1"])
    }

    // MARK: what the phone learns from the playlists

    func testItRemembersWhichSongsEachPlaylistHoldsAndWhichOnesFailed() async throws {
        let (sync, rig, api, _) = try make()
        api.setPlaylists([playlist("a")])
        api.scriptPrepare("a", [TestSupport.manifest("a", [TestSupport.track("ok"), TestSupport.track("bad", state: "failed", error: "x")])])
        await sync.syncAll()
        let record = rig.store.playlistRecords()["a"]
        XCTAssertEqual(record?.songKeys, ["ok", "bad"])
        XCTAssertEqual(record?.failedKeys, ["bad"])
    }

    func testAPlaylistDeletedOnTheServerStopsProtectingItsSongsOnlyWhenEveryPlaylistWasRead() async throws {
        let (sync, rig, api, _) = try make()
        rig.store.recordPlaylist(id: "gone", name: "Gone", songKeys: ["x"])
        api.setPlaylists([playlist("a")])
        script(api, "a", ["a1"])
        await sync.syncAll()
        XCTAssertNil(rig.store.playlistRecords()["gone"], "the whole picture was read: a playlist that is no longer there is forgotten")

        let (sync2, rig2, api2, _) = try make()
        rig2.store.recordPlaylist(id: "gone", name: "Gone", songKeys: ["x"])
        api2.setPlaylists([playlist("a"), playlist("b")])
        script(api2, "b", ["b1"])          // «a» has no script: it cannot be read
        await sync2.syncAll()
        XCTAssertNotNil(rig2.store.playlistRecords()["gone"], "a partial picture must never drive a cleanup")
    }

    func testAPlaylistThatCannotBeReadDoesNotStopTheOthersButLeavesTheFirstSyncUndone() async throws {
        let (sync, rig, api, box) = try make()
        api.setPlaylists([playlist("a"), playlist("b")])
        // «a» has no script (404); «b» is fine
        script(api, "b", ["b1"])
        await sync.runFirstSyncIfNeeded()
        XCTAssertEqual(queuedKeys(rig), ["b1"], "the playlist that could be read is synced")
        XCTAssertFalse(box.done, "one was not read: the next launch tries again (what is already on the phone is not asked for twice)")
        XCTAssertTrue(sync.message.contains("1"), sync.message)
    }

    // MARK: one run at a time

    func testASecondRunWhileOneIsGoingIsIgnored() async throws {
        let (sync, _, api, _) = try make(limit: .gb2)
        setUpBig(api)
        let (task, _) = try await runUntilItAsks(sync)
        await sync.syncAll()
        XCTAssertEqual(api.calls.filter { $0 == "playlists" }.count, 1, "the second press did not start a second run")
        sync.answer(.cancel)
        await task.value
    }
}
