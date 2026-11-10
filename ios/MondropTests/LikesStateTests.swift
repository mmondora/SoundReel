import XCTest
@testable import Mondrop

/// The like, as plain data (docs/mondrop-likes.md, spec 2026-11-10-mondrop-like-and-repeat-design.md L1–L3): the set the server holds, and
/// on top of it the operations the phone has not told the server yet. What the heart shows is the server's set with those applied; a like
/// and an unlike of the same song that have not left the phone cancel out; the server's set is the truth whenever it arrives.
final class LikesStateTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private func at(_ seconds: Double) -> Date { t0.addingTimeInterval(seconds) }
    private func state(server: [String] = [], owner: String = "mike") -> LikesState {
        LikesState(owner: owner, serverKeys: Set(server))
    }

    // MARK: what the heart shows

    func testNothingLikedAtTheStart() {
        let s = state()
        XCTAssertFalse(s.isLiked("a::b"))
        XCTAssertTrue(s.pending.isEmpty)
    }

    func testTheServersSetIsWhatTheHeartShows() {
        let s = state(server: ["a::b"])
        XCTAssertTrue(s.isLiked("a::b"))
        XCTAssertFalse(s.isLiked("c::d"))
    }

    func testALikeShowsAtOnceAndWaitsToBeSent() {
        var s = state()
        XCTAssertTrue(s.setLiked(true, songKey: "a::b", at: at(0)), "it changed something")
        XCTAssertTrue(s.isLiked("a::b"), "the heart is full before the server knows")
        XCTAssertEqual(s.pending.map(\.kind), [.like])
        XCTAssertEqual(s.pending.map(\.songKey), ["a::b"])
        XCTAssertEqual(s.pending.first?.at, at(0), "the moment the user gave it travels with it")
    }

    func testAnUnlikeOfAServerLikeShowsAtOnce() {
        var s = state(server: ["a::b"])
        XCTAssertTrue(s.setLiked(false, songKey: "a::b", at: at(0)))
        XCTAssertFalse(s.isLiked("a::b"))
        XCTAssertEqual(s.pending.map(\.kind), [.unlike])
    }

    // MARK: asking for what already is

    func testLikingWhatIsAlreadyLikedChangesNothing() {
        var s = state(server: ["a::b"])
        XCTAssertFalse(s.setLiked(true, songKey: "a::b", at: at(0)))
        XCTAssertTrue(s.pending.isEmpty)
        var t = state()
        t.setLiked(true, songKey: "c::d", at: at(0))
        XCTAssertFalse(t.setLiked(true, songKey: "c::d", at: at(5)), "twice in a row is once")
        XCTAssertEqual(t.pending.count, 1)
        XCTAssertEqual(t.pending.first?.at, at(0), "the first moment stays")
    }

    func testUnlikingWhatIsNotLikedChangesNothing() {
        var s = state()
        XCTAssertFalse(s.setLiked(false, songKey: "a::b", at: at(0)))
        XCTAssertTrue(s.pending.isEmpty)
    }

    // MARK: like and unlike cancel out while they are still on the phone

    func testALikeAndAnUnlikeOfTheSameSongThatHaveNotLeftCancelOut() {
        var s = state()
        s.setLiked(true, songKey: "a::b", at: at(0))
        XCTAssertTrue(s.setLiked(false, songKey: "a::b", at: at(1)))
        XCTAssertTrue(s.pending.isEmpty, "nothing to tell the server: it never knew")
        XCTAssertFalse(s.isLiked("a::b"))
    }

    func testAnUnlikeAndALikeOfTheSameSongThatHaveNotLeftCancelOut() {
        var s = state(server: ["a::b"])
        s.setLiked(false, songKey: "a::b", at: at(0))
        XCTAssertTrue(s.setLiked(true, songKey: "a::b", at: at(1)))
        XCTAssertTrue(s.pending.isEmpty)
        XCTAssertTrue(s.isLiked("a::b"), "back to what the server has")
    }

    func testOperationsOfOtherSongsAreLeftAlone() {
        var s = state()
        s.setLiked(true, songKey: "a", at: at(0))
        s.setLiked(true, songKey: "b", at: at(1))
        s.setLiked(true, songKey: "c", at: at(2))
        s.setLiked(false, songKey: "b", at: at(3))
        XCTAssertEqual(s.pending.map(\.songKey), ["a", "c"])
        s.setLiked(true, songKey: "b", at: at(4))
        XCTAssertEqual(s.pending.map(\.songKey), ["a", "c", "b"], "in the order they were given: b came back last")
        XCTAssertEqual(s.pending.map(\.kind), [.like, .like, .like])
    }

    // MARK: one that is being sent cannot be taken back, only answered

    func testAToggleBackWhileTheFirstIsBeingSentQueuesTheInverseInsteadOfCancelling() {
        var s = state()
        s.setLiked(true, songKey: "a::b", at: at(0))
        let sending = s.beginSending()
        XCTAssertEqual(sending?.kind, .like)
        XCTAssertTrue(s.setLiked(false, songKey: "a::b", at: at(1)))
        XCTAssertEqual(s.pending.map(\.kind), [.like, .unlike], "the like is on its way: it will arrive, and the unlike follows it")
        XCTAssertFalse(s.isLiked("a::b"), "the heart follows the last thing the user did")
        // …and toggling again, before the unlike has left, takes THAT one back
        XCTAssertTrue(s.setLiked(true, songKey: "a::b", at: at(2)))
        XCTAssertEqual(s.pending.map(\.kind), [.like])
        XCTAssertTrue(s.isLiked("a::b"))
    }

    func testBeginSendingTakesTheOldestOperationAndNeverTwoAtOnce() {
        var s = state()
        s.setLiked(true, songKey: "a", at: at(0))
        s.setLiked(true, songKey: "b", at: at(1))
        let first = s.beginSending()
        XCTAssertEqual(first?.songKey, "a")
        XCTAssertNil(s.beginSending(), "one at a time, in order")
        s.settle(first!)
        XCTAssertEqual(s.beginSending()?.songKey, "b")
    }

    func testNothingPendingIsNothingToSend() {
        var s = state(server: ["a"])
        XCTAssertNil(s.beginSending())
    }

    // MARK: what the server answers

    func testASettledOperationLeavesTheQueueAndTheServersSetFollows() {
        var s = state()
        s.setLiked(true, songKey: "a::b", at: at(0))
        let op = s.beginSending()!
        s.settle(op)
        XCTAssertTrue(s.pending.isEmpty)
        XCTAssertTrue(s.serverKeys.contains("a::b"))
        XCTAssertTrue(s.isLiked("a::b"))

        s.setLiked(false, songKey: "a::b", at: at(1))
        s.settle(s.beginSending()!)
        XCTAssertFalse(s.serverKeys.contains("a::b"))
        XCTAssertFalse(s.isLiked("a::b"))
    }

    func testAnOperationTheServerRefusedForGoodIsDroppedAndTheHeartGoesBackToTheServersState() {
        var s = state()
        s.setLiked(true, songKey: "bad key", at: at(0))
        let op = s.beginSending()!
        s.drop(op)
        XCTAssertTrue(s.pending.isEmpty)
        XCTAssertFalse(s.isLiked("bad key"))
        XCTAssertFalse(s.serverKeys.contains("bad key"), "the server never took it")
    }

    func testAnOperationThatCouldNotBeSentStaysWhereItWasAndCanBeSentAgain() {
        var s = state()
        s.setLiked(true, songKey: "a", at: at(0))
        s.setLiked(true, songKey: "b", at: at(1))
        let first = s.beginSending()!
        s.failed(first)
        XCTAssertEqual(s.pending.map(\.songKey), ["a", "b"], "same order, nothing lost")
        XCTAssertEqual(s.beginSending()?.songKey, "a", "the same one goes first again")
    }

    // MARK: the server's set is the truth

    func testTheServersSetReplacesWhatThePhoneKnew() {
        var s = state(server: ["old"])
        s.adopt(serverKeys: ["a", "b"])
        XCTAssertEqual(s.serverKeys, ["a", "b"])
        XCTAssertFalse(s.isLiked("old"), "unliked from another phone")
        XCTAssertTrue(s.isLiked("a"))
    }

    func testWhatIsStillWaitingIsAppliedOnTopOfTheServersSet() {
        var s = state()
        s.setLiked(true, songKey: "given in the car", at: at(0))      // no network in the tunnel
        s.adopt(serverKeys: ["a"])                                    // …and the app syncs before the like has gone
        XCTAssertTrue(s.isLiked("given in the car"), "it does not vanish when the app syncs")
        XCTAssertTrue(s.isLiked("a"))
    }

    func testWhatTheServerAlreadyKnowsIsNoLongerWaiting() {
        var s = state()
        s.setLiked(true, songKey: "k", at: at(0))
        s.adopt(serverKeys: ["k"])                                    // another phone gave it, or the answer was lost
        XCTAssertTrue(s.pending.isEmpty, "a like of a liked song changes nothing: no need to send it")
        // and the next toggle is an UNLIKE, not the cancelling of a phantom
        XCTAssertTrue(s.setLiked(false, songKey: "k", at: at(1)))
        XCTAssertFalse(s.isLiked("k"))
        XCTAssertEqual(s.pending.map(\.kind), [.unlike])
    }

    func testAnUnlikeOfWhatTheServerDoesNotHoldAnyMoreIsNoLongerWaiting() {
        var s = state(server: ["k"])
        s.setLiked(false, songKey: "k", at: at(0))
        s.adopt(serverKeys: [])
        XCTAssertTrue(s.pending.isEmpty)
        XCTAssertFalse(s.isLiked("k"))
    }

    func testWhatStillChangesSomethingStaysInOrder() {
        var s = state(server: ["x"])
        s.setLiked(true, songKey: "a", at: at(0))
        s.setLiked(false, songKey: "x", at: at(1))
        s.adopt(serverKeys: ["x", "y"])
        XCTAssertEqual(s.pending.map(\.songKey), ["a", "x"])
        XCTAssertEqual(s.pending.map(\.kind), [.like, .unlike])
    }

    func testTheOperationBeingSentIsKeptWhateverTheServerSays() {
        var s = state()
        s.setLiked(true, songKey: "k", at: at(0))
        _ = s.beginSending()
        s.adopt(serverKeys: ["k"])
        XCTAssertEqual(s.pending.count, 1, "it is on its way: its answer will come")
    }

    // MARK: another person

    func testAnotherPersonOnTheSamePhoneStartsFromNothing() {
        var s = state(server: ["a"], owner: "mike")
        s.setLiked(true, songKey: "b", at: at(0))
        s.reset(owner: "sara")
        XCTAssertEqual(s.owner, "sara")
        XCTAssertTrue(s.serverKeys.isEmpty)
        XCTAssertTrue(s.pending.isEmpty, "the likes of mike are never sent as sara's")
        XCTAssertFalse(s.isLiked("a"))
    }

    func testLikesGivenBeforeAnybodySignedInBelongToTheFirstPersonWhoDoes() {
        var s = state(owner: "")
        s.setLiked(true, songKey: "a", at: at(0))
        s.reset(owner: "mike")
        XCTAssertEqual(s.owner, "mike")
        XCTAssertTrue(s.isLiked("a"), "a phone nobody had signed in on: the likes are the first person's, they are not thrown away")
        XCTAssertEqual(s.pending.count, 1)
    }

    func testLikedKeysIsTheServersSetWithWhatWaitsOnTop() {
        var s = state(server: ["a", "b"])
        s.setLiked(true, songKey: "c", at: at(0))
        s.setLiked(false, songKey: "a", at: at(1))
        XCTAssertEqual(s.likedKeys, ["b", "c"])
    }

    func testTheSamePersonKeepsEverything() {
        var s = state(server: ["a"], owner: "mike")
        s.setLiked(true, songKey: "b", at: at(0))
        s.reset(owner: "mike")
        XCTAssertTrue(s.isLiked("a"))
        XCTAssertTrue(s.isLiked("b"))
        XCTAssertEqual(s.pending.count, 1)
    }

    // MARK: the file

    func testItSurvivesBeingWrittenAndRead() throws {
        var s = state(server: ["a", "b"], owner: "mike")
        s.setLiked(true, songKey: "c", at: at(0))
        s.setLiked(false, songKey: "a", at: at(1))
        _ = s.beginSending()
        let data = try EventCoding.encoder().encode(s)
        let back = try EventCoding.decoder().decode(LikesState.self, from: data)
        XCTAssertEqual(back.owner, "mike")
        XCTAssertEqual(back.serverKeys, ["a", "b"])
        XCTAssertEqual(back.pending.map(\.songKey), ["c", "a"])
        XCTAssertEqual(back.pending.map(\.kind), [.like, .unlike])
        XCTAssertEqual(back.pending.first?.at, at(0))
        XCTAssertNil(back.inFlight, "what was on its way when the app died is simply sent again, nothing is on its way now")
        XCTAssertTrue(back.isLiked("c"))
        XCTAssertFalse(back.isLiked("a"))
    }

    func testAnOperationIsIdentifiedByItsOwnIdNotByWhatItSays() {
        var s = state()
        s.setLiked(true, songKey: "a", at: at(0))
        let op = s.beginSending()!
        XCTAssertFalse(s.pending.isEmpty)
        let lookalike = LikeOperation(kind: op.kind, songKey: op.songKey, at: op.at)
        s.settle(lookalike)                                          // not the one that was sent
        XCTAssertEqual(s.pending.count, 1, "only the operation that was sent can be settled")
    }
}
