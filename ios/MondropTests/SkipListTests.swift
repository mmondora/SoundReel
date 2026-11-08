import XCTest
@testable import Mondrop

/// Decision D8: a song the user deleted from the phone is not downloaded again by Sync, and playing it streams it
/// without the parallel download — only "Riscarica" brings it back.
final class SkipListPlannerTests: XCTestCase {
    private func plan(_ tracks: [OfflineTrack], local: [String: LocalSnapshot] = [:], skipped: Set<String> = []) -> SyncPlan {
        SyncPlanner.plan(tracks: tracks, local: { local[$0] }, skipped: skipped)
    }

    func testASkipListedReadyTrackIsNotDownloaded() {
        let p = plan([TestSupport.track("deleted"), TestSupport.track("other")], skipped: ["deleted"])
        XCTAssertEqual(p.download.map(\.songKey), ["other"])
        XCTAssertEqual(p.removedByUser, ["deleted"])
    }

    func testWithoutTheSkipListItIsDownloadedAsBefore() {
        let p = plan([TestSupport.track("deleted")])
        XCTAssertEqual(p.download.map(\.songKey), ["deleted"])
        XCTAssertTrue(p.removedByUser.isEmpty)
    }

    func testAFileThatIsActuallyThereWinsOverTheSkipList() {
        let have = LocalSnapshot(version: "100-1", bytes: 100, fileExtension: "mp3")
        let p = plan([TestSupport.track("a")], local: ["a": have], skipped: ["a"])
        XCTAssertEqual(p.skipped, ["a"], "present is present")
        XCTAssertTrue(p.removedByUser.isEmpty)
        XCTAssertTrue(p.download.isEmpty)
    }

    func testOnlyReadyTracksCareAboutTheSkipList() {
        let p = plan([TestSupport.track("a", state: "preparing")], skipped: ["a"])
        XCTAssertEqual(p.preparing, ["a"])
        XCTAssertTrue(p.removedByUser.isEmpty)
    }

    func testRowStatusOfASkipListedSongOffersRiscarica() {
        let status = TrackRowStatus.make(track: TestSupport.track("a"), isLocal: false, progress: nil, isSkipListed: true)
        XCTAssertEqual(status.kind, .removedFromPhone)
        XCTAssertEqual(status.label, "rimossa dal telefono")
        XCTAssertTrue(status.canRedownload)
        XCTAssertFalse(status.canRetry)
    }

    func testRowStatusDownloadProgressWinsOverTheSkipListAfterRiscarica() {
        let status = TrackRowStatus.make(track: TestSupport.track("a"), isLocal: false, progress: .downloading(0.5), isSkipListed: true)
        XCTAssertEqual(status.kind, .downloading(0.5))
        XCTAssertFalse(status.canRedownload)
    }

    func testALocalFileIsScaricatoEvenIfTheKeyIsStillOnTheList() {
        let status = TrackRowStatus.make(track: TestSupport.track("a"), isLocal: true, progress: nil, isSkipListed: true)
        XCTAssertEqual(status.kind, .local)
    }

    func testOnlyAReadySongShowsRemovedFromPhone() {
        let status = TrackRowStatus.make(track: TestSupport.track("a", state: "failed", error: "x"), isLocal: false, progress: nil, isSkipListed: true)
        XCTAssertEqual(status.kind, .failed, "the server problem matters more than the old deletion")
        XCTAssertFalse(status.canRedownload)
    }

    func testRowStatusWithoutTheFlagIsUnchanged() {
        XCTAssertEqual(TrackRowStatus.make(track: TestSupport.track("a"), isLocal: false, progress: nil).kind, .readyOnServer)
    }
}

@MainActor
final class SkipListEngineTests: XCTestCase {
    private func rig() throws -> EngineRig {
        let r = try EngineRig()
        let dir = r.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return r
    }

    func testSyncNeverDownloadsASkipListedSong() throws {
        let r = try rig()
        r.store.addSkipped(["deleted"])
        let plan = r.engine.enqueue([TestSupport.track("deleted"), TestSupport.track("kept")])

        XCTAssertEqual(r.transport.startedKeys, ["kept"])
        XCTAssertEqual(plan.removedByUser, ["deleted"])
        XCTAssertNil(r.engine.progress["deleted"])
        XCTAssertEqual(r.engine.queuedCount, 0)
    }

    func testSyncAgainStillLeavesItAlone() throws {
        let r = try rig()
        r.store.addSkipped(["deleted"])
        for _ in 0..<3 { r.engine.enqueue([TestSupport.track("deleted")]) }
        XCTAssertTrue(r.transport.started.isEmpty)
    }

    func testRiscaricaClearsTheEntryAndDownloadsAheadOfTheQueue() throws {
        let r = try rig()
        r.store.addSkipped(["deleted"])
        r.engine.enqueue((1...4).map { TestSupport.track("q\($0)") })         // q1, q2 running; q3, q4 queued

        let plan = r.engine.redownload(TestSupport.track("deleted"))

        XCTAssertFalse(r.store.isSkipped("deleted"), "the entry is cleared")
        XCTAssertEqual(plan.download.map(\.songKey), ["deleted"])
        XCTAssertEqual(r.engine.progress["deleted"], .queued)
        try r.finish(try XCTUnwrap(r.transport.started.first).info)                         // a slot frees up
        XCTAssertEqual(r.transport.startedKeys.last, "deleted", "ahead of q3 and q4")
    }

    func testAfterRiscaricaSyncTreatsItLikeAnyOtherSong() throws {
        let r = try rig()
        r.store.addSkipped(["deleted"])
        let t = TestSupport.track("deleted")
        r.engine.redownload(t)
        try r.finish(try XCTUnwrap(r.transport.started.first).info)
        XCTAssertNotNil(r.store.fileURL(songKey: "deleted"))
        XCTAssertTrue(r.engine.enqueue([t]).skipped.contains("deleted"), "present now: skipped as usual")
        XCTAssertFalse(r.store.isSkipped("deleted"))
    }

    func testAnyRealDownloadClearsTheSkipEntryToo() throws {
        // e.g. the song came back through a path that never went through "Riscarica"
        let r = try rig()
        r.store.addSkipped(["a"])
        try r.installLocal("a", version: "100-1")
        XCTAssertFalse(r.store.isSkipped("a"))
    }

    func testAQueuedJobWhoseSongWasSkipListedMeanwhileIsNotRestoredAfterARelaunch() async throws {
        let first = try EngineRig(persistQueue: true)
        let dir = first.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        first.engine.enqueue((1...4).map { TestSupport.track("q\($0)") })      // q3, q4 queued and persisted
        first.store.addSkipped(["q4"])

        let second = try EngineRig(persistQueue: true, root: first.root)
        await second.engine.attachExisting()
        XCTAssertEqual(second.transport.startedKeys, ["q3"], "q3 is restored and starts, q4 stays deleted")
        XCTAssertEqual(second.engine.queuedCount, 0)
        XCTAssertNil(second.engine.progress["q4"])
    }

    func testAnEngineRetryOfADeletedSongIsNotAllowedToBypassTheList() throws {
        // A failed download keeps its job for "Riprova"; if the user deleted another copy meanwhile the planner decides.
        let r = try rig()
        let t = TestSupport.track("a")
        r.engine.enqueue([t])
        r.fail(try XCTUnwrap(r.transport.started.first).info, message: "timeout")
        r.store.addSkipped(["a"])
        r.engine.retry(songKey: "a")
        XCTAssertEqual(r.transport.started.count, 1, "no second download for a skip-listed song")
    }
}

/// Playing a skip-listed song streams it and must NOT start the parallel download.
final class SkipListFirstPlayTests: XCTestCase {
    private let cfg = MondropAPIConfig.test

    private func decide(_ track: OfflineTrack?, local: URL? = nil, skipListed: Bool) -> FirstPlayDecision {
        FirstPlay.decide(songKey: "a", track: track, local: local, config: cfg, skipListed: skipListed)
    }

    func testASkipListedReadySongStreamsWithoutAParallelDownload() {
        let t = TestSupport.track("a")
        guard case .streamWithoutDownload(let sources) = decide(t, skipListed: true) else { return XCTFail("expected streamWithoutDownload") }
        XCTAssertEqual(sources.map(\.isLocal), [false])
        XCTAssertEqual(sources[0].url.absoluteString, "https://soundreel.test/api/mondrop/songs/a/file")
    }

    func testTheStreamSourcesAreTheSameAsForANormalFirstPlay() throws {
        let t = try TestSupport.trackFromAnOlderServer("a")
        guard case .stream(let normal, _) = decide(t, skipListed: false),
              case .streamWithoutDownload(let skipped) = decide(t, skipListed: true) else { return XCTFail() }
        XCTAssertEqual(normal, skipped, "same address, same auth rules")
        XCTAssertEqual(skipped.map(\.url.absoluteString), ["https://soundreel.test/api/mondrop/songs/a/file"], "SoundReel only, whatever the manifest carries")
        XCTAssertFalse(skipped[0].headers.isEmpty)
    }

    func testNotSkipListedStillDownloadsInParallel() {
        let t = TestSupport.track("a")
        guard case .stream(_, let download) = decide(t, skipListed: false) else { return XCTFail("expected stream") }
        XCTAssertEqual(download, t)
    }

    func testTheDefaultIsNotSkipListed() {
        let t = TestSupport.track("a")
        guard case .stream = FirstPlay.decide(songKey: "a", track: t, local: nil, config: cfg) else { return XCTFail() }
    }

    func testALocalFileStillWinsOverTheSkipList() {
        let file = URL(fileURLWithPath: "/tmp/a.mp3")
        XCTAssertEqual(decide(TestSupport.track("a"), local: file, skipListed: true), .local(file))
    }

    func testASkipListedSongTheServerHasNotPreparedStillAsksTheServer() {
        for state in ["preparing", "missing", "failed"] {
            let t = TestSupport.track("a", state: state)
            XCTAssertEqual(decide(t, skipListed: true), .prepare(t), state)
        }
    }

    func testNoSourceIsStillUnavailable() {
        guard case .unavailable = decide(TestSupport.track("a", state: "no_source"), skipListed: true) else { return XCTFail() }
    }
}

final class SkipListStoreTests: XCTestCase {
    private func makeStore() throws -> (OfflineStore, URL) {
        let dir = try TestSupport.tempDir("skip")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return (OfflineStore(root: dir), dir)
    }

    @discardableResult
    private func install(_ store: OfflineStore, _ key: String, bytes: Int = 100) throws -> OfflineStore.Item {
        let staged = store.stagingURL()
        try Data(repeating: 1, count: bytes).write(to: staged)
        return try store.install(stagedFile: staged, songKey: key, metadata: InstallMetadata(title: key, artist: "A", version: "1-1"))
    }

    func testRemovingSongsDeletesFilesAndSkipListsThem() throws {
        let (store, _) = try makeStore()
        let a = try install(store, "a", bytes: 300)
        try install(store, "b", bytes: 200)
        let file = try XCTUnwrap(store.fileURL(for: a))

        let result = store.removeSongs(["a"], skipList: true)

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.bytes, 300)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertEqual(store.loadIndex().map(\.songKey), ["b"])
        XCTAssertTrue(store.isSkipped("a"))
        XCTAssertFalse(store.isSkipped("b"))
    }

    func testTheSkipListSurvivesARelaunch() throws {
        let (store, dir) = try makeStore()
        try install(store, "a")
        store.removeSongs(["a"])
        let relaunched = OfflineStore(root: dir)
        XCTAssertEqual(relaunched.skippedKeys, ["a"])
        XCTAssertTrue(relaunched.isSkipped("a"))
    }

    func testSongsNotOnThePhoneAreNeverSkipListed() throws {
        let (store, _) = try makeStore()
        let result = store.removeSongs(["ghost"], skipList: true)
        XCTAssertEqual(result.count, 0)
        XCTAssertFalse(store.isSkipped("ghost"), "nothing was deleted, so nothing is blocked")
    }

    func testRemovingWithoutTheSkipListLeavesItEmpty() throws {
        let (store, _) = try makeStore()
        try install(store, "a")
        store.removeSongs(["a"], skipList: false)
        XCTAssertTrue(store.skippedKeys.isEmpty)
    }

    func testClearSkippedAndInstallBothLiftIt() throws {
        let (store, _) = try makeStore()
        store.addSkipped(["a", "b"])
        store.clearSkipped("a")
        XCTAssertEqual(store.skippedKeys, ["b"])
        try install(store, "b")
        XCTAssertTrue(store.skippedKeys.isEmpty, "a real download of b brings it back")
    }

    func testOrphanCleanupDoesNotSkipListWhatItRemoves() throws {
        // The old "libera spazio" path (kept for compatibility) removes songs that are in no playlist; those are not
        // "deleted by choice of song": if one returns to a playlist it must download normally.
        let (store, _) = try makeStore()
        let item = try install(store, "a")
        _ = store.removeOrphans(confirmed: [item])
        XCTAssertFalse(store.isSkipped("a"))
    }
}

@MainActor
final class SkipListCoordinatorTests: XCTestCase {
    func testSyncReportsAndLeavesSkipListedSongsAndRiscaricaBringsOneBack() async throws {
        let rig = try EngineRig()
        let dir = rig.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let api = FakeAPI()
        api.scriptPrepare("pl1", [TestSupport.manifest("pl1", [TestSupport.track("deleted"), TestSupport.track("kept")])])
        rig.store.addSkipped(["deleted"])
        let coordinator = PlaylistSyncCoordinator(
            playlist: MondropPlaylist(id: "pl1", name: "P", songCount: 2), api: api, engine: rig.engine,
            clock: FakeClock().clock
        )

        await coordinator.sync()
        XCTAssertEqual(rig.transport.startedKeys, ["kept"])
        XCTAssertTrue(coordinator.message.contains("1 rimosse dal telefono"), coordinator.message)

        await coordinator.redownload(songKey: "deleted")
        XCTAssertEqual(rig.transport.startedKeys, ["kept", "deleted"], "Riscarica starts it")
        XCTAssertFalse(rig.store.isSkipped("deleted"))
    }
}
