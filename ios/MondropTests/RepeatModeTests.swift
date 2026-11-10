import MediaPlayer
import XCTest
@testable import Mondrop

/// The loop (spec 2026-11-10-mondrop-like-and-repeat-design.md L4): three states that go round (none → all → this song → none), and
/// what the player does when a song ends by itself and when the user (or the car) presses «avanti». Pure code: no AVPlayer in here.
final class RepeatModeTests: XCTestCase {
    // MARK: the button

    func testTheButtonGoesRoundNoneAllThisSongNone() {
        XCTAssertEqual(RepeatMode.off.next, .all)
        XCTAssertEqual(RepeatMode.all.next, .one)
        XCTAssertEqual(RepeatMode.one.next, .off)
    }

    func testEveryStateSaysItselfInItalianForVoiceOver() {
        XCTAssertEqual(RepeatMode.off.accessibilityLabel, "Ripeti: no")
        XCTAssertEqual(RepeatMode.all.accessibilityLabel, "Ripeti: tutto")
        XCTAssertEqual(RepeatMode.one.accessibilityLabel, "Ripeti: questo brano")
    }

    func testThreeStatesAndNoMore() {
        XCTAssertEqual(RepeatMode.allCases, [.off, .all, .one])
    }

    // MARK: when a song ends by itself

    func testWithTheLoopOffASongEndsIntoTheNextAndTheQueueStopsAtTheEnd() {
        XCTAssertEqual(RepeatPolicy.whenSongEnds(mode: .off, index: 0, count: 3), .play(1))
        XCTAssertEqual(RepeatPolicy.whenSongEnds(mode: .off, index: 1, count: 3), .play(2))
        XCTAssertEqual(RepeatPolicy.whenSongEnds(mode: .off, index: 2, count: 3), .stop, "as before: the queue ends")
        XCTAssertEqual(RepeatPolicy.whenSongEnds(mode: .off, index: 0, count: 1), .stop)
    }

    func testWithTheWholeQueueLoopingTheLastSongEndsIntoTheFirst() {
        XCTAssertEqual(RepeatPolicy.whenSongEnds(mode: .all, index: 0, count: 3), .play(1))
        XCTAssertEqual(RepeatPolicy.whenSongEnds(mode: .all, index: 2, count: 3), .play(0), "«a fine coda si ricomincia dal primo»")
    }

    func testAQueueOfOneSongWithTheWholeQueueLoopingBehavesAsThisSong() {
        XCTAssertEqual(RepeatPolicy.whenSongEnds(mode: .all, index: 0, count: 1), .replay)
    }

    func testWithThisSongLoopingTheSongStartsAgainWhereverItIs() {
        for index in 0..<3 { XCTAssertEqual(RepeatPolicy.whenSongEnds(mode: .one, index: index, count: 3), .replay, "song \(index)") }
        XCTAssertEqual(RepeatPolicy.whenSongEnds(mode: .one, index: 0, count: 1), .replay)
    }

    // MARK: «avanti» (the button, the car, the lock screen)

    func testAvantiGoesToTheNextSongWhateverTheLoopIs() {
        for mode in RepeatMode.allCases {
            XCTAssertEqual(RepeatPolicy.whenNext(mode: mode, index: 0, count: 3), .play(1), "\(mode)")
            XCTAssertEqual(RepeatPolicy.whenNext(mode: mode, index: 1, count: 3), .play(2), "\(mode)")
        }
    }

    func testAvantiOnTheLastSongWrapsOnlyWhenTheWholeQueueLoops() {
        XCTAssertEqual(RepeatPolicy.whenNext(mode: .all, index: 2, count: 3), .play(0))
        XCTAssertEqual(RepeatPolicy.whenNext(mode: .off, index: 2, count: 3), .stop, "as before")
        XCTAssertEqual(RepeatPolicy.whenNext(mode: .one, index: 2, count: 3), .stop, "«avanti» goes to the song after, and there is none")
    }

    func testAvantiOnAQueueOfOneSongWithTheWholeQueueLoopingStartsItAgain() {
        XCTAssertEqual(RepeatPolicy.whenNext(mode: .all, index: 0, count: 1), .replay)
        XCTAssertEqual(RepeatPolicy.whenNext(mode: .off, index: 0, count: 1), .stop)
        XCTAssertEqual(RepeatPolicy.whenNext(mode: .one, index: 0, count: 1), .stop)
    }

    // MARK: nothing queued, or a position outside the queue

    func testAnEmptyQueueNeverPlaysAnything() {
        for mode in RepeatMode.allCases {
            XCTAssertEqual(RepeatPolicy.whenSongEnds(mode: mode, index: 0, count: 0), .stop, "\(mode)")
            XCTAssertEqual(RepeatPolicy.whenNext(mode: mode, index: 0, count: 0), .stop, "\(mode)")
        }
    }

    func testAPositionPastTheEndIsTheEnd() {
        XCTAssertEqual(RepeatPolicy.whenSongEnds(mode: .all, index: 7, count: 3), .play(0))
        XCTAssertEqual(RepeatPolicy.whenSongEnds(mode: .off, index: 7, count: 3), .stop)
        XCTAssertEqual(RepeatPolicy.whenNext(mode: .all, index: 7, count: 3), .play(0))
    }

    // MARK: what the phone keeps

    private func defaults() -> (UserDefaults, String) {
        let suite = "mondrop.test.repeat.\(UUID().uuidString)"
        return (UserDefaults(suiteName: suite)!, suite)
    }

    func testTheChoiceIsKeptBetweenLaunches() {
        let (defaults, suite) = defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = DefaultsRepeatModeStore(defaults: defaults)
        XCTAssertEqual(first.mode, .off, "nothing chosen yet: the loop is off, as it always was")
        first.mode = .one
        XCTAssertEqual(DefaultsRepeatModeStore(defaults: defaults).mode, .one, "a new launch finds it")
        first.mode = .all
        XCTAssertEqual(DefaultsRepeatModeStore(defaults: defaults).mode, .all)
    }

    func testSomethingUnreadableInTheDefaultsIsTheLoopOff() {
        let (defaults, suite) = defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("pippo", forKey: DefaultsRepeatModeStore.key)
        XCTAssertEqual(DefaultsRepeatModeStore(defaults: defaults).mode, .off)
        defaults.set(3, forKey: DefaultsRepeatModeStore.key)
        XCTAssertEqual(DefaultsRepeatModeStore(defaults: defaults).mode, .off)
    }

    func testTheStoreWritesUnderOneKeyOfItsOwn() {
        let (defaults, suite) = defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        DefaultsRepeatModeStore(defaults: defaults).mode = .one
        XCTAssertEqual(defaults.string(forKey: "repeatMode"), "one")
    }

    // MARK: what the system calls it (the car, the lock screen)

    func testTheSystemsRepeatTypesMapOneToOne() {
        XCTAssertEqual(RepeatMode(.off), .off)
        XCTAssertEqual(RepeatMode(.all), .all)
        XCTAssertEqual(RepeatMode(.one), .one)
        XCTAssertEqual(RepeatMode.off.systemType, MPRepeatType.off)
        XCTAssertEqual(RepeatMode.all.systemType, MPRepeatType.all)
        XCTAssertEqual(RepeatMode.one.systemType, MPRepeatType.one)
        for mode in RepeatMode.allCases { XCTAssertEqual(RepeatMode(mode.systemType), mode) }
    }
}
