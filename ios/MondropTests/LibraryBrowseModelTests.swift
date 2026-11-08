import XCTest
@testable import Mondrop

/// The list behind «Libreria»: online it asks the server, offline it answers from what is on the phone.
@MainActor
final class LibraryBrowseModelTests: XCTestCase {
    private struct Rig {
        let backend: FakeBackend
        let store: OfflineStore
        let activity: SyncActivity
        let clock: FakeClock
        let model: LibraryBrowseModel
        var library: FakeLibrary { backend.lib }
    }

    private func rig(catalog: [OfflineTrack] = TestSupport.catalog(), pageSize: Int = 100, onlyOnPhone: Bool = false) throws -> Rig {
        let dir = try TestSupport.tempDir("library")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let store = OfflineStore(root: dir)
        let backend = FakeBackend(library: FakeLibrary(catalog: catalog))
        let activity = SyncActivity()
        let clock = FakeClock()
        let model = LibraryBrowseModel(
            api: backend, store: store, onlyOnPhone: onlyOnPhone, activity: activity, clock: clock.clock, pageSize: pageSize
        )
        return Rig(backend: backend, store: store, activity: activity, clock: clock, model: model)
    }

    /// A song downloaded the way the engine does it: with what the server said about it.
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

    func testItLoadsTheFirstPageWithTheHeadings() async throws {
        let r = try rig()
        await r.model.reload()
        XCTAssertEqual(r.model.source, .server)
        XCTAssertEqual(r.model.songs.count, 10)
        XCTAssertEqual(r.model.total, 10)
        XCTAssertFalse(r.model.facets.albums.isEmpty)
        XCTAssertEqual(r.model.phase, .idle)
        let query = try XCTUnwrap(r.library.queries.first)
        XCTAssertTrue(query.withFacets)
        XCTAssertEqual(query.offset, 0)
    }

    func testTheFiltersAreSentToTheServer() async throws {
        let r = try rig()
        r.model.filters = LibraryFilters(album: "Thriller")
        await r.model.reload()
        XCTAssertEqual(r.library.queries.first?.filters.album, "Thriller")
        XCTAssertEqual(r.model.songs.count, 2)
        XCTAssertEqual(r.model.total, 2)
    }

    func testPagesAreAppendedWithoutFacetsAndWithoutRepeats() async throws {
        let r = try rig(pageSize: 4)
        await r.model.reload()
        XCTAssertEqual(r.model.songs.count, 4)
        XCTAssertEqual(r.model.total, 10)
        XCTAssertTrue(r.model.canLoadMore)

        await r.model.loadMore()
        XCTAssertEqual(r.model.songs.count, 8)
        let second = try XCTUnwrap(r.library.queries.last)
        XCTAssertEqual(second.offset, 4, "the next page starts after what is loaded")
        XCTAssertFalse(second.withFacets, "the headings are not asked again for a page")

        await r.model.loadMore()
        XCTAssertEqual(r.model.songs.count, 10)
        XCTAssertFalse(r.model.canLoadMore)
        XCTAssertEqual(Set(r.model.songs.map(\.songKey)).count, 10)
    }

    func testLoadAllFetchesEverythingBeforeAQueueIsBuilt() async throws {
        let many = (1...25).map { TestSupport.track(String(format: "s%02d", $0), artist: "A") }
        let r = try rig(catalog: many, pageSize: 10)
        await r.model.reload()
        XCTAssertEqual(r.model.songs.count, 10)
        await r.model.loadAll()
        XCTAssertEqual(r.model.songs.count, 25)
        XCTAssertFalse(r.model.canLoadMore)
        XCTAssertTrue(r.library.queries.dropFirst().allSatisfy { $0.limit == LibraryQuery.maxLimit }, "the rest in big pages")
    }

    func testAServerThatCountsMoreThanItGivesDoesNotLoopForever() async throws {
        let r = try rig(pageSize: 4)
        r.library.script { query in
            query.offset == 0
                ? LibraryPage(songs: Array(TestSupport.catalog().prefix(4)), total: 50, offset: 0, limit: 4)
                : LibraryPage(songs: [], total: 50, offset: query.offset, limit: 4)
        }
        await r.model.reload()
        await r.model.loadAll()
        XCTAssertEqual(r.model.songs.count, 4)
        XCTAssertFalse(r.model.canLoadMore, "an empty page ends the paging")
        XCTAssertEqual(r.library.queries.count, 2)
    }

    func testAnAnswerThatArrivesAfterANewerRequestIsDropped() async throws {
        let r = try rig()
        let door = AsyncGate()
        r.library.gate { query in
            if query.filters.album == "Thriller" { await door.wait() }     // the first answer is slow
        }
        r.model.filters = LibraryFilters(album: "Thriller")
        let first = Task { await r.model.reload() }
        await Task.yield()                                                  // …and is waiting at the door
        r.model.filters = LibraryFilters(artist: "Daft Punk")
        await r.model.reload()
        XCTAssertEqual(Set(r.model.songs.map(\.artist)), ["Daft Punk"])

        await door.open()
        await first.value                                                   // the old answer finally arrives
        XCTAssertEqual(Set(r.model.songs.map(\.artist)), ["Daft Punk"], "it must not overwrite the newer result")
        XCTAssertEqual(r.model.phase, .idle)
    }

    func testWhatTheServerSaysIsRememberedForTheSongsOnThePhone() async throws {
        let r = try rig()
        // downloaded by 1.4.0: no album / genres / year stored
        let bare = TestSupport.track("mj::billie", title: "Billie Jean", artist: "Michael Jackson")
        try install(bare, in: r.store)
        XCTAssertNil(r.store.item(songKey: "mj::billie")?.album)

        await r.model.reload()

        let item = try XCTUnwrap(r.store.item(songKey: "mj::billie"))
        XCTAssertEqual(item.album, "Thriller")
        XCTAssertEqual(item.genres, ["Pop"])
        XCTAssertEqual(item.year, 1982)
    }

    func testTheSongsTheServerIsPreparingAreNoted() async throws {
        var catalog = TestSupport.catalog()
        catalog.append(TestSupport.track("p1", state: "preparing"))
        catalog.append(TestSupport.track("p2", state: "preparing"))
        let r = try rig(catalog: catalog)
        await r.model.reload()
        XCTAssertEqual(r.activity.preparingCount(), 2)
    }

    // MARK: offline

    func testWhenTheServerCannotBeReachedItShowsTheSongsOnThePhoneAndSaysWhy() async throws {
        let r = try rig()
        for key in ["mj::billie", "dp::one", "ua::mystery"] {
            try install(try XCTUnwrap(TestSupport.catalog().first { $0.songKey == key }), in: r.store)
        }
        r.library.fail(MondropAPIError.transport("Internet connection appears to be offline"))

        await r.model.reload()

        XCTAssertEqual(r.model.source, .phoneFallback("Internet connection appears to be offline"))
        XCTAssertEqual(r.model.songs.count, 3, "only what is downloaded")
        XCTAssertEqual(r.model.total, 3)
        XCTAssertTrue(r.model.source.isPhone)
        XCTAssertTrue(r.model.source.notice?.contains("Internet connection appears to be offline") == true)
        XCTAssertFalse(r.model.canLoadMore)
    }

    func testOfflineTheFiltersAndTheHeadingsWorkOnTheDownloadedSongs() async throws {
        let r = try rig()
        for song in TestSupport.catalog() { try install(song, in: r.store) }
        r.library.fail(MondropAPIError.http(503, nil))

        r.model.filters = LibraryFilters(decade: .decade(1980))
        await r.model.reload()
        XCTAssertEqual(r.model.songs.count, 4, "Anni 80, from the year stored with each file")
        XCTAssertEqual(Set(r.model.facets.genres.map(\.value)), ["Pop", "Rock"])
        XCTAssertEqual(r.model.facets.decades.map(\.value), ["1980", "1990", "2000", "none"])

        r.model.filters = LibraryFilters(album: "Thriller")
        await r.model.reload()
        XCTAssertEqual(r.model.songs.count, 2)
    }

    func testAnOlderServerWithoutTheLibraryFallsBackToThePhoneWithAHint() async throws {
        let r = try rig()
        r.library.fail(MondropAPIError.http(404, "not found"))
        await r.model.reload()
        guard case .phoneFallback(let reason) = r.model.source else { return XCTFail("\(r.model.source)") }
        XCTAssertTrue(reason.contains("backend da aggiornare"), reason)
    }

    func testFilesDownloadedBeforeTheUpdateHaveNoDescriptorsAndAreSenzaAnno() async throws {
        let r = try rig(onlyOnPhone: true)
        try install(TestSupport.track("old", title: "Vecchia", artist: "X"), in: r.store)
        await r.model.reload()
        XCTAssertEqual(r.model.songs.count, 1)
        XCTAssertEqual(r.model.facets.decades.map(\.value), ["none"])
        r.model.filters = LibraryFilters(decade: .noYear)
        await r.model.reload()
        XCTAssertEqual(r.model.songs.count, 1)
    }

    func testOnlyOnPhoneNeverAsksTheServerForSongs() async throws {
        let r = try rig(onlyOnPhone: true)
        try install(try XCTUnwrap(TestSupport.catalog().first), in: r.store)
        await r.model.reload()
        XCTAssertEqual(r.model.source, .phone)
        XCTAssertTrue(r.library.queries.isEmpty)
        XCTAssertEqual(r.model.songs.count, 1)
        XCTAssertEqual(r.model.source.notice, "Solo i brani scaricati sul telefono.")
    }

    func testAFileThatIsNotReallyThereIsNotListed() async throws {
        let r = try rig(onlyOnPhone: true)
        let item = try install(try XCTUnwrap(TestSupport.catalog().first), in: r.store)
        try FileManager.default.removeItem(at: r.store.root.appendingPathComponent(item.relativePath))
        await r.model.reload()
        XCTAssertEqual(r.model.songs.count, 0)
    }

    // MARK: playlists

    func testPlaylistsComeFromTheServerAndAreNarrowedByName() async throws {
        let r = try rig()
        r.backend.api.setPlaylists([
            MondropPlaylist(id: "1", name: "Road trip", songCount: 5),
            MondropPlaylist(id: "2", name: "Notte", songCount: 3, kind: "dynamic", ruleSummary: "Più ascoltate"),
        ])
        await r.model.reloadPlaylists()
        XCTAssertEqual(r.model.playlists.map(\.name), ["Road trip", "Notte"])
        await r.model.reloadPlaylists(matching: "TRIP road")
        XCTAssertEqual(r.model.playlists.map(\.name), ["Road trip"], "the words in any order")
    }

    func testOfflinePlaylistsAreTheOnesTheAppSawWithTheirSongsThatAreOnThePhone() async throws {
        let r = try rig()
        try install(TestSupport.track("a"), in: r.store)
        try install(TestSupport.track("b"), in: r.store)
        r.store.recordPlaylist(id: "p1", name: "Road trip", songKeys: ["a", "b", "not-downloaded"])
        r.store.recordPlaylist(id: "p2", name: "Vuota", songKeys: ["not-downloaded"])
        let phone = LibraryBrowseModel(api: r.backend, store: r.store, onlyOnPhone: true, clock: r.clock.clock)
        await phone.reloadPlaylists()
        XCTAssertEqual(phone.playlists.map(\.name), ["Road trip"], "a playlist with nothing on the phone is not offered")
        XCTAssertEqual(phone.playlists.first?.songCount, 2)
    }

    // MARK: while the server prepares

    func testItReadsTheListAgainWhileTheServerPreparesAndStopsWhenAllIsReady() async throws {
        let r = try rig(catalog: [TestSupport.track("a"), TestSupport.track("b", state: "preparing")])
        await r.model.reload()
        XCTAssertEqual(r.activity.preparingCount(), 1)
        var reads = 0
        r.library.script { query in
            reads += 1
            let b = TestSupport.track("b", state: reads >= 3 ? "ready" : "preparing")
            return LibraryPage(songs: [TestSupport.track("a"), b], total: 2, offset: 0, limit: query.limit)
        }
        await r.model.pollWhilePreparing()
        XCTAssertEqual(reads, 3)
        XCTAssertEqual(r.clock.sleeps, [5, 5, 5], "every 5 s")
        XCTAssertEqual(r.model.songs.first { $0.songKey == "b" }?.resolvedState, .ready)
        XCTAssertEqual(r.activity.preparingCount(), 0, "the line at the top stops saying «Preparo»")
    }

    func testItGivesUpAfterTenMinutes() async throws {
        let r = try rig(catalog: [TestSupport.track("b", state: "preparing")])
        await r.model.reload()
        await r.model.pollWhilePreparing(interval: 5, timeout: 600)
        XCTAssertEqual(r.clock.sleeps.count, 120)
        XCTAssertEqual(r.model.songs.first?.resolvedState, .preparing)
    }

    func testNothingToWaitForMeansNoPolling() async throws {
        let r = try rig()
        await r.model.reload()
        await r.model.pollWhilePreparing()
        XCTAssertTrue(r.clock.sleeps.isEmpty)
    }

    func testAFailedReadWhilePollingLeavesTheListAsItIs() async throws {
        let r = try rig(catalog: [TestSupport.track("b", state: "preparing")])
        await r.model.reload()
        r.library.fail(MondropAPIError.transport("offline"))
        await r.model.pollWhilePreparing()
        XCTAssertEqual(r.model.songs.count, 1)
        XCTAssertEqual(r.model.source, .server, "a hiccup while polling is not a switch to the phone")
    }
}
