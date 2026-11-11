import XCTest
@testable import Mondrop

/// The question «Da scaricare 3,4 GB (812 brani)» of a sync the person started on a page (the «Scarica tutta» of a playlist, spec
/// 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md §12, U20): the sync asks, the page puts it on the display, the answer goes back.
@MainActor
final class SizeQuestionPresenterTests: XCTestCase {
    private func aQuestion(_ name: String = "Road trip") -> SyncSizeQuestion {
        guard case .ask(let question) = SyncSizeGuard.decide(download: [TestSupport.track("a", bytes: 3_000_000_000)], limit: .gb2, playlistName: name) else {
            fatalError("3 GB over a 2 GB limit asks")
        }
        return question
    }

    private func untilAsked(_ presenter: SizeQuestionPresenter) async {
        for _ in 0..<1_000 where presenter.question == nil { try? await Task.sleep(nanoseconds: 2_000_000) }
    }

    func testTheQuestionIsOnScreenUntilItIsAnswered() async {
        let presenter = SizeQuestionPresenter()
        XCTAssertNil(presenter.question)
        let asking = Task { await presenter.ask(aQuestion()) }
        await untilAsked(presenter)
        XCTAssertEqual(presenter.question?.playlistName, "Road trip")
        presenter.answer(.limit)
        let choice = await asking.value
        XCTAssertEqual(choice, .limit)
        XCTAssertNil(presenter.question, "and it is gone once it is answered")
    }

    func testOnlyTheFirstAnswerCounts() async {
        let presenter = SizeQuestionPresenter()
        let asking = Task { await presenter.ask(aQuestion()) }
        await untilAsked(presenter)
        presenter.answer(.all)
        presenter.answer(.cancel)
        let choice = await asking.value
        XCTAssertEqual(choice, .all)
    }

    func testAnAnswerWithNoQuestionIsIgnored() {
        let presenter = SizeQuestionPresenter()
        presenter.answer(.all)
        XCTAssertNil(presenter.question)
    }

    func testOnlyOneQuestionAtATime() async {
        let presenter = SizeQuestionPresenter()
        let first = Task { await presenter.ask(aQuestion("First")) }
        await untilAsked(presenter)
        let second = await presenter.ask(aQuestion("Second"))
        XCTAssertNil(second, "a second question while one is waiting is not asked")
        XCTAssertEqual(presenter.question?.playlistName, "First", "the one on screen stays")
        presenter.answer(.all)
        let choice = await first.value
        XCTAssertEqual(choice, .all)
    }

    func testWithdrawingTheQuestionAnswersNobodyAndClearsIt() async {
        let presenter = SizeQuestionPresenter()
        let asking = Task { await presenter.ask(aQuestion()) }
        await untilAsked(presenter)
        presenter.withdraw()
        let choice = await asking.value
        XCTAssertNil(choice)
        XCTAssertNil(presenter.question)
        presenter.withdraw()           // nothing to withdraw: nothing happens
    }

    func testAfterAnAnswerTheNextQuestionIsAskedAsNew() async {
        let presenter = SizeQuestionPresenter()
        let first = Task { await presenter.ask(aQuestion("One")) }
        await untilAsked(presenter)
        presenter.answer(.all)
        _ = await first.value
        let second = Task { await presenter.ask(aQuestion("Two")) }
        await untilAsked(presenter)
        XCTAssertEqual(presenter.question?.playlistName, "Two")
        presenter.answer(.cancel)
        let choice = await second.value
        XCTAssertEqual(choice, .cancel)
    }
}
