import XCTest
@testable import Mondrop

/// «sul play voglio anche il "loop" del singolo o della playlist» (Michele, 12 November; spec 2026-11-12-mondrop-home-play-loop-reels-design.md M2): the loop is reached from the
/// play (a long press on the play button of the mini player and of «Riprendi»), and the play shows a small mark when the loop is on. The choices and the mark are plain data here.
final class RepeatChoiceTests: XCTestCase {
    func testThereAreThreeChoicesInTheOrderOfTheCycle() {
        XCTAssertEqual(RepeatChoice.all(current: .off, forPlaylist: true).map(\.mode), [.off, .all, .one])
        XCTAssertEqual(RepeatChoice.all(current: .off, forPlaylist: true).map(\.mode), RepeatMode.allCases, "the same three states the Player's button goes round")
    }

    func testTheWordsAreMicheles() {
        let titles = RepeatChoice.all(current: .off, forPlaylist: true).map(\.title)
        XCTAssertEqual(titles, ["Non ripetere", "Ripeti la playlist", "Ripeti questo brano"])
    }

    func testAQueueThatIsNotAPlaylistIsCalledAQueue() {
        let titles = RepeatChoice.all(current: .off, forPlaylist: false).map(\.title)
        XCTAssertEqual(titles, ["Non ripetere", "Ripeti la coda", "Ripeti questo brano"], "«la playlist» would be wrong for a search or an album")
    }

    func testOnlyTheModeInUseIsSelected() {
        for current in RepeatMode.allCases {
            let choices = RepeatChoice.all(current: current, forPlaylist: true)
            XCTAssertEqual(choices.filter(\.isSelected).map(\.mode), [current], "current: \(current)")
        }
    }

    func testTheSelectedChoiceShowsACheckmarkAndTheOthersTheirOwnSymbol() {
        let choices = RepeatChoice.all(current: .all, forPlaylist: true)
        XCTAssertEqual(choices.first { $0.mode == .all }?.systemImage, "checkmark")
        XCTAssertEqual(choices.first { $0.mode == .one }?.systemImage, "repeat.1")
        XCTAssertNotEqual(choices.first { $0.mode == .off }?.systemImage, "checkmark")
    }

    func testEveryChoiceIdentifiesItself() {
        let ids = RepeatChoice.all(current: .one, forPlaylist: false).map(\.id)
        XCTAssertEqual(Set(ids).count, 3)
    }

    // MARK: the mark on the play

    func testThePlayHasNoMarkWhenTheLoopIsOff() {
        XCTAssertNil(RepeatMode.off.indicatorSymbol)
        XCTAssertNil(RepeatMode.off.indicatorLabel)
    }

    func testThePlayShowsTheLoopOfTheWholeQueueOrOfThisSong() {
        XCTAssertEqual(RepeatMode.all.indicatorSymbol, "repeat")
        XCTAssertEqual(RepeatMode.one.indicatorSymbol, "repeat.1")
    }

    func testTheMarkIsHeardByVoiceOver() {
        XCTAssertEqual(RepeatMode.all.indicatorLabel, RepeatMode.all.accessibilityLabel)
        XCTAssertEqual(RepeatMode.one.indicatorLabel, RepeatMode.one.accessibilityLabel)
    }
}
