import XCTest
@testable import Mondrop

/// The server's search endpoint, answered from a catalog with the same rules (LibraryCatalog) unless a test scripts it.
final class FakeSearch: SearchTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _queries: [SearchQuery] = []
    private var _catalog: [OfflineTrack]
    private var _failure: Error?
    private var _handler: ((SearchQuery) throws -> SearchPage)?
    private var _gate: (@Sendable (SearchQuery) async -> Void)?

    init(catalog: [OfflineTrack] = []) { _catalog = catalog }

    var queries: [SearchQuery] { lock.withLock { _queries } }
    func setCatalog(_ songs: [OfflineTrack]) { lock.withLock { _catalog = songs } }
    func fail(_ error: Error?) { lock.withLock { _failure = error } }
    func script(_ handler: ((SearchQuery) throws -> SearchPage)?) { lock.withLock { _handler = handler } }
    /// Runs (and may suspend) before a request is answered: lets a test make one answer arrive late.
    func gate(_ gate: (@Sendable (SearchQuery) async -> Void)?) { lock.withLock { _gate = gate } }

    func search(_ query: SearchQuery) async throws -> SearchPage {
        let (failure, handler, catalog, gate) = lock.withLock { () -> (Error?, ((SearchQuery) throws -> SearchPage)?, [OfflineTrack], (@Sendable (SearchQuery) async -> Void)?) in
            _queries.append(query)
            return (_failure, _handler, _catalog, _gate)
        }
        if let gate { await gate(query) }
        if let failure { throw failure }
        if let handler { return try handler(query) }
        let filters = LibraryFilters(q: query.text, album: query.album, artist: query.artist)
        let matching = LibraryCatalog.sortedByArtistTitle(LibraryCatalog.filter(catalog, filters))
        let start = min(max(query.offset, 0), matching.count)
        let end = min(start + max(query.limit, 0), matching.count)
        let sections = query.withSections
            ? SearchSections.of(matching, text: query.text, artistPage: !query.artist.isBlank, albumPage: !query.album.isBlank)
            : (artists: [], albums: [])
        return SearchPage(
            q: query.text, tracks: Array(matching[start..<end]), artists: sections.artists, albums: sections.albums,
            total: matching.count, offset: start, limit: query.limit
        )
    }
}

/// Ten songs of one artist, for paging.
private func many(_ n: Int = 10) -> [OfflineTrack] {
    (1...n).map { TestSupport.track("k\($0)", title: String(format: "Song %02d", $0), artist: "Many", album: "Lots") }
}

private final class Counter: @unchecked Sendable {
    var value = 0
}

/// The playlist list behind the search, counting how often it was asked.
private final class FakePlaylists: PlaylistListing, @unchecked Sendable {
    private let lock = NSLock()
    private var _list: [MondropPlaylist]
    private var _failure: Error?
    private var _calls = 0
    init(_ list: [MondropPlaylist]) { _list = list }
    var calls: Int { lock.withLock { _calls } }
    func fail(_ error: Error?) { lock.withLock { _failure = error } }
    func listPlaylists() async throws -> [MondropPlaylist] {
        let (list, failure) = lock.withLock { () -> ([MondropPlaylist], Error?) in
            _calls += 1
            return (_list, _failure)
        }
        if let failure { throw failure }
        return list
    }
}

/// The list behind «Cerca»: online it asks the server, offline it answers from what is on the phone.
@MainActor
final class SearchModelTests: XCTestCase {
    private struct Rig {
        let search: FakeSearch
        let store: OfflineStore
        let activity: SyncActivity
        let clock: FakeClock
        let model: SearchModel
    }

    private func rig(catalog: [OfflineTrack] = TestSupport.catalog(), pageSize: Int = 30, onlyOnPhone: Bool = false) throws -> Rig {
        let dir = try TestSupport.tempDir("search")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let store = OfflineStore(root: dir)
        let search = FakeSearch(catalog: catalog)
        let activity = SyncActivity()
        let clock = FakeClock()
        let model = SearchModel(
            api: search, store: store, onlyOnPhone: onlyOnPhone, activity: activity, clock: clock.clock, pageSize: pageSize
        )
        return Rig(search: search, store: store, activity: activity, clock: clock, model: model)
    }

    @discardableResult
    private func install(_ track: OfflineTrack, in store: OfflineStore) throws -> OfflineStore.Item {
        let staged = store.stagingURL()
        try Data(repeating: 1, count: 100).write(to: staged)
        return try store.install(
            stagedFile: staged, songKey: track.songKey,
            metadata: InstallMetadata(
                title: track.title, artist: track.artist, version: track.version,
                album: track.album, genres: track.genres, year: track.year
            )
        )
    }

    // MARK: online

    func testItAsksTheServerAndShowsTracksArtistsAndAlbums() async throws {
        let r = try rig()
        r.model.text = "maestro bassi"
        await r.model.reload()
        XCTAssertEqual(r.model.source, .server)
        XCTAssertEqual(r.model.tracks.map(\.songKey), ["bm::ragazzo"])
        XCTAssertEqual(r.model.artists, [SearchArtistHit(name: "Bassi Maestro", tracks: 1)])
        XCTAssertEqual(r.model.albums, [SearchAlbumHit(title: "Fastidio", artist: "Bassi Maestro", tracks: 1)])
        XCTAssertEqual(r.model.total, 1)
        XCTAssertTrue(r.model.didSearch)
        XCTAssertEqual(r.model.phase, .idle)
        let asked = try XCTUnwrap(r.search.queries.first)
        XCTAssertEqual(asked, SearchQuery(text: "maestro bassi", limit: 30, offset: 0, withSections: true))
    }

    func testAnEmptyBoxAsksNothingAndClearsTheList() async throws {
        let r = try rig()
        r.model.text = "daft"
        await r.model.reload()
        XCTAssertFalse(r.model.tracks.isEmpty)

        r.model.text = "   "
        await r.model.reload()
        XCTAssertTrue(r.model.tracks.isEmpty)
        XCTAssertTrue(r.model.artists.isEmpty)
        XCTAssertTrue(r.model.albums.isEmpty)
        XCTAssertEqual(r.model.total, 0)
        XCTAssertFalse(r.model.didSearch, "no «Nessun risultato» for a box nobody typed in")
        XCTAssertEqual(r.search.queries.count, 1, "the server would refuse it with a 400")
    }

    func testAnArtistPageAsksForThatArtistAndAnAlbumPageForThatAlbum() async throws {
        let r = try rig()
        r.model.artist = "Michael Jackson"
        await r.model.reload()
        XCTAssertEqual(r.search.queries.last?.artist, "Michael Jackson")
        XCTAssertEqual(r.model.tracks.count, 2)
        XCTAssertTrue(r.model.artists.isEmpty, "all one artist: no artists section")
        XCTAssertEqual(r.model.albums.map(\.title), ["Thriller"])

        r.model.artist = ""
        r.model.album = "Thriller"
        await r.model.reload()
        XCTAssertEqual(r.search.queries.last?.album, "Thriller")
        XCTAssertTrue(r.model.albums.isEmpty, "all one album: no albums section")
    }

    func testPagesAreAppendedWithoutSectionsAndWithoutRepeats() async throws {
        let r = try rig(catalog: many(), pageSize: 4)
        r.model.artist = "Many"
        await r.model.reload()
        XCTAssertEqual(r.model.tracks.count, 4)
        XCTAssertEqual(r.model.total, 10)
        XCTAssertTrue(r.model.canLoadMore)

        await r.model.loadMore()
        XCTAssertEqual(r.model.tracks.count, 8)
        let second = try XCTUnwrap(r.search.queries.last)
        XCTAssertEqual(second.offset, 4)
        XCTAssertFalse(second.withSections, "the sections are asked once, with the first page")

        await r.model.loadMore()
        XCTAssertEqual(r.model.tracks.count, 10)
        XCTAssertFalse(r.model.canLoadMore)
        XCTAssertEqual(Set(r.model.tracks.map(\.songKey)).count, 10)
    }

    func testLoadAllGathersEveryPageUpToTheCeiling() async throws {
        let r = try rig(catalog: many(), pageSize: 3)
        r.model.artist = "Many"
        await r.model.reload()
        await r.model.loadAll()
        XCTAssertEqual(r.model.tracks.count, 10)

        // a server that gives at most 3 songs at a time: the ceiling stops the asking
        let capped = try rig(catalog: many(), pageSize: 3)
        let everything = many()
        capped.search.script { query in
            let start = min(query.offset, everything.count)
            return SearchPage(tracks: Array(everything[start..<min(start + 3, everything.count)]), total: everything.count, offset: start)
        }
        capped.model.artist = "Many"
        await capped.model.reload()
        await capped.model.loadAll(maxTracks: 5)
        XCTAssertEqual(capped.model.tracks.count, 6)
        XCTAssertEqual(capped.search.queries.count, 2, "one search and one more page, then the ceiling of 5 is passed")
    }

    func testAServerThatCountedMoreThanItGaveDoesNotLoopForever() async throws {
        let r = try rig(catalog: many(), pageSize: 4)
        r.search.script { query in
            // always says 100 songs, gives 4 on the first page and nothing after
            SearchPage(tracks: query.offset == 0 ? Array(many().prefix(4)) : [], total: 100, offset: query.offset, limit: query.limit)
        }
        r.model.artist = "Many"
        await r.model.reload()
        await r.model.loadAll()
        XCTAssertEqual(r.model.tracks.count, 4)
        XCTAssertFalse(r.model.canLoadMore)
    }

    func testTheTotalIsNeverBelowWhatIsShown() async throws {
        let r = try rig()
        r.search.script { _ in SearchPage(tracks: Array(many().prefix(3)), total: 1) }
        r.model.text = "song"
        await r.model.reload()
        XCTAssertEqual(r.model.tracks.count, 3)
        XCTAssertEqual(r.model.total, 3)
    }

    func testARowTheServerSendsTwiceIsShownOnce() async throws {
        let r = try rig()
        let a = TestSupport.track("a::a", title: "A")
        r.search.script { _ in SearchPage(tracks: [a, a], total: 2) }
        r.model.text = "a"
        await r.model.reload()
        XCTAssertEqual(r.model.tracks.map(\.songKey), ["a::a"])
    }

    func testTheAnswerOfAnOlderSearchIsDroppedWhenAnewerOneStarted() async throws {
        let r = try rig()
        let gate = AsyncGate()
        r.search.gate { query in
            if query.text == "madonna" { await gate.wait() }
        }
        r.model.text = "madonna"
        let first = Task { await r.model.reload() }
        // let the first request reach the gate before typing again
        for _ in 0..<50 where r.search.queries.isEmpty { await Task.yield() }
        r.model.text = "daft"
        await r.model.reload()
        XCTAssertEqual(Set(r.model.tracks.map(\.artist)), ["Daft Punk"])

        await gate.open()
        await first.value
        XCTAssertEqual(Set(r.model.tracks.map(\.artist)), ["Daft Punk"], "the late answer for «madonna» must not replace it")
        XCTAssertEqual(r.model.phase, .idle)
    }

    func testWhatTheServerSaysAboutTheSongsIsRemembered() async throws {
        let r = try rig()
        let track = TestSupport.track("dp::one", state: "preparing", title: "One More Time", artist: "Daft Punk", album: "Discovery")
        r.search.script { _ in SearchPage(tracks: [track], total: 1) }
        r.model.text = "daft"
        await r.model.reload()
        XCTAssertEqual(r.activity.preparingCount(), 1, "a song the server is preparing shows as such in the status line")
    }

    // MARK: on the phone

    func testAServerFailureShowsTheSongsOnThePhoneAndWhy() async throws {
        let r = try rig()
        try install(TestSupport.track("dp::one", title: "One More Time", artist: "Daft Punk", album: "Discovery"), in: r.store)
        try install(TestSupport.track("rh::creep", title: "Creep", artist: "Radiohead", album: "Pablo Honey"), in: r.store)
        r.search.fail(MondropAPIError.transport("Internet offline"))
        r.model.text = "daft punk"
        await r.model.reload()
        XCTAssertEqual(r.model.source, .phoneFallback("Internet offline"))
        XCTAssertEqual(r.model.tracks.map(\.songKey), ["dp::one"])
        XCTAssertEqual(r.model.artists.map(\.name), ["Daft Punk"])
        XCTAssertEqual(r.model.albums.map(\.title), ["Discovery"])
        XCTAssertEqual(r.model.source.notice?.contains("Server non raggiungibile"), true)
        XCTAssertTrue(r.model.didSearch)
        XCTAssertFalse(r.model.canLoadMore)
    }

    func testAnOlderServerWithoutTheRouteSaysTheBackendNeedsUpdating() async throws {
        let r = try rig()
        r.search.fail(MondropAPIError.http(404, nil))
        r.model.text = "x"
        await r.model.reload()
        guard case .phoneFallback(let reason) = r.model.source else { return XCTFail("\(r.model.source)") }
        XCTAssertTrue(reason.contains("backend da aggiornare"))
    }

    func testOnlyOnThePhoneNeverAsksTheServer() async throws {
        let r = try rig(onlyOnPhone: true)
        try install(TestSupport.track("md::prayer", title: "Like a Prayer", artist: "Madonna", album: "Like a Prayer"), in: r.store)
        r.model.text = "prayer"
        await r.model.reload()
        XCTAssertEqual(r.model.source, .phone)
        XCTAssertEqual(r.model.tracks.map(\.songKey), ["md::prayer"])
        XCTAssertTrue(r.search.queries.isEmpty)
        XCTAssertEqual(r.model.source.notice, "Solo i brani scaricati sul telefono.")
    }

    func testOnThePhoneTheSectionsAreWorkedOutHere() async throws {
        let r = try rig(onlyOnPhone: true)
        try install(TestSupport.track("bm::a", title: "Uno", artist: "Bassi Maestro", album: "Fastidio"), in: r.store)
        try install(TestSupport.track("bm::b", title: "Due", artist: "Bassi Maestro", album: "Fastidio"), in: r.store)
        try install(TestSupport.track("bm::c", title: "Tre", artist: "Bassi Maestro", album: "Altro"), in: r.store)
        try install(TestSupport.track("zz::d", title: "Maestro", artist: "Altri", album: "Fastidio"), in: r.store)
        r.model.text = "maestro"
        await r.model.reload()
        XCTAssertEqual(r.model.total, 4)
        XCTAssertEqual(r.model.artists, [SearchArtistHit(name: "Bassi Maestro", tracks: 3)], "only the names that have the words")
        XCTAssertEqual(r.model.albums.first, SearchAlbumHit(title: "Fastidio", artist: "Bassi Maestro", tracks: 3))
    }

    func testCancellationIsNotAFailureOfTheServer() async throws {
        let r = try rig()
        r.model.text = "daft"
        await r.model.reload()
        r.search.fail(CancellationError())
        r.model.text = "madonna"
        await r.model.reload()
        XCTAssertEqual(r.model.source, .server)
        XCTAssertFalse(r.model.tracks.isEmpty, "the list on screen is left alone")
    }

    func testAPageThatCannotBeLoadedLeavesTheListAndSaysSo() async throws {
        let r = try rig(catalog: many(), pageSize: 4)
        r.model.artist = "Many"
        await r.model.reload()
        r.search.fail(MondropAPIError.transport("timeout"))
        await r.model.loadMore()
        XCTAssertEqual(r.model.tracks.count, 4)
        XCTAssertEqual(r.model.pagingError, "timeout")
        XCTAssertEqual(r.model.source, .server)
    }

    // MARK: songs the server is still preparing

    func testPollingTurnsPreparingIntoReady() async throws {
        let r = try rig()
        let preparing = TestSupport.track("a::a", state: "preparing", version: nil, bytes: nil, title: "A")
        let ready = TestSupport.track("a::a", title: "A")
        let asked = Counter()
        r.search.script { _ in
            asked.value += 1
            return SearchPage(tracks: [asked.value == 1 ? preparing : ready], total: 1)
        }
        r.model.text = "a"
        await r.model.reload()
        XCTAssertEqual(r.model.tracks.first?.resolvedState, .preparing)
        await r.model.pollWhilePreparing()
        XCTAssertEqual(r.model.tracks.first?.resolvedState, .ready)
        XCTAssertEqual(r.clock.sleeps, [5])
    }

    func testPollingGivesUpAfterTheTimeout() async throws {
        let r = try rig()
        let preparing = TestSupport.track("a::a", state: "preparing", version: nil, bytes: nil, title: "A")
        r.search.script { _ in SearchPage(tracks: [preparing], total: 1) }
        r.model.text = "a"
        await r.model.reload()
        await r.model.pollWhilePreparing(interval: 5, timeout: 20)
        XCTAssertEqual(r.clock.sleeps.count, 4)
        XCTAssertEqual(r.model.tracks.first?.resolvedState, .preparing)
    }

    func testAHiccupWhilePollingIsNotASwitchToThePhone() async throws {
        let r = try rig()
        let preparing = TestSupport.track("a::a", state: "preparing", version: nil, bytes: nil, title: "A")
        r.search.script { _ in SearchPage(tracks: [preparing], total: 1) }
        r.model.text = "a"
        await r.model.reload()
        r.search.script { _ in throw MondropAPIError.transport("blip") }
        await r.model.pollWhilePreparing()
        XCTAssertEqual(r.model.source, .server)
        XCTAssertEqual(r.model.tracks.count, 1)
    }

    // MARK: playlists, found by name

    private func rigWithPlaylists(_ list: [MondropPlaylist]) throws -> (rig: Rig, playlists: FakePlaylists) {
        let dir = try TestSupport.tempDir("search-pl")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let store = OfflineStore(root: dir)
        let search = FakeSearch(catalog: TestSupport.catalog())
        let playlists = FakePlaylists(list)
        let clock = FakeClock()
        let activity = SyncActivity()
        let model = SearchModel(api: search, playlists: playlists, store: store, activity: activity, clock: clock.clock)
        return (Rig(search: search, store: store, activity: activity, clock: clock, model: model), playlists)
    }

    private let rap = MondropPlaylist(id: "p1", name: "Rap italiano", songCount: 12, kind: "static", canEdit: true)
    private let rock = MondropPlaylist(id: "p2", name: "Rock", songCount: 3)
    private let night = MondropPlaylist(id: "p3", name: "Notte di Rap", songCount: 0, kind: "dynamic")

    func testPlaylistsAreFoundByTheirNameAmongTheResults() async throws {
        let (r, _) = try rigWithPlaylists([rap, rock, night])
        r.model.text = "rap"
        await r.model.reload()
        XCTAssertEqual(r.model.playlists.map(\.id), ["p1", "p3"], "the words are in the NAME, in any order and case")
        r.model.text = "ITALIANO rap"
        await r.model.reload()
        XCTAssertEqual(r.model.playlists.map(\.id), ["p1"])
    }

    func testAnArtistPageOrAnAlbumPageHasNoPlaylists() async throws {
        let (r, playlists) = try rigWithPlaylists([rap])
        r.model.artist = "Michael Jackson"
        await r.model.reload()
        XCTAssertTrue(r.model.playlists.isEmpty)
        r.model.artist = ""
        r.model.album = "Thriller"
        await r.model.reload()
        XCTAssertTrue(r.model.playlists.isEmpty)
        XCTAssertEqual(playlists.calls, 0, "not even asked")
    }

    func testAPlaylistListThatCannotBeReadCostsThePlaylistsNotTheSongs() async throws {
        let (r, playlists) = try rigWithPlaylists([rap])
        playlists.fail(MondropAPIError.transport("down"))
        r.model.text = "daft"
        await r.model.reload()
        XCTAssertFalse(r.model.tracks.isEmpty)
        XCTAssertTrue(r.model.playlists.isEmpty)
        XCTAssertEqual(r.model.source, .server)
    }

    func testThePlaylistsAreReadOnceAMinuteNotAtEveryKeystroke() async throws {
        let (r, playlists) = try rigWithPlaylists([rap, rock])
        r.model.text = "ro"
        await r.model.reload()
        r.model.text = "roc"
        await r.model.reload()
        r.model.text = "rock"
        await r.model.reload()
        XCTAssertEqual(playlists.calls, 1)
        XCTAssertEqual(r.model.playlists.map(\.id), ["p2"])
        r.clock.advance(61)
        await r.model.reload()
        XCTAssertEqual(playlists.calls, 2)
    }

    func testOnThePhoneThePlaylistsAreTheOnesWithSongsOnThePhone() async throws {
        let r = try rig(onlyOnPhone: true)
        try install(TestSupport.track("a::1", title: "Uno", artist: "A"), in: r.store)
        r.store.recordPlaylist(id: "p1", name: "Rap italiano", songKeys: ["a::1", "gone::2"])
        r.store.recordPlaylist(id: "p2", name: "Rap vuota", songKeys: ["gone::3"])
        r.model.text = "rap"
        await r.model.reload()
        XCTAssertEqual(r.model.playlists, [MondropPlaylist(id: "p1", name: "Rap italiano", songCount: 1)], "only what can be played here, counted as such")
    }
}

