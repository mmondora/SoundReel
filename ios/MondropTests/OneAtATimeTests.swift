import XCTest
@testable import Mondrop

/// «Il download deve essere non necessariamente parallelo e massivo.» (Michele, 12 November; spec 2026-11-12-mondrop-home-play-loop-reels-design.md M4): the queue of
/// downloads goes down ONE song at a time, in the order the songs are about to play (ADR-0030). What was already so stays so: nothing syncs all the playlists (only the one
/// that plays), and «Scarica tutta» is the person's own request.
@MainActor
final class OneAtATimeTests: XCTestCase {
    private func rig() throws -> EngineRig {
        let r = try EngineRig()          // no number given: the engine's own default
        let dir = r.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return r
    }

    private func tracks(_ keys: [String]) -> [OfflineTrack] { keys.map { TestSupport.track($0) } }

    func testAFreshEngineAllowsOneDownloadAtATime() throws {
        let dir = try TestSupport.tempDir("engine-default")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let engine = SyncEngine(transport: FakeTransport(), store: OfflineStore(root: dir), config: { .test })
        XCTAssertEqual(engine.maxParallel, 1)
    }

    func testTheEngineDownloadsOneSongAtATimeByDefault() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a", "b", "c"]))
        XCTAssertEqual(r.transport.startedKeys, ["a"], "only the first is on its way")
        XCTAssertEqual(r.engine.activeCount, 1)
        XCTAssertEqual(r.engine.queuedCount, 2)
        XCTAssertEqual(r.engine.progress["b"], .queued)

        try r.finish(r.transport.started[0].info)
        XCTAssertEqual(r.transport.startedKeys, ["a", "b"], "b starts only when a is done")
        XCTAssertEqual(r.engine.activeCount, 1)

        try r.finish(r.transport.started[1].info)
        try r.finish(r.transport.started[2].info)
        XCTAssertEqual(r.transport.startedKeys, ["a", "b", "c"])
        XCTAssertEqual(r.engine.activeCount, 0)
        XCTAssertEqual(r.engine.queuedCount, 0)
        XCTAssertEqual(Set(r.store.loadIndex().map(\.songKey)), ["a", "b", "c"])
    }

    func testAFailedDownloadLetsTheNextOneStart() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a", "b"]))
        XCTAssertEqual(r.transport.startedKeys, ["a"])
        r.fail(r.transport.started[0].info)
        XCTAssertEqual(r.transport.startedKeys, ["a", "b"], "a failure does not hold the queue")
        XCTAssertEqual(r.engine.activeCount, 1)
    }

    func testTheSongTheUserAsksForByNameJumpsTheQueueButStillRunsAlone() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a", "b", "c"]))
        r.engine.redownload(TestSupport.track("z"))
        XCTAssertEqual(r.transport.startedKeys, ["a"], "a is already on its way and is not interrupted")
        XCTAssertEqual(r.engine.activeCount, 1)
        try r.finish(r.transport.started[0].info)
        XCTAssertEqual(r.transport.startedKeys, ["a", "z"], "the one asked for by name goes before b and c")
        XCTAssertEqual(r.engine.activeCount, 1)
    }

    func testTheDownloadsOfAWholePlaylistNeverRunTwoAtOnce() throws {
        let r = try rig()
        let keys = (1...12).map { "song\($0)" }
        r.engine.enqueue(tracks(keys), origin: .sync)
        var peak = 0
        var finished = 0
        while finished < r.transport.started.count {
            peak = max(peak, r.engine.activeCount)
            try r.finish(r.transport.started[finished].info)
            finished += 1
        }
        XCTAssertEqual(r.transport.startedKeys, keys, "in the order of the queue")
        XCTAssertEqual(peak, 1, "never two at the same time")
    }
}
