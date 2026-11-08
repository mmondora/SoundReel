import XCTest
@testable import Mondrop

/// Album / genres / year travel with the file, so «Libreria» can browse the phone with no network (ADR-0013).
final class OfflineMetadataTests: XCTestCase {
    private func store() throws -> (OfflineStore, URL) {
        let dir = try TestSupport.tempDir("meta")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return (OfflineStore(root: dir), dir)
    }

    @discardableResult
    private func install(_ store: OfflineStore, _ key: String, album: String? = nil, genres: [String] = [], year: Int? = nil, title: String? = nil) throws -> OfflineStore.Item {
        let staged = store.stagingURL()
        try Data(repeating: 1, count: 100).write(to: staged)
        return try store.install(
            stagedFile: staged, songKey: key,
            metadata: InstallMetadata(title: title ?? key, artist: "Artist", version: "100-1", album: album, genres: genres, year: year)
        )
    }

    func testAnInstalledSongKeepsWhatTheServerSaidAboutIt() throws {
        let (store, _) = try store()
        try install(store, "a", album: "Thriller", genres: ["Pop", "Rock"], year: 1982)
        let item = try XCTUnwrap(store.item(songKey: "a"))
        XCTAssertEqual(item.album, "Thriller")
        XCTAssertEqual(item.genres, ["Pop", "Rock"])
        XCTAssertEqual(item.year, 1982)
    }

    func testItSurvivesARestart() throws {
        let (store, dir) = try store()
        try install(store, "a", album: "Thriller", genres: ["Pop"], year: 1982)
        let reopened = OfflineStore(root: dir)
        XCTAssertEqual(reopened.item(songKey: "a")?.album, "Thriller")
        XCTAssertEqual(reopened.item(songKey: "a")?.year, 1982)
    }

    func testAnIndexWrittenByTheEarlierBuildStillLoads() throws {
        let (_, dir) = try store()
        // exactly the shape 1.4.0 wrote: items without album / genres / year
        let old = #"""
        {"version":3,"items":[{"songKey":"old","title":"Old","artist":"X","relativePath":"Offline/old-1.mp3","bytes":100}],
         "playlists":{},"lyricsOverrides":{},"legacyMigrated":true,"playStats":{},"skipped":{}}
        """#
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("Offline"), withIntermediateDirectories: true)
        try Data(repeating: 1, count: 100).write(to: dir.appendingPathComponent("Offline/old-1.mp3"))
        try Data(old.utf8).write(to: dir.appendingPathComponent("offline-index.json"))

        let store = OfflineStore(root: dir)
        let item = try XCTUnwrap(store.item(songKey: "old"))
        XCTAssertNil(item.album)
        XCTAssertNil(item.genres)
        XCTAssertNil(item.year)
        XCTAssertEqual(store.loadIndex().count, 1, "the index was not thrown away as corrupt")
        let track = try XCTUnwrap(store.localTracks().first)
        XCTAssertEqual(track.genres, [])
        XCTAssertNil(track.year)
    }

    func testDownloadingItAgainWithoutDescriptorsDoesNotForgetThem() throws {
        let (store, _) = try store()
        try install(store, "a", album: "Thriller", genres: ["Pop"], year: 1982)
        try install(store, "a")                              // a re-download from a server that says nothing
        let item = try XCTUnwrap(store.item(songKey: "a"))
        XCTAssertEqual(item.album, "Thriller")
        XCTAssertEqual(item.genres, ["Pop"])
        XCTAssertEqual(item.year, 1982)
    }

    // MARK: recordMetadata

    func testALaterReadingFillsInWhatAnOlderDownloadLacks() throws {
        let (store, _) = try store()
        try install(store, "a")
        store.recordMetadata(from: [TestSupport.track("a", album: "Thriller", genres: ["Pop"], year: 1982)])
        let item = try XCTUnwrap(store.item(songKey: "a"))
        XCTAssertEqual(item.album, "Thriller")
        XCTAssertEqual(item.genres, ["Pop"])
        XCTAssertEqual(item.year, 1982)
    }

    func testAReadingThatSaysNothingNeverErasesWhatIsKnown() throws {
        let (store, _) = try store()
        try install(store, "a", album: "Thriller", genres: ["Pop"], year: 1982)
        store.recordMetadata(from: [TestSupport.track("a")])  // an older server: no album, no genres, no year
        let item = try XCTUnwrap(store.item(songKey: "a"))
        XCTAssertEqual(item.album, "Thriller")
        XCTAssertEqual(item.genres, ["Pop"])
        XCTAssertEqual(item.year, 1982)
    }

    func testTheServerCorrectingASongWins() throws {
        let (store, _) = try store()
        try install(store, "a", album: "Thriller (Remastered)", genres: ["Pop"], year: 2008)
        store.recordMetadata(from: [TestSupport.track("a", album: "Thriller", genres: ["Pop", "Rock"], year: 1982)])
        let item = try XCTUnwrap(store.item(songKey: "a"))
        XCTAssertEqual(item.album, "Thriller")
        XCTAssertEqual(item.genres, ["Pop", "Rock"])
        XCTAssertEqual(item.year, 1982)
    }

    func testSongsThatAreNotOnThePhoneAreIgnored() throws {
        let (store, _) = try store()
        store.recordMetadata(from: [TestSupport.track("ghost", album: "X", genres: ["Y"], year: 1999)])
        XCTAssertNil(store.item(songKey: "ghost"))
        XCTAssertTrue(store.localTracks().isEmpty)
    }

    // MARK: what the library lists offline

    func testLocalTracksAreTheSongsReallyOnThePhone() throws {
        let (store, dir) = try store()
        try install(store, "a", album: "Thriller", genres: ["Pop"], year: 1982, title: "Billie Jean")
        let gone = try install(store, "b")
        try FileManager.default.removeItem(at: dir.appendingPathComponent(gone.relativePath))
        let tracks = store.localTracks()
        XCTAssertEqual(tracks.map(\.songKey), ["a"], "a file that is not there is not listed")
        let a = try XCTUnwrap(tracks.first)
        XCTAssertEqual(a.title, "Billie Jean")
        XCTAssertEqual(a.album, "Thriller")
        XCTAssertEqual(a.genres, ["Pop"])
        XCTAssertEqual(a.year, 1982)
        XCTAssertEqual(a.resolvedState, .ready, "it is on the phone: nothing to prepare")
    }

    func testLocalTracksCarryTheListens() throws {
        let (store, _) = try store()
        try install(store, "a")
        store.bumpLocalPlay(songKey: "a", at: Date(timeIntervalSince1970: 1_794_000_000))
        XCTAssertEqual(store.localTracks().first?.plays, 1)
        XCTAssertNotNil(store.localTracks().first?.lastPlayedDate)
    }

    func testLocalSongKeysInOnePass() throws {
        let (store, dir) = try store()
        try install(store, "a")
        let b = try install(store, "b")
        XCTAssertEqual(store.localSongKeys(), ["a", "b"])
        try FileManager.default.removeItem(at: dir.appendingPathComponent(b.relativePath))
        XCTAssertEqual(store.localSongKeys(), ["a"])
    }

    func testPlaylistMembershipsAreListedByName() throws {
        let (store, _) = try store()
        store.recordPlaylist(id: "2", name: "Zeta", songKeys: ["x"])
        store.recordPlaylist(id: "1", name: "alfa", songKeys: ["a", "b"])
        let m = store.playlistMemberships()
        XCTAssertEqual(m.map(\.name), ["alfa", "Zeta"])
        XCTAssertEqual(m.first?.songKeys, ["a", "b"])
        XCTAssertEqual(m.first?.id, "1")
    }
}

/// The description of a download task carries the descriptors too, and an old one without them still reads.
final class JobInfoDescriptorTests: XCTestCase {
    func testTheDescriptorsRoundTrip() throws {
        let info = JobInfo(songKey: "a", title: "A", artist: "X", kind: "proxy", album: "Thriller", genres: ["Pop"], year: 1982)
        let data = try JSONEncoder().encode(info)
        XCTAssertEqual(try JSONDecoder().decode(JobInfo.self, from: data), info)
    }

    func testATaskStartedByTheEarlierBuildStillReads() throws {
        let old = #"{"songKey":"a","title":"A","artist":"X","kind":"media","proxyPath":"/api/mondrop/songs/a/file","bytes":100}"#
        let info = try JSONDecoder().decode(JobInfo.self, from: Data(old.utf8))
        XCTAssertEqual(info.songKey, "a")
        XCTAssertNil(info.album)
        XCTAssertNil(info.genres)
        XCTAssertNil(info.year)

        // …and the transport reads it back from the task description of a download iOS kept running
        let task = URLSession(configuration: .ephemeral).dataTask(with: URL(string: "https://x.test/never-started")!)
        task.taskDescription = old
        XCTAssertEqual(BackgroundDownloadTransport.info(of: task)?.songKey, "a")
    }
}

@MainActor
final class DownloadedMetadataTests: XCTestCase {
    func testADownloadedSongArrivesWithAlbumGenresAndYearSoItCanBeBrowsedOffline() throws {
        let r = try EngineRig()
        let dir = r.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        r.engine.enqueue([TestSupport.track("a", album: "Thriller", genres: ["Pop", "Rock"], year: 1982)], home: false)
        XCTAssertEqual(r.transport.started.first?.info.album, "Thriller", "the descriptors travel with the task")

        try r.finish(try XCTUnwrap(r.transport.started.first).info)

        let item = try XCTUnwrap(r.store.item(songKey: "a"))
        XCTAssertEqual(item.album, "Thriller")
        XCTAssertEqual(item.genres, ["Pop", "Rock"])
        XCTAssertEqual(item.year, 1982)
    }

    func testTheQueueOnDiskKeepsThemToo() async throws {
        let first = try EngineRig(persistQueue: true)
        let dir = first.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let list = ["a", "b", "c"].map { TestSupport.track($0, album: "Album \($0)", genres: ["Pop"], year: 1990) }
        first.engine.enqueue(list, home: false)                         // c waits in the queue file

        let second = try EngineRig(persistQueue: true, root: first.root)
        await second.engine.attachExisting()
        let c = try XCTUnwrap(second.transport.started.first)
        XCTAssertEqual(c.info.songKey, "c")
        XCTAssertEqual(c.info.album, "Album c")
        XCTAssertEqual(c.info.year, 1990)
    }
}
