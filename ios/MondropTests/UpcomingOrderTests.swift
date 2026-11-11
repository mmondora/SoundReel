import XCTest
@testable import Mondrop

/// «Sync scarica i brani in ordine di stanno per suonare.» (Michele, 11 November, after trying build 17; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md
/// U16, ADR-0030): what waits to be downloaded goes in the order the songs are about to play. These tables are the rule; `SyncOrderTests` has the engine follow it.
final class UpcomingOrderTests: XCTestCase {
    // MARK: the queue, from where it is

    func testTheQueueFromTheSongThatPlaysToTheEndAndThenRoundAgain() {
        XCTAssertEqual(UpcomingOrder.keys(queue: ["a", "b", "c", "d"], index: 0), ["a", "b", "c", "d"])
        XCTAssertEqual(UpcomingOrder.keys(queue: ["a", "b", "c", "d"], index: 2), ["c", "d", "a", "b"])
        XCTAssertEqual(UpcomingOrder.keys(queue: ["a", "b", "c", "d"], index: 3), ["d", "a", "b", "c"])
    }

    func testAQueueOfOneSong() {
        XCTAssertEqual(UpcomingOrder.keys(queue: ["a"], index: 0), ["a"])
    }

    func testNothingQueuedIsNothingAboutToPlay() {
        XCTAssertEqual(UpcomingOrder.keys(queue: [], index: 0), [])
        XCTAssertEqual(UpcomingOrder.keys(queue: [], index: 5), [])
    }

    func testAnIndexOutsideTheQueueIsTheFirstSong() {
        XCTAssertEqual(UpcomingOrder.keys(queue: ["a", "b", "c"], index: 7), ["a", "b", "c"])
        XCTAssertEqual(UpcomingOrder.keys(queue: ["a", "b", "c"], index: -1), ["a", "b", "c"])
    }

    func testASongTwiceInTheQueueCountsWhereItComesFirst() {
        XCTAssertEqual(UpcomingOrder.keys(queue: ["a", "b", "a", "c"], index: 1), ["b", "a", "c"])
        XCTAssertEqual(UpcomingOrder.keys(queue: ["a", "b", "a", "c"], index: 3), ["c", "a", "b"])
    }

    // MARK: arranging what waits

    func testWhatIsAboutToPlayGoesFirstInTheOrderItPlaysAndTheRestKeepsItsOrder() {
        XCTAssertEqual(UpcomingOrder.arrange(["a", "b", "c", "d", "e"], songKey: { $0 }, upcoming: ["d", "e", "a"]), ["d", "e", "a", "b", "c"])
    }

    func testWithNothingAboutToPlayNothingMoves() {
        XCTAssertEqual(UpcomingOrder.arrange(["c", "a", "b"], songKey: { $0 }, upcoming: []), ["c", "a", "b"])
    }

    func testASongTheQueueDoesNotHoldIsLeftWhereItWasAfterTheOnesThatPlaySoon() {
        // «p» and «q» are in the queue but nothing waits for them: they move nothing
        XCTAssertEqual(UpcomingOrder.arrange(["a", "b", "c"], songKey: { $0 }, upcoming: ["p", "c", "q"]), ["c", "a", "b"])
    }

    func testWhatTheUserAskedForByNameStaysAheadOfEverythingAboutToPlay() {
        let items = [("a", false), ("z", true), ("d", false), ("y", true)]
        let order = UpcomingOrder.arrange(items, songKey: { $0.0 }, pinned: { $0.1 }, upcoming: ["d", "a"]).map(\.0)
        XCTAssertEqual(order, ["z", "y", "d", "a"], "the two the user asked for keep their own order, then the queue's")
    }

    func testNothingIsAddedOrLostAndASongTwiceStaysTwiceInItsOwnOrder() {
        XCTAssertEqual(UpcomingOrder.arrange(["a", "b", "a", "c"], songKey: { $0 }, upcoming: ["c"]), ["c", "a", "b", "a"])
        XCTAssertEqual(UpcomingOrder.arrange(["a", "b", "a", "c"], songKey: { $0 }, upcoming: ["a"]), ["a", "a", "b", "c"])
    }

    func testASongNamedTwiceInTheOrderCountsWhereItIsNamedFirst() {
        XCTAssertEqual(UpcomingOrder.arrange(["a", "b", "c"], songKey: { $0 }, upcoming: ["c", "a", "c"]), ["c", "a", "b"])
    }

    func testAnEmptyListStaysEmpty() {
        XCTAssertEqual(UpcomingOrder.arrange([String](), songKey: { $0 }, upcoming: ["a"]), [])
    }

    func testTheSameInputIsAlwaysTheSameOutput() {
        let items = (0..<50).map { "s\($0)" }
        let upcoming = (0..<50).reversed().filter { $0 % 3 == 0 }.map { "s\($0)" }
        XCTAssertEqual(
            UpcomingOrder.arrange(items, songKey: { $0 }, upcoming: upcoming),
            UpcomingOrder.arrange(items, songKey: { $0 }, upcoming: upcoming)
        )
    }
}
