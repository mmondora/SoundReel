import XCTest
@testable import Mondrop

/// The list of playlists as the person asks for it (ADR-0023): the question the app sends, the answer it reads, the date beside the name,
/// and the model that keeps the pages (search, filter, sort, «more», an answer that is out of date).

/// A SoundReel that answers each question of the list from a script (in the order of the questions), counts them and — for a step marked
/// `hold` — keeps the answer until `release(_:)`: to see what the app does while it waits.
final class FakePlaylistTransport: PlaylistListTransport, @unchecked Sendable {
    struct Step {
        let result: Result<PlaylistPage, Error>
        var hold = false
    }

    private let lock = NSLock()
    private var script: [Step]
    private var _asked: [PlaylistListQuery] = []
    private var waiting: [Int: CheckedContinuation<Void, Never>] = [:]
    private var released: Set<Int> = []

    init(_ script: [Step]) { self.script = script }

    var asked: [PlaylistListQuery] { lock.withLock { _asked } }

    func playlistsPage(_ query: PlaylistListQuery) async throws -> PlaylistPage {
        let (index, step): (Int, Step) = lock.withLock {
            _asked.append(query)
            let i = _asked.count - 1
            return (i, script[min(i, script.count - 1)])
        }
        if step.hold {
            await withCheckedContinuation { continuation in
                let now: Bool = lock.withLock {
                    if released.contains(index) { return true }
                    waiting[index] = continuation
                    return false
                }
                if now { continuation.resume() }
            }
        }
        return try step.result.get()
    }

    func release(_ index: Int) {
        let continuation: CheckedContinuation<Void, Never>? = lock.withLock {
            released.insert(index)
            return waiting.removeValue(forKey: index)
        }
        continuation?.resume()
    }
}

final class PlaylistListTests: XCTestCase {
    // MARK: helpers

    private func playlist(_ id: String, name: String? = nil, created: String? = "2026-11-05T10:00:00.000Z", origin: String? = nil) -> MondropPlaylist {
        MondropPlaylist(id: id, name: name ?? id, songCount: 3, createdAt: created, updatedAt: created, origin: origin)
    }

    private func page(_ ids: [String], total: Int? = nil, offset: Int = 0) -> PlaylistPage {
        PlaylistPage(playlists: ids.map { playlist($0) }, total: total ?? ids.count, limit: 30, offset: offset)
    }

    private func step(_ ids: [String], total: Int? = nil, offset: Int = 0, hold: Bool = false) -> FakePlaylistTransport.Step {
        .init(result: .success(page(ids, total: total, offset: offset)), hold: hold)
    }

    @MainActor private func ids(_ model: PlaylistListModel) -> [String] { model.items.map(\.id) }

    /// These tests are about the pages the SERVER cuts for the sorts it knows: they start from the date of creation, the way the list opened before «Stato» existed
    /// (`PlaylistStateSortTests` has the state sort, the whole list it loads and the choice that is kept).
    @MainActor private func model(_ transport: FakePlaylistTransport, pageSize: Int = 30, delay: UInt64 = 0) -> PlaylistListModel {
        let name = "mondrop.test.playlistlist.\(UUID().uuidString)"
        let suite = UserDefaults(suiteName: name)!
        addTeardownBlock { suite.removePersistentDomain(forName: name) }
        let preferences = SortPreferences(defaults: suite)
        preferences.playlists = (.created, .desc)
        return PlaylistListModel(transport: transport, pageSize: pageSize, searchDelay: delay, preferences: preferences)
    }

    // MARK: the question

    func testTheQueryStringHasEveryParameterInTheDocumentedOrder() {
        let items = PlaylistListQuery().queryItems.map { "\($0.0)=\($0.1)" }
        XCTAssertEqual(items, ["filter=all", "sort=created", "order=desc", "limit=30", "offset=0"])

        let asked = PlaylistListQuery(text: "  jazz natale ", filter: .auto, sort: .name, order: .asc, limit: 10, offset: 20)
        XCTAssertEqual(asked.queryItems.map { "\($0.0)=\($0.1)" }, ["q=jazz natale", "filter=auto", "sort=name", "order=asc", "limit=10", "offset=20"])
    }

    func testNoTextIsNoSearchParameter() {
        XCTAssertFalse(PlaylistListQuery(text: "   ").queryItems.contains { $0.0 == "q" })
    }

    func testEverySortKnowsItsNaturalDirectionAndItsWords() {
        XCTAssertEqual(PlaylistSort.created.naturalOrder, .desc)
        XCTAssertEqual(PlaylistSort.updated.naturalOrder, .desc)
        XCTAssertEqual(PlaylistSort.size.naturalOrder, .desc)
        XCTAssertEqual(PlaylistSort.name.naturalOrder, .asc)
        XCTAssertEqual(PlaylistSort.created.orderTitle(.desc), "Più recenti prima")
        XCTAssertEqual(PlaylistSort.created.orderTitle(.asc), "Più vecchie prima")
        XCTAssertEqual(PlaylistSort.name.orderTitle(.asc), "Da A a Z")
        XCTAssertEqual(PlaylistFilter.allCases.map(\.rawValue), ["all", "auto", "mine", "shared", "dynamic"])
    }

    // MARK: the HTTP layer

    private func api() -> MondropAPI {
        MondropAPI(session: StubURLProtocol.session(), config: { MondropAPIConfig(baseURL: "https://soundreel.test/", apiKey: "sr_test_key_0123456789abcdef", user: "mike") })
    }

    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testThePageIsAskedWithTheParametersAndTheUserHintLast() async throws {
        StubURLProtocol.handler = { _ in
            (200, Data(#"{"playlists":[{"id":"a","name":"Jazz da ascoltare","songCount":12,"createdAt":"2026-11-09T10:00:00.000Z","origin":"auto","autoKind":"theme","canEdit":true}],"user":"mike","total":41,"limit":30,"offset":30}"#.utf8))
        }
        let result = try await api().playlistsPage(PlaylistListQuery(text: "jazz", filter: .auto, sort: .created, order: .desc, limit: 30, offset: 30))
        let request = try XCTUnwrap(StubURLProtocol.captured.last?.request)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/mondrop/playlists")
        let names = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems?.map { "\($0.name)=\($0.value ?? "")" }
        XCTAssertEqual(names, ["q=jazz", "filter=auto", "sort=created", "order=desc", "limit=30", "offset=30", "user=mike"])
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-SoundReel-Key"), "sr_test_key_0123456789abcdef")
        XCTAssertEqual(result.total, 41)
        XCTAssertEqual(result.offset, 30)
        XCTAssertEqual(result.playlists.first?.isAuto, true)
        XCTAssertEqual(result.playlists.first?.autoKind, "theme")
        XCTAssertEqual(result.playlists.first?.createdAt, "2026-11-09T10:00:00.000Z")
    }

    func testAnOldServerAnswersWithoutATotalAndThePageIsItsWholeList() async throws {
        StubURLProtocol.handler = { _ in
            (200, Data(#"{"playlists":[{"id":"a","name":"A","songCount":1},{"id":"b","name":"B","songCount":2}],"user":"mike"}"#.utf8))
        }
        let result = try await api().playlistsPage(PlaylistListQuery())
        XCTAssertEqual(result.total, 2)
        XCTAssertEqual(result.playlists.count, 2)
        XCTAssertNil(result.limit)
        XCTAssertEqual(result.playlists[0].isAuto, false)
        XCTAssertNil(result.playlists[0].createdAt)
    }

    func testTheOldWholeListCallStillWorksAndIgnoresTheNewFields() async throws {
        StubURLProtocol.handler = { _ in
            (200, Data(#"{"playlists":[{"id":"a","name":"A","songCount":1,"origin":"auto","total":99}],"user":"mike","total":1,"limit":null,"offset":0}"#.utf8))
        }
        let all = try await api().listPlaylists()
        XCTAssertEqual(all.map(\.id), ["a"])
        let request = try XCTUnwrap(StubURLProtocol.captured.last?.request)
        // the call that every other screen makes has NO list parameter: the answer is the whole list, as before
        XCTAssertEqual(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems?.map(\.name), ["user"])
    }

    // MARK: the date beside the name

    func testTheDateOfCreationIsWrittenTheWayAPersonSaysIt() {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let now = ISO8601DateFormatter().date(from: "2026-11-10T12:00:00Z")!
        func text(_ iso: String?) -> String { PlaylistDateText.text(iso, now: now, calendar: utc) }
        XCTAssertEqual(text("2026-11-10T08:30:00.000Z"), "oggi")
        XCTAssertEqual(text("2026-11-09T23:59:00.000Z"), "ieri")
        XCTAssertEqual(text("2026-11-05T10:00:00.000Z"), "5 nov")
        XCTAssertEqual(text("2025-12-24T10:00:00.000Z"), "24 dic 2025")
        // without the milliseconds too
        XCTAssertEqual(text("2026-11-05T10:00:00Z"), "5 nov")
    }

    func testAnUnreadableOrMissingDateIsNoTextAtAll() {
        XCTAssertEqual(PlaylistDateText.text(nil), "")
        XCTAssertEqual(PlaylistDateText.text(""), "")
        XCTAssertEqual(PlaylistDateText.text("non è una data"), "")
    }

    // MARK: the model

    @MainActor func testTheFirstPageIsTheNewestFirstAndFillsTheList() async {
        let transport = FakePlaylistTransport([step(["a", "b"])])
        let model = model(transport)
        await model.reload()
        XCTAssertEqual(ids(model), ["a", "b"])
        XCTAssertEqual(model.total, 2)
        XCTAssertFalse(model.hasMore)
        XCTAssertFalse(model.loading)
        XCTAssertEqual(transport.asked, [PlaylistListQuery(text: "", filter: .all, sort: .created, order: .desc, limit: 30, offset: 0)])
    }

    @MainActor func testMoreAsksTheNextPageAndAddsItNeverTheSamePlaylistTwice() async {
        let transport = FakePlaylistTransport([step(["a", "b"], total: 4), step(["b", "c"], total: 4, offset: 2)])
        let model = model(transport, pageSize: 2)
        await model.reload()
        XCTAssertTrue(model.hasMore)
        await model.loadMore()
        // «b» came again (a playlist made meanwhile shifted the pages)
        XCTAssertEqual(ids(model), ["a", "b", "c"])
        XCTAssertEqual(transport.asked.last?.offset, 2)
        XCTAssertEqual(transport.asked.last?.limit, 2)
    }

    @MainActor func testMoreDoesNothingWhenThereIsNoMore() async {
        let transport = FakePlaylistTransport([step(["a"], total: 1)])
        let model = model(transport)
        await model.reload()
        await model.loadMore()
        XCTAssertEqual(transport.asked.count, 1)
    }

    @MainActor func testAFilterAndASortStartAgainFromTheFirstPage() async {
        let transport = FakePlaylistTransport([step(["a"], total: 90), step(["a"], total: 90, offset: 0)])
        let model = model(transport, pageSize: 30)
        await model.reload()
        await model.loadMore()          // a second page is on the screen
        model.setFilter(.auto)
        await model.work?.value
        XCTAssertEqual(transport.asked.last, PlaylistListQuery(text: "", filter: .auto, sort: .created, order: .desc, limit: 30, offset: 0))
        model.setSort(.name)
        await model.work?.value
        // choosing a sort puts its natural direction
        XCTAssertEqual(transport.asked.last?.sort, .name)
        XCTAssertEqual(transport.asked.last?.order, .asc)
        model.toggleOrder()
        await model.work?.value
        XCTAssertEqual(transport.asked.last?.order, .desc)
        XCTAssertEqual(transport.asked.last?.offset, 0)
    }

    @MainActor func testTheSameFilterOrSortIsNotAskedAgain() async {
        let transport = FakePlaylistTransport([step(["a"])])
        let model = model(transport)
        await model.reload()
        model.setFilter(.all)
        model.setSort(.created)
        await model.work?.value
        XCTAssertEqual(transport.asked.count, 1)
    }

    @MainActor func testTheSearchWaitsForAPauseInTheTypingAndAsksOnce() async {
        let transport = FakePlaylistTransport([step(["a"])])
        let model = model(transport, delay: 200_000_000)
        model.setText("ja")
        model.setText("jazz")
        try? await Task.sleep(nanoseconds: 40_000_000)
        XCTAssertTrue(transport.asked.isEmpty, "the server is not asked while the person is still typing")
        await model.work?.value
        XCTAssertEqual(transport.asked.count, 1)
        XCTAssertEqual(transport.asked.first?.text, "jazz")
        XCTAssertTrue(model.narrowed)
    }

    @MainActor func testAnAnswerThatIsAlreadyOutOfDateIsIgnored() async {
        // the first question is slow; the person changes the filter; the second answers; then the first arrives last
        let transport = FakePlaylistTransport([step(["stale"], hold: true), step(["fresh"])])
        let model = model(transport)
        let first = Task { await model.reload() }
        while transport.asked.isEmpty { await Task.yield() }
        model.setFilter(.auto)
        await model.work?.value
        XCTAssertEqual(ids(model), ["fresh"])
        transport.release(0)
        await first.value
        XCTAssertEqual(ids(model), ["fresh"])
        XCTAssertFalse(model.loading)
    }

    @MainActor func testWhenTheServerDoesNotAnswerTheSameQuestionKeepsItsListButAnotherOneDoesNot() async {
        let transport = FakePlaylistTransport([
            step(["a", "b"]),
            .init(result: .failure(MondropAPIError.transport("offline"))),
            .init(result: .failure(MondropAPIError.transport("offline"))),
        ])
        let model = model(transport)
        await model.reload()
        await model.reload()                    // the same question fails: the list on the screen stays
        XCTAssertEqual(ids(model), ["a", "b"])
        XCTAssertEqual(model.failure, "offline")
        model.setFilter(.shared)                // another question fails: the list of the first would be a lie
        await model.work?.value
        XCTAssertEqual(ids(model), [])
        XCTAssertEqual(model.total, 0)
        XCTAssertNotNil(model.failure)
    }

    @MainActor func testASuccessClearsTheFailure() async {
        let transport = FakePlaylistTransport([.init(result: .failure(MondropAPIError.transport("offline"))), step(["a"])])
        let model = model(transport)
        await model.reload()
        XCTAssertNotNil(model.failure)
        await model.reload()
        XCTAssertNil(model.failure)
        XCTAssertEqual(ids(model), ["a"])
    }

    @MainActor func testNarrowedMeansASearchOrAFilterIsOn() async {
        let model = model(FakePlaylistTransport([step([])]))
        XCTAssertFalse(model.narrowed)
        model.setFilter(.mine)
        XCTAssertTrue(model.narrowed)
        model.setFilter(.all)
        XCTAssertFalse(model.narrowed)
        model.setText("  ")
        XCTAssertFalse(model.narrowed)
        await model.work?.value
    }
}
