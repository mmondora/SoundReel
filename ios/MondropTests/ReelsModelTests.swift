import XCTest
@testable import Mondrop

/// The tab «Reel» (spec 2026-11-12-mondrop-home-play-loop-reels-design.md M5): the list the server composes a page at a time, the categories to choose from, and what the screen shows when
/// it fails. Only the network: nothing of a reel is kept on the phone (the music is, as every song is).
@MainActor
final class ReelsModelTests: XCTestCase {
    /// Pages and details scripted by the question asked; every question is recorded as «category|offset|f» (`f` = the categories were asked for too).
    private final class FakeReels: ReelsTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var pages: [String: Result<ReelPage, Error>] = [:]
        private var delays: [String: UInt64] = [:]
        private var details: [String: Result<ReelDetail, Error>] = [:]
        private var _asks: [String] = []
        private var _limits: [Int] = []
        var asks: [String] { lock.withLock { _asks } }
        var limits: [Int] { lock.withLock { _limits } }

        func script(_ key: String, _ result: Result<ReelPage, Error>, delay: UInt64 = 0) {
            lock.withLock { pages[key] = result; delays[key] = delay }
        }
        func scriptDetail(_ id: String, _ result: Result<ReelDetail, Error>) { lock.withLock { details[id] = result } }

        func reels(limit: Int, offset: Int, kind: ReelKind?, facets: Bool) async throws -> ReelPage {
            let key = "\(kind?.raw ?? "all")|\(offset)|\(facets ? "f" : "-")"
            let (result, delay): (Result<ReelPage, Error>?, UInt64) = lock.withLock {
                _asks.append(key)
                _limits.append(limit)
                return (pages[key], delays[key] ?? 0)
            }
            if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
            guard let result else { throw MondropAPIError.http(500, "no script for \(key)") }
            return try result.get()
        }

        func reel(id: String) async throws -> ReelDetail {
            let result = lock.withLock { details[id] }
            guard let result else { throw MondropAPIError.http(404, nil) }
            return try result.get()
        }
    }

    private func card(_ id: String) -> ReelCard {
        ReelCard(id: id, createdAt: "2026-11-12T08:00:00Z", platform: "instagram", summary: "Spiegazione di \(id)", imagePath: nil, counts: [])
    }

    private func page(_ ids: [String], total: Int, offset: Int = 0, kinds: [ReelKindCount] = []) -> ReelPage {
        ReelPage(total: total, limit: ReelsModel.pageSize, offset: offset, kinds: kinds, reels: ids.map(card))
    }

    private let kinds = [
        ReelKindCount(kind: .music, label: "Musica", count: 7, names: []),
        ReelKindCount(kind: .film, label: "Film", count: 3, names: []),
    ]

    // MARK: the first page

    func testTheFirstPageComesWithTheCategoriesToChooseFrom() async {
        let fake = FakeReels()
        fake.script("all|0|f", .success(page(["a", "b"], total: 5, kinds: kinds)))
        let model = ReelsModel(transport: fake)

        await model.load()

        XCTAssertEqual(fake.asks, ["all|0|f"])
        XCTAssertEqual(fake.limits, [ReelsModel.pageSize])
        XCTAssertEqual(model.reels.map(\.id), ["a", "b"])
        XCTAssertEqual(model.total, 5)
        XCTAssertEqual(model.kinds.map(\.kind), [.music, .film])
        XCTAssertEqual(model.phase, .loaded)
        XCTAssertEqual(model.screen, .reels)
        XCTAssertNil(model.failure)
        XCTAssertTrue(model.hasMore)
    }

    func testPagesAreTwentyAtATime() {
        XCTAssertEqual(ReelsModel.pageSize, 20)
    }

    func testNothingToShowIsAnEmptyScreenNotAFailedOne() async {
        let fake = FakeReels()
        fake.script("all|0|f", .success(page([], total: 0)))
        let model = ReelsModel(transport: fake)

        await model.load()

        XCTAssertEqual(model.screen, .empty)
        XCTAssertFalse(model.hasMore)
    }

    func testBeforeTheFirstAnswerTheScreenIsLoading() {
        let model = ReelsModel(transport: FakeReels())
        XCTAssertEqual(model.screen, .loading)
    }

    // MARK: more

    func testMoreComesAfterWhatIsHeldAndNoReelIsShownTwice() async {
        let fake = FakeReels()
        fake.script("all|0|f", .success(page(["a", "b", "c"], total: 5, kinds: kinds)))
        fake.script("all|3|-", .success(page(["c", "d"], total: 5, offset: 3)))       // a new reel pushed «c» to the next page
        let model = ReelsModel(transport: fake)

        await model.load()
        await model.loadMore()

        XCTAssertEqual(fake.asks, ["all|0|f", "all|3|-"], "the next page starts where the list ends, and the categories are not asked again")
        XCTAssertEqual(model.reels.map(\.id), ["a", "b", "c", "d"], "«c» once")
        XCTAssertFalse(model.loadingMore)
    }

    func testThereIsNoNextPageWhenEverythingIsHeld() async {
        let fake = FakeReels()
        fake.script("all|0|f", .success(page(["a", "b"], total: 2)))
        let model = ReelsModel(transport: fake)

        await model.load()
        XCTAssertFalse(model.hasMore)
        await model.loadMore()

        XCTAssertEqual(fake.asks, ["all|0|f"], "nothing is asked when there is nothing more")
    }

    func testAFailedNextPageKeepsTheListAndSaysSo() async {
        let fake = FakeReels()
        fake.script("all|0|f", .success(page(["a", "b"], total: 9)))
        fake.script("all|2|-", .failure(MondropAPIError.transport("offline")))
        let model = ReelsModel(transport: fake)

        await model.load()
        await model.loadMore()

        XCTAssertEqual(model.reels.map(\.id), ["a", "b"])
        XCTAssertNotNil(model.failure)
        XCTAssertEqual(model.screen, .reels)
    }

    // MARK: a category

    func testChoosingACategoryStartsAgainFromTheFirstPageOfThatCategory() async {
        let fake = FakeReels()
        fake.script("all|0|f", .success(page(["a", "b"], total: 9, kinds: kinds)))
        fake.script("film|0|-", .success(page(["f1"], total: 3)))
        fake.script("all|0|-", .success(page(["a", "b"], total: 9)))
        let model = ReelsModel(transport: fake)

        await model.load()
        await model.select(.film)

        XCTAssertEqual(model.selected, .film)
        XCTAssertEqual(model.reels.map(\.id), ["f1"])
        XCTAssertEqual(model.total, 3)
        XCTAssertEqual(model.kinds.map(\.kind), [.music, .film], "the choices of the categories stay: they count all the reels, not the ones of the page")

        await model.select(nil)
        XCTAssertNil(model.selected)
        XCTAssertEqual(model.reels.map(\.id), ["a", "b"])
        XCTAssertEqual(fake.asks, ["all|0|f", "film|0|-", "all|0|-"])
    }

    func testChoosingTheCategoryAlreadyChosenAsksNothing() async {
        let fake = FakeReels()
        fake.script("all|0|f", .success(page(["a"], total: 1, kinds: kinds)))
        let model = ReelsModel(transport: fake)

        await model.load()
        await model.select(nil)

        XCTAssertEqual(fake.asks, ["all|0|f"])
    }

    func testAnAnswerForACategoryThatWasLeftIsIgnored() async {
        let fake = FakeReels()
        fake.script("all|0|f", .success(page(["a"], total: 1, kinds: kinds)))
        fake.script("film|0|-", .success(page(["slow-film"], total: 1)), delay: 250_000_000)      // slow
        fake.script("music|0|-", .success(page(["quick-music"], total: 1)))
        let model = ReelsModel(transport: fake)
        await model.load()

        let first = Task { await model.select(.film) }
        try? await Task.sleep(nanoseconds: 40_000_000)
        await model.select(.music)
        await first.value

        XCTAssertEqual(model.selected, .music)
        XCTAssertEqual(model.reels.map(\.id), ["quick-music"], "the late answer of «film» does not overwrite the list the person is looking at")
    }

    // MARK: when it goes wrong

    func testNoAnswerAtAllIsAFailedScreenWithTheReason() async {
        let fake = FakeReels()
        fake.script("all|0|f", .failure(MondropAPIError.transport("The Internet connection appears to be offline.")))
        let model = ReelsModel(transport: fake)

        await model.load()

        XCTAssertEqual(model.screen, .failed("Serve la rete per leggere i reel."), "it needs the network: nothing of a reel is kept on the phone")
        XCTAssertTrue(model.reels.isEmpty)
    }

    func testAFailedReloadLeavesWhatIsOnScreen() async {
        let fake = FakeReels()
        fake.script("all|0|f", .success(page(["a", "b"], total: 2, kinds: kinds)))
        let model = ReelsModel(transport: fake)
        await model.load()

        fake.script("all|0|f", .failure(MondropAPIError.http(500, "boom")))
        await model.load()

        XCTAssertEqual(model.reels.map(\.id), ["a", "b"], "a stale list is better than a blank one")
        XCTAssertEqual(model.screen, .reels)
        XCTAssertNotNil(model.failure)
    }

    func testAServerWithoutTheRoutesIsAskedToUpdate() async {
        let fake = FakeReels()
        fake.script("all|0|f", .failure(MondropAPIError.http(404, "Not Found")))
        let model = ReelsModel(transport: fake)

        await model.load()

        XCTAssertEqual(model.phase, .needsNewerServer)
        XCTAssertEqual(model.screen, .needsNewerServer)
        XCTAssertEqual(ReelsModel.needsNewerServerText, "Serve un SoundReel più recente")
    }

    func testAnOtherServerErrorIsSaidWithItsOwnWords() async {
        let fake = FakeReels()
        fake.script("all|0|f", .failure(MondropAPIError.http(500, "boom")))
        let model = ReelsModel(transport: fake)

        await model.load()

        guard case .failed(let text) = model.screen else { return XCTFail("a failed screen, not \(model.screen)") }
        XCTAssertFalse(text.isEmpty)
    }

    // MARK: the page of one reel

    func testTheDetailLoads() async throws {
        let fake = FakeReels()
        fake.scriptDetail("r1", .success(try JSONDecoder().decode(ReelDetail.self, from: Data(#"{"id":"r1","summary":"Di cosa parla"}"#.utf8))))
        let model = ReelDetailModel(id: "r1", transport: fake)

        await model.load()

        XCTAssertEqual(model.phase, .loaded)
        XCTAssertEqual(model.detail?.summary, "Di cosa parla")
    }

    func testAReelThatIsNotThereAnymoreSaysSo() async {
        let model = ReelDetailModel(id: "gone", transport: FakeReels())      // no script: 404

        await model.load()

        XCTAssertEqual(model.phase, .gone)
        XCTAssertNil(model.detail)
        XCTAssertEqual(ReelDetailModel.goneText, "Questo reel non c'è più.")
    }

    func testAFailedReloadOfTheDetailLeavesWhatWasRead() async throws {
        let fake = FakeReels()
        fake.scriptDetail("r1", .success(try JSONDecoder().decode(ReelDetail.self, from: Data(#"{"id":"r1","summary":"Di cosa parla"}"#.utf8))))
        let model = ReelDetailModel(id: "r1", transport: fake)
        await model.load()

        fake.scriptDetail("r1", .failure(MondropAPIError.transport("offline")))
        await model.load()

        XCTAssertEqual(model.detail?.summary, "Di cosa parla")
        XCTAssertEqual(model.phase, .loaded)
        XCTAssertNotNil(model.failure)
    }

    func testNoNetworkOnTheFirstReadOfTheDetailIsAFailure() async {
        let fake = FakeReels()
        fake.scriptDetail("r1", .failure(MondropAPIError.transport("offline")))
        let model = ReelDetailModel(id: "r1", transport: fake)

        await model.load()

        XCTAssertEqual(model.phase, .failed("Serve la rete per leggere i reel."))
    }
}
