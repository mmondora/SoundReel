import XCTest
@testable import Mondrop

/// «Sync scarica i brani in ordine di stanno per suonare.» (Michele, 11 November, after trying build 17; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md
/// U16, ADR-0030): the songs waiting to be downloaded go down in the order they are about to play — the one that plays now, the ones after it, round the loop the ones
/// before it — and the order follows the player: skip ahead and what waits is arranged again from there. A download that has begun is not touched, and neither is
/// one the user asked for by name.
@MainActor
final class SyncOrderTests: XCTestCase {
    private func rig(persistQueue: Bool = false) throws -> EngineRig {
        let r = try EngineRig(persistQueue: persistQueue)
        let dir = r.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        r.engine.maxParallel = 1            // one at a time: the order in which they start is the order of the queue
        return r
    }

    private func tracks(_ keys: [String]) -> [OfflineTrack] { keys.map { TestSupport.track($0) } }

    /// Lets every download finish, one after the other, and says in which order they started.
    private func drain(_ r: EngineRig) throws -> [String] {
        var finished = 0
        while finished < r.transport.started.count {
            try r.finish(r.transport.started[finished].info)
            finished += 1
        }
        return r.transport.startedKeys
    }

    func testWhatIsQueuedWhileSongsAreAboutToPlayStartsWithThem() throws {
        let r = try rig()
        r.engine.setUpcoming(["d", "e"])
        r.engine.enqueue(tracks(["a", "b", "c", "d", "e"]))
        XCTAssertEqual(r.transport.startedKeys, ["d"], "the song about to play is the first to come down")
        XCTAssertEqual(try drain(r), ["d", "e", "a", "b", "c"], "then the others, as they came")
    }

    func testRoundTheLoopTheSongsBeforeTheOneThatPlaysComeLast() throws {
        let r = try rig()
        r.engine.setUpcoming(UpcomingOrder.keys(queue: ["a", "b", "c", "d"], index: 2))       // c, d, a, b
        r.engine.enqueue(tracks(["a", "b", "c", "d"]))
        XCTAssertEqual(try drain(r), ["c", "d", "a", "b"])
    }

    func testTheOrderFollowsThePlayerWhileTheDownloadsWait() throws {
        // a long list is coming down in the order of the list and the user jumps to the fifth song: what waits is arranged again from there
        let r = try rig()
        r.engine.enqueue(tracks(["a", "b", "c", "d", "e", "f"]))
        XCTAssertEqual(r.transport.startedKeys, ["a"])
        r.engine.setUpcoming(["e", "f", "a", "b", "c", "d"])
        XCTAssertEqual(try drain(r), ["a", "e", "f", "b", "c", "d"])
    }

    func testADownloadThatHasBegunIsNeverTouchedByANewOrder() throws {
        let r = try rig()
        r.engine.maxParallel = 2
        r.engine.enqueue(tracks(["a", "b", "c", "d"]))
        XCTAssertEqual(r.transport.startedKeys, ["a", "b"])
        r.engine.setUpcoming(["d", "c"])
        XCTAssertEqual(r.transport.startedKeys, ["a", "b"], "the two that were already coming down go on")
        XCTAssertTrue(r.transport.cancelled.isEmpty, "none is cancelled for a new order")
        XCTAssertEqual(r.engine.activeCount, 2)
        XCTAssertEqual(try drain(r), ["a", "b", "d", "c"])
    }

    func testWhatTheUserAskedForByNameStaysAheadOfWhatIsAboutToPlay() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a", "b", "c", "d"]))                  // a comes down; b, c, d wait
        r.engine.setUpcoming(["d", "c"])
        r.engine.redownload(TestSupport.track("z"))                     // «Riscarica»: the user asked for this one
        r.engine.setUpcoming(["c", "d"])                                // the player moves on, and z does not give way
        XCTAssertEqual(try drain(r), ["a", "z", "c", "d", "b"])
    }

    func testSongsThatTurnReadyLaterJoinInThePlayOrder() throws {
        // the server prepares the playlist while it plays: a second wave of ready songs comes in and the ones about to play come before those already waiting
        let r = try rig()
        r.engine.enqueue(tracks(["a", "b", "c"]))                       // a comes down; b, c wait
        r.engine.setUpcoming(["x", "y", "a", "b", "c"])
        r.engine.enqueue(tracks(["x", "y"]))
        XCTAssertEqual(try drain(r), ["a", "x", "y", "b", "c"])
    }

    func testWhenNothingIsAboutToPlayAnyMoreTheQueueStaysAsItWas() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a", "b", "c", "d"]))
        r.engine.setUpcoming(["d", "c"])                                // waiting: d, c, b
        r.engine.setUpcoming([])                                        // the last song ended
        XCTAssertEqual(try drain(r), ["a", "d", "c", "b"], "no new order, and nothing goes back to the old one")
    }

    func testSongsThatAreNotWaitingMoveNothing() throws {
        // the queue that plays is made of songs already on the phone: the order names songs that nothing waits for
        let r = try rig()
        r.engine.setUpcoming(["p", "q"])
        r.engine.enqueue(tracks(["a", "b", "c"]))
        XCTAssertEqual(try drain(r), ["a", "b", "c"])
    }

    func testTheEngineSaysWhichSongsAreAboutToPlay() throws {
        let r = try rig()
        XCTAssertEqual(r.engine.upcoming, [])
        r.engine.setUpcoming(["c", "a"])
        XCTAssertEqual(r.engine.upcoming, ["c", "a"])
    }

    func testInPlayOrderPutsTheSongsAboutToPlayFirstAndKeepsTheRest() throws {
        let r = try rig()
        r.engine.setUpcoming(["c", "a"])
        XCTAssertEqual(r.engine.inPlayOrder(tracks(["a", "b", "c", "d"])).map(\.songKey), ["c", "a", "b", "d"])
        r.engine.setUpcoming([])
        XCTAssertEqual(r.engine.inPlayOrder(tracks(["a", "b", "c", "d"])).map(\.songKey), ["a", "b", "c", "d"])
    }

    func testTheNewOrderIsKeptInTheQueueFileOfTheEngine() throws {
        let r = try rig(persistQueue: true)
        r.engine.enqueue(tracks(["a", "b", "c", "d"]))
        r.engine.setUpcoming(["d", "c"])
        let saved = try JSONDecoder().decode([QueuedJob].self, from: try XCTUnwrap(r.store.readQueueData()))
        XCTAssertEqual(saved.map(\.track.songKey), ["d", "c", "b"], "a relaunch brings the queue back in the order it was waiting in")
    }

    func testAQueuedJobKeepsItsPinThroughTheQueueFile() throws {
        let pinned = try JSONDecoder().decode(QueuedJob.self, from: JSONEncoder().encode(QueuedJob(track: TestSupport.track("a"), pinned: true)))
        XCTAssertEqual(pinned.pinned, true)
        let plain = try JSONDecoder().decode(QueuedJob.self, from: JSONEncoder().encode(QueuedJob(track: TestSupport.track("a"))))
        XCTAssertNil(plain.pinned, "a job that nobody asked for by name carries no pin")
    }
}
