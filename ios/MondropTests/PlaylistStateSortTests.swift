import XCTest
@testable import Mondrop

/// «Voglio in tutte le playlist anche degli ordinamenti tipo : data di creazione, nome, stato ( locali o online )» (Michele, 11 November, after build 18, «Tutti e due»; spec
/// 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md §12, U17): the list of playlists has «Stato» among its sorts. It is the phone's own (the server does not know which
/// files this phone holds), so it asks the server for the date of creation and loads every page before it is done — a partition by state is only right over the whole list — and
/// the other sorts are the server's and nothing goes in front of them. The choice is kept.
@MainActor
final class PlaylistStateSortTests: XCTestCase {
    private func playlist(_ id: String) -> MondropPlaylist {
        MondropPlaylist(id: id, name: id, songCount: 3, createdAt: "2026-11-05T10:00:00.000Z", updatedAt: "2026-11-05T10:00:00.000Z", origin: nil)
    }

    private func step(_ ids: [String], total: Int, offset: Int = 0, hold: Bool = false) -> FakePlaylistTransport.Step {
        .init(result: .success(PlaylistPage(playlists: ids.map(playlist), total: total, limit: 100, offset: offset)), hold: hold)
    }

    private func defaults() -> UserDefaults {
        let name = "mondrop.test.statesort.\(UUID().uuidString)"
        let suite = UserDefaults(suiteName: name)!
        addTeardownBlock { suite.removePersistentDomain(forName: name) }
        return suite
    }

    private func model(_ transport: FakePlaylistTransport, pageSize: Int = 30, preferences: SortPreferences? = nil) -> PlaylistListModel {
        PlaylistListModel(transport: transport, pageSize: pageSize, searchDelay: 0, preferences: preferences)
    }

    private func ids(_ model: PlaylistListModel) -> [String] { model.items.map(\.id) }

    // MARK: the question

    func testTheStateSortIsTheAppsOwnAndTheServerIsAskedForTheDateOfCreationInsideIt() {
        for order in [PlaylistOrder.asc, .desc] {
            let items = PlaylistListQuery(sort: .state, order: order).queryItems.map { "\($0.0)=\($0.1)" }
            XCTAssertEqual(items, ["filter=all", "sort=created", "order=desc", "limit=30", "offset=0"], "\(order): the server never hears «state»")
        }
        // every other sort is sent as it is
        XCTAssertEqual(PlaylistListQuery(sort: .name, order: .asc).queryItems.map { "\($0.0)=\($0.1)" }, ["filter=all", "sort=name", "order=asc", "limit=30", "offset=0"])
    }

    func testTheStateSortHasItsPlaceAndItsWords() {
        XCTAssertEqual(PlaylistSort.allCases.map(\.rawValue), ["state", "created", "updated", "name", "size"], "first in the menu: it is the one the list opens on")
        XCTAssertEqual(PlaylistSort.state.title, "Stato (sul telefono / online)")
        XCTAssertEqual(PlaylistSort.state.naturalOrder, .asc)
        XCTAssertEqual(PlaylistSort.state.orderTitle(.asc), "Sul telefono prima")
        XCTAssertEqual(PlaylistSort.state.orderTitle(.desc), "Online prima")
    }

    // MARK: the model

    func testTheListOpensOnTheStateSortWithTheOnesOnThePhoneFirst() {
        let model = model(FakePlaylistTransport([step([], total: 0)]))
        XCTAssertEqual(model.sort, .state)
        XCTAssertEqual(model.order, .asc)
    }

    func testTheStateSortAsksForTheNewestFirstInTheBiggestPagesTheServerGives() async {
        let transport = FakePlaylistTransport([step(["a", "b"], total: 2)])
        let model = model(transport, pageSize: 30)
        await model.reload()
        let asked = transport.asked
        XCTAssertEqual(asked.count, 1)
        XCTAssertEqual(asked.first?.queryItems.map { "\($0.0)=\($0.1)" }, ["filter=all", "sort=created", "order=desc", "limit=100", "offset=0"])
    }

    func testTheStateSortLoadsEveryPageBeforeItIsDone() async {
        let transport = FakePlaylistTransport([
            step(["a", "b"], total: 5), step(["c", "d"], total: 5, offset: 2), step(["e"], total: 5, offset: 4),
        ])
        let model = model(transport, pageSize: 2)
        await model.reload()
        XCTAssertEqual(ids(model), ["a", "b", "c", "d", "e"], "a partition by state is only right over the whole list")
        XCTAssertFalse(model.hasMore)
        XCTAssertEqual(transport.asked.map(\.offset), [0, 2, 4])
        XCTAssertFalse(model.loading)
        XCTAssertFalse(model.loadingMore)
    }

    func testAPageThatShiftsNeverShowsThePlaylistTwice() async {
        let transport = FakePlaylistTransport([step(["a", "b"], total: 4), step(["b", "c", "d"], total: 4, offset: 2)])
        let model = model(transport, pageSize: 2)
        await model.reload()
        XCTAssertEqual(ids(model), ["a", "b", "c", "d"])
    }

    func testAListThatCannotGrowStopsInsteadOfAskingForEver() async {
        // the server says there are 5 but keeps sending the same two: the loop does not wait for a page that will never come (the failure at the end is only there to stop a loop that does not stop)
        let transport = FakePlaylistTransport([
            step(["a", "b"], total: 5), step(["a", "b"], total: 5, offset: 2), step(["a", "b"], total: 5, offset: 2), step(["a", "b"], total: 5, offset: 2),
            .init(result: .failure(MondropAPIError.transport("it asked too many times"))),
        ])
        let model = model(transport, pageSize: 2)
        await model.reload()
        XCTAssertEqual(ids(model), ["a", "b"])
        XCTAssertEqual(transport.asked.count, 2, "one more page, which brought nothing new: it stops there")
        XCTAssertNil(model.failure)
    }

    func testAFailureInTheMiddleKeepsWhatIsLoadedAndSaysWhy() async {
        let transport = FakePlaylistTransport([step(["a", "b"], total: 4), .init(result: .failure(MondropAPIError.transport("offline")))])
        let model = model(transport, pageSize: 2)
        await model.reload()
        XCTAssertEqual(ids(model), ["a", "b"], "what came is not thrown away")
        XCTAssertEqual(model.failure, "offline")
        XCTAssertEqual(model.total, 4)
    }

    func testChoosingAnotherSortStopsTheLoadingOfTheRest() async {
        let transport = FakePlaylistTransport([
            step(["a", "b"], total: 6),
            step(["c", "d"], total: 6, offset: 2, hold: true),
            step(["z"], total: 1),
        ])
        let model = model(transport, pageSize: 2)
        let first = Task { await model.reload() }
        for _ in 0..<1_000 where transport.asked.count < 2 { try? await Task.sleep(nanoseconds: 2_000_000) }
        guard transport.asked.count >= 2 else {
            transport.release(1)
            return XCTFail("the second page of the state sort was never asked")
        }
        model.setSort(.name)
        await model.work?.value
        transport.release(1)
        await first.value
        XCTAssertEqual(ids(model), ["z"], "the page that arrived late belongs to a question nobody asks any more")
        XCTAssertEqual(transport.asked.count, 3, "and the old list loads no further pages")
        XCTAssertEqual(transport.asked.last?.sort, .name)
    }

    func testTheSortsTheServerKnowsKeepThePagesOfTheOrdinarySize() async {
        let suite = defaults()
        let preferences = SortPreferences(defaults: suite)
        preferences.playlists = (.created, .desc)
        let transport = FakePlaylistTransport([step(["a", "b"], total: 4)])
        let model = model(transport, pageSize: 2, preferences: preferences)
        await model.reload()
        XCTAssertEqual(ids(model), ["a", "b"])
        XCTAssertTrue(model.hasMore, "the server cuts the pages, the person asks for more")
        XCTAssertEqual(transport.asked, [PlaylistListQuery(text: "", filter: .all, sort: .created, order: .desc, limit: 2, offset: 0)])
    }

    func testChoosingStateAfterAServerSortLoadsTheWholeList() async {
        let suite = defaults()
        let preferences = SortPreferences(defaults: suite)
        preferences.playlists = (.name, .asc)
        let transport = FakePlaylistTransport([
            step(["a"], total: 3), step(["a", "b"], total: 3), step(["c"], total: 3, offset: 2),
        ])
        let model = model(transport, pageSize: 1, preferences: preferences)
        await model.reload()
        XCTAssertTrue(model.hasMore)
        model.setSort(.state)
        await model.work?.value
        XCTAssertEqual(ids(model), ["a", "b", "c"])
        XCTAssertFalse(model.hasMore)
    }

    // MARK: the choice is kept

    func testTheChoiceIsKeptBetweenLaunches() async {
        let suite = defaults()
        let first = model(FakePlaylistTransport([step([], total: 0)]), preferences: SortPreferences(defaults: suite))
        first.setSort(.name)
        await first.work?.value
        let second = model(FakePlaylistTransport([step([], total: 0)]), preferences: SortPreferences(defaults: suite))
        XCTAssertEqual(second.sort, .name)
        XCTAssertEqual(second.order, .asc)
    }

    func testTheDirectionIsKeptToo() async {
        let suite = defaults()
        let first = model(FakePlaylistTransport([step([], total: 0)]), preferences: SortPreferences(defaults: suite))
        first.toggleOrder()
        await first.work?.value
        let second = model(FakePlaylistTransport([step([], total: 0)]), preferences: SortPreferences(defaults: suite))
        XCTAssertEqual(second.sort, .state)
        XCTAssertEqual(second.order, .desc, "«Online prima» is what was chosen")
    }

    func testAnUnreadableChoiceOpensTheStateSort() {
        let suite = defaults()
        suite.set("zzz", forKey: SortPreferences.playlistSortKey)
        let model = model(FakePlaylistTransport([step([], total: 0)]), preferences: SortPreferences(defaults: suite))
        XCTAssertEqual(model.sort, .state)
    }
}
