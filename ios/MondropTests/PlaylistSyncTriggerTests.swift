import XCTest
@testable import Mondrop

/// «Il sync deve girare solo per playlist che sto suonando. Non di tutti in assoluto.» (Michele, 11 November, trying build 15; spec
/// 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U2). WHICH playlist the sync looks at is pure code: what the player is doing goes in,
/// what the sync has to do comes out. These tables are the rule.
final class PlaylistSyncTriggerTests: XCTestCase {
    private func ctx(_ playing: Bool, _ playlist: String?) -> PlaybackContext { PlaybackContext(isPlaying: playing, playlistId: playlist) }

    /// The contexts one after the other, and what each of them asks for.
    private func run(_ contexts: [PlaybackContext]) -> [[PlaylistSyncAction]] {
        var trigger = PlaylistSyncTrigger()
        return contexts.map { trigger.observe($0) }
    }

    // MARK: a queue that starts from a playlist

    func testAQueueThatStartsFromAPlaylistSyncsThatPlaylist() {
        XCTAssertEqual(run([ctx(true, "a")]), [[.sync("a")]])
    }

    func testAQueueThatDidNotComeFromAPlaylistSyncsNothing() {
        // a song found in Cerca, a choice of the library, the songs of the phone, «Aggiunti dalla ricerca»: the player has no playlist for them
        XCTAssertEqual(run([ctx(true, nil)]), [[]])
        XCTAssertEqual(run([ctx(true, nil), ctx(false, nil), ctx(true, nil)]), [[], [], []])
    }

    func testAQueueThatIsLoadedButNotPlayingSyncsNothing() {
        XCTAssertEqual(run([ctx(false, "a")]), [[]])
    }

    func testAQueueBroughtBackPausedAtLaunchSyncsOnlyWhenTheUserActuallyPlays() {
        XCTAssertEqual(
            run([ctx(false, "a"), ctx(false, "a"), ctx(true, "a")]),
            [[], [], [.sync("a")]],
            "restored and paused is not «playing»"
        )
    }

    // MARK: the same playlist twice

    func testTheSamePlaylistTwiceSyncsOnce() {
        XCTAssertEqual(run([ctx(true, "a"), ctx(true, "a")]), [[.sync("a")], []])
    }

    func testTheGapBetweenTwoSongsOfTheSamePlaylistDoesNotSyncAgain() {
        // the player says «not playing» for an instant at every change of song
        XCTAssertEqual(
            run([ctx(true, "a"), ctx(false, "a"), ctx(true, "a"), ctx(false, "a"), ctx(true, "a")]),
            [[.sync("a")], [], [], [], []]
        )
    }

    func testPausingAndPlayingAgainDoesNotSyncAgain() {
        XCTAssertEqual(run([ctx(true, "a"), ctx(false, "a"), ctx(false, "a"), ctx(true, "a")]), [[.sync("a")], [], [], []])
    }

    // MARK: a switch

    func testSwitchingToAnotherPlaylistLeavesTheFirstAndSyncsTheSecond() {
        XCTAssertEqual(run([ctx(true, "a"), ctx(true, "b")]), [[.sync("a")], [.leave("a"), .sync("b")]])
    }

    func testSwitchingWhilePausedLeavesTheFirstAndSyncsTheSecondOnlyWhenItPlays() {
        XCTAssertEqual(run([ctx(true, "a"), ctx(false, "b"), ctx(true, "b")]), [[.sync("a")], [.leave("a")], [.sync("b")]])
    }

    func testAQueueFromCercaAfterAPlaylistLeavesItAndSyncsNothing() {
        XCTAssertEqual(run([ctx(true, "a"), ctx(true, nil)]), [[.sync("a")], [.leave("a")]])
    }

    func testComingBackToAPlaylistAfterSomethingElseSyncsItAgain() {
        XCTAssertEqual(
            run([ctx(true, "a"), ctx(true, nil), ctx(true, "a")]),
            [[.sync("a")], [.leave("a")], [.sync("a")]]
        )
        XCTAssertEqual(
            run([ctx(true, "a"), ctx(true, "b"), ctx(true, "a")]),
            [[.sync("a")], [.leave("a"), .sync("b")], [.leave("b"), .sync("a")]]
        )
    }

    func testAPlaylistThatNeverPlayedHasNothingToLeave() {
        XCTAssertEqual(run([ctx(false, "a"), ctx(false, "b"), ctx(false, nil)]), [[], [], []])
    }

    // MARK: what counts as a playlist

    func testAnEmptyOrBlankPlaylistIdIsNoPlaylist() {
        XCTAssertEqual(run([ctx(true, ""), ctx(true, "   ")]), [[], []])
    }

    func testTheIdIsTakenWithoutTheSpacesAroundIt() {
        XCTAssertEqual(run([ctx(true, " a ")]), [[.sync("a")]])
        XCTAssertEqual(run([ctx(true, "a"), ctx(true, " a ")]), [[.sync("a")], []], "the same playlist")
    }

    // MARK: a sync that did not get through

    func testAFailedSyncIsTriedAgainAtTheNextChangeNotRightAway() {
        var trigger = PlaylistSyncTrigger()
        XCTAssertEqual(trigger.observe(ctx(true, "a")), [.sync("a")])
        trigger.rearm("a")
        XCTAssertEqual(trigger.observe(ctx(false, "a")), [], "not playing at this instant: nothing")
        XCTAssertEqual(trigger.observe(ctx(true, "a")), [.sync("a")], "the next song starts: try again")
        XCTAssertEqual(trigger.observe(ctx(true, "a")), [], "and then once")
    }

    func testRearmingOnlyCountsForThePlaylistThatIsStillTheQueue() {
        var trigger = PlaylistSyncTrigger()
        _ = trigger.observe(ctx(true, "a"))
        _ = trigger.observe(ctx(true, "b"))
        trigger.rearm("a")                                  // «a» is no longer the queue
        XCTAssertEqual(trigger.observe(ctx(true, "b")), [], "«b» was not asked to try again")
        trigger.rearm("zzz")                                // a playlist that never was
        XCTAssertEqual(trigger.observe(ctx(true, "b")), [])
    }
}
