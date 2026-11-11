import XCTest
@testable import Mondrop

/// «E comunque non deve sovrapporre le cose sotto, oppure deve sparire/nascondersi se navigo.» (Michele, 11 November; spec ...-simplify-playlists-and-song-states-design.md U13): the
/// mini player tucks away while the user scrolls down a page and comes back when they scroll up or reach the top. These tables are the rule.
final class MiniPlayerScrollRuleTests: XCTestCase {
    private func run(_ offsets: [Double]) -> MiniPlayerScrollRule {
        var rule = MiniPlayerScrollRule()
        for offset in offsets { rule.scrolled(to: offset) }
        return rule
    }

    func testItStartsShown() {
        XCTAssertFalse(MiniPlayerScrollRule().hidden)
    }

    func testAFewPointsDownDoNotHideIt() {
        XCTAssertFalse(run([0, 10, 20, 39]).hidden, "under \(MiniPlayerScrollRule.hideAfter) points")
    }

    func testScrollingDownFarEnoughHidesIt() {
        XCTAssertTrue(run([0, 20, 40, 60]).hidden)
        XCTAssertTrue(run([0, 20, 40]).hidden, "exactly the distance is enough")
        XCTAssertTrue(run([0, 12, 24, 36, 48]).hidden, "in small steps, the distance is what counts")
    }

    func testAJumpFarDownHidesItAtOnce() {
        XCTAssertTrue(run([0, 600]).hidden, "a scroll to the end")
    }

    func testScrollingBackUpBringsItBack() {
        XCTAssertTrue(run([0, 100, 90]).hidden, "10 points up are not enough")
        XCTAssertFalse(run([0, 100, 90, 80, 70]).hidden, "30 points up are: it is back")
    }

    func testExactlyTheDistanceBackUpIsEnough() {
        XCTAssertFalse(run([0, 100, 84]).hidden, "16 points up")
        XCTAssertTrue(run([0, 100, 85]).hidden, "15 points up")
    }

    func testTheDistanceBackUpIsMeasuredFromWhereTheDirectionChanged() {
        // down to 200, up a little to 190, down again to 220, up again: each turn starts a new measure
        XCTAssertTrue(run([0, 200, 190, 200, 220, 215]).hidden)
        XCTAssertFalse(run([0, 200, 190, 200, 220, 215, 200, 190]).hidden, "30 points back up from 220")
    }

    func testTheTopOfThePageAlwaysShowsIt() {
        XCTAssertFalse(run([0, 300, 200, 100, 8]).hidden, "back within the top zone")
        XCTAssertFalse(run([0, 300, -20]).hidden, "pulled past the top (the bounce)")
    }

    func testATremorOrTheBounceAtTheEndChangesNothing() {
        XCTAssertFalse(run([0, 30, 33, 31, 34, 32, 35, 33]).hidden, "a few points either way: every turn starts a new measure, and none goes far enough")
        XCTAssertTrue(run([0, 300, 305, 298, 303]).hidden, "the bounce at the end of the list does not bring it back")
    }

    func testResetBringsItBack() {
        var rule = run([0, 300])
        XCTAssertTrue(rule.hidden)
        rule.reset()
        XCTAssertFalse(rule.hidden)
        XCTAssertEqual(rule, MiniPlayerScrollRule())
    }

    func testTheSamePageScrolledTwiceIsTheSame() {
        XCTAssertEqual(run([0, 50, 100, 150]), run([0, 50, 100, 150]))
    }
}
