import XCTest
@testable import Mondrop

/// «E quando da homepage clicco sulla playlist devo vedere la lista e poter mettere in play.» (Michele, 11 November, trying build 16; spec
/// 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U11): the page of a playlist is drawn at once from what the phone kept the last time it read
/// the playlist, and SoundReel is asked again behind it. The first time there is nothing to show but a spinner; every other time, and with no network at all, the list
/// and «Suona» are there.
final class FilePlaylistManifestCacheTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws { dir = try TestSupport.tempDir("manifest-cache") }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    private func cache() -> FilePlaylistManifestCache { FilePlaylistManifestCache(directory: dir.appendingPathComponent("Playlists")) }

    private func manifest(_ id: String = "pl1", keys: [String] = ["a", "b", "c"]) -> OfflineManifest {
        TestSupport.manifest(id, keys.enumerated().map { offset, key in
            TestSupport.track(key, state: offset == 1 ? "preparing" : "ready", bytes: 1_000 + offset, title: "Title \(key)", artist: "Artist \(offset)", album: "Album", genres: ["Pop"], year: 1990 + offset)
        })
    }

    func testASavedListComesBackWithEverythingThePageNeeds() {
        let c = cache()
        let saved = manifest()
        c.save(saved)
        XCTAssertEqual(c.load(playlistId: "pl1"), saved, "titles, artists, states, versions and sizes: the page and the queue are built from it")
    }

    func testAPlaylistNeverSavedHasNoList() {
        XCTAssertNil(cache().load(playlistId: "never"))
    }

    func testTheListSurvivesANewCacheOnTheSameFolder() {
        cache().save(manifest())
        XCTAssertEqual(cache().load(playlistId: "pl1"), manifest(), "the app was closed and opened again")
    }

    func testSavingAgainReplacesTheOldList() {
        let c = cache()
        c.save(manifest(keys: ["a", "b", "c"]))
        c.save(manifest(keys: ["a", "z"]))
        XCTAssertEqual(c.load(playlistId: "pl1")?.tracks.map(\.songKey), ["a", "z"])
    }

    func testEachPlaylistHasItsOwnList() {
        let c = cache()
        c.save(manifest("one", keys: ["a"]))
        c.save(manifest("two", keys: ["b", "c"]))
        XCTAssertEqual(c.load(playlistId: "one")?.tracks.map(\.songKey), ["a"])
        XCTAssertEqual(c.load(playlistId: "two")?.tracks.map(\.songKey), ["b", "c"])
    }

    func testAnIdWithOddCharactersStaysInsideTheFolder() throws {
        let c = cache()
        for id in ["a/b", "../x", "with space", "ünï", ""] {
            c.save(manifest(id, keys: ["k"]))
            XCTAssertEqual(c.load(playlistId: id)?.playlistId, id, id)
            XCTAssertEqual(c.fileURL(playlistId: id).deletingLastPathComponent().standardizedFileURL, dir.appendingPathComponent("Playlists").standardizedFileURL, "«\(id)» is a file of the folder")
        }
    }

    func testAFileThatIsNotAListIsNoListAndGoesAway() throws {
        let c = cache()
        c.save(manifest())
        let file = c.fileURL(playlistId: "pl1")
        try Data("not json at all".utf8).write(to: file)
        XCTAssertNil(c.load(playlistId: "pl1"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "a damaged file does not stay to fail again at every opening")
    }

    func testPruneKeepsOnlyThePlaylistsThatStillExist() {
        let c = cache()
        for id in ["keep1", "gone", "keep2", "gone2"] { c.save(manifest(id, keys: ["k"])) }
        c.prune(keeping: ["keep1", "keep2"])
        XCTAssertNotNil(c.load(playlistId: "keep1"))
        XCTAssertNotNil(c.load(playlistId: "keep2"))
        XCTAssertNil(c.load(playlistId: "gone"), "a playlist deleted on the server does not stay on the phone")
        XCTAssertNil(c.load(playlistId: "gone2"))
    }

    func testPruneWithNothingToKeepEmptiesTheFolder() {
        let c = cache()
        c.save(manifest("a", keys: ["k"]))
        c.prune(keeping: [])
        XCTAssertNil(c.load(playlistId: "a"))
    }
}

/// The page of a playlist asks the cache before the server, and keeps it current.
@MainActor
final class PlaylistPageCacheTests: XCTestCase {
    /// A cache in memory, that remembers what it was asked.
    private final class MemoryCache: PlaylistManifestCaching, @unchecked Sendable {
        var lists: [String: OfflineManifest] = [:]
        private(set) var saves: [String] = []
        func load(playlistId: String) -> OfflineManifest? { lists[playlistId] }
        func save(_ manifest: OfflineManifest) { lists[manifest.playlistId] = manifest; saves.append(manifest.playlistId) }
        func prune(keeping ids: Set<String>) { lists = lists.filter { ids.contains($0.key) } }
    }

    private final class FakeRemover: PlaylistSongRemoving, @unchecked Sendable {
        func removeSong(songKey: String, fromPlaylist id: String) async throws -> PlaylistRemoveAck {
            PlaylistRemoveAck(playlistId: id, name: "Playlist \(id)", songs: 2)
        }
    }

    private func manifest(_ keys: [String], id: String = "pl1") -> OfflineManifest {
        TestSupport.manifest(id, keys.map { TestSupport.track($0) })
    }

    private func make(cache: PlaylistManifestCaching?, api: FakeAPI = FakeAPI(), id: String = "pl1") throws -> (PlaylistSyncCoordinator, FakeAPI, EngineRig) {
        let rig = try EngineRig()
        let coordinator = PlaylistSyncCoordinator(
            playlist: MondropPlaylist(id: id, name: "Playlist \(id)", songCount: 3, canEdit: true), api: api, engine: rig.engine, clock: FakeClock().clock, cache: cache
        )
        return (coordinator, api, rig)
    }

    func testTheKeptListIsOnTheScreenAtOnceBeforeSoundReelIsAskedAnything() throws {
        let cache = MemoryCache()
        cache.lists["pl1"] = manifest(["a", "b", "c"])
        let (coordinator, api, _) = try make(cache: cache)
        XCTAssertEqual(coordinator.manifest?.tracks.map(\.songKey), ["a", "b", "c"], "the page has its list in the first frame")
        XCTAssertTrue(api.calls.isEmpty)
        XCTAssertEqual(coordinator.phase, .idle)
    }

    func testWithNothingKeptTheFirstFrameHasNoListAndLoadingFillsIt() async throws {
        let cache = MemoryCache()
        let api = FakeAPI()
        api.scriptManifests("pl1", [.success(manifest(["a", "b"]))])
        let (coordinator, _, _) = try make(cache: cache, api: api)
        XCTAssertNil(coordinator.manifest)
        await coordinator.load()
        XCTAssertEqual(coordinator.manifest?.tracks.map(\.songKey), ["a", "b"])
        XCTAssertEqual(cache.lists["pl1"]?.tracks.map(\.songKey), ["a", "b"], "and it is kept for the next time")
    }

    func testReadingAgainReplacesTheKeptListWithWhatTheServerSaysNow() async throws {
        let cache = MemoryCache()
        cache.lists["pl1"] = manifest(["a", "b", "c"])
        let api = FakeAPI()
        api.scriptManifests("pl1", [.success(manifest(["a", "b", "c", "d"]))])
        let (coordinator, _, _) = try make(cache: cache, api: api)
        await coordinator.load()
        XCTAssertEqual(coordinator.manifest?.tracks.map(\.songKey), ["a", "b", "c", "d"])
        XCTAssertEqual(cache.lists["pl1"]?.tracks.map(\.songKey), ["a", "b", "c", "d"])
        XCTAssertNil(coordinator.errorText)
    }

    func testWhenTheServerDoesNotAnswerTheKeptListStaysAndTheErrorIsSaid() async throws {
        let cache = MemoryCache()
        cache.lists["pl1"] = manifest(["a", "b", "c"])
        let api = FakeAPI()
        api.scriptManifests("pl1", [.failure(MondropAPIError.http(502, "bad gateway"))])
        let (coordinator, _, _) = try make(cache: cache, api: api)
        await coordinator.load()
        XCTAssertEqual(coordinator.manifest?.tracks.map(\.songKey), ["a", "b", "c"], "no network: the list and «Suona» are still there")
        XCTAssertNotNil(coordinator.errorText)
        XCTAssertEqual(cache.lists["pl1"]?.tracks.map(\.songKey), ["a", "b", "c"], "a failed reading does not erase what was kept")
    }

    func testThePreparedListIsKeptToo() async throws {
        let cache = MemoryCache()
        let api = FakeAPI()
        api.scriptPrepare("pl1", [manifest(["a", "b"])])
        let (coordinator, _, _) = try make(cache: cache, api: api)
        await coordinator.sync()
        XCTAssertEqual(cache.lists["pl1"]?.tracks.map(\.songKey), ["a", "b"], "the sync of the playlist that plays refreshes what the page will show")
    }

    func testAnotherPlaylistsKeptListIsNeverUsed() throws {
        let cache = MemoryCache()
        cache.lists["other"] = manifest(["x"], id: "other")
        let (coordinator, _, _) = try make(cache: cache)
        XCTAssertNil(coordinator.manifest)
    }

    func testTakingASongOutOfThePlaylistUpdatesTheKeptList() async throws {
        let cache = MemoryCache()
        cache.lists["pl1"] = manifest(["a", "b", "c"])
        let (coordinator, _, _) = try make(cache: cache)
        _ = await coordinator.removeSong(songKey: "b", using: FakeRemover())
        XCTAssertEqual(cache.lists["pl1"]?.tracks.map(\.songKey), ["a", "c"], "the next opening does not show a song that was taken out")
    }

    func testARefusedRemovalKeepsTheListAsItWas() async throws {
        final class Refuser: PlaylistSongRemoving, @unchecked Sendable {
            func removeSong(songKey: String, fromPlaylist id: String) async throws -> PlaylistRemoveAck { throw MondropAPIError.http(404, "nope") }
        }
        let cache = MemoryCache()
        cache.lists["pl1"] = manifest(["a", "b", "c"])
        let (coordinator, _, _) = try make(cache: cache)
        _ = await coordinator.removeSong(songKey: "b", using: Refuser())
        XCTAssertEqual(coordinator.manifest?.tracks.map(\.songKey), ["a", "b", "c"])
        XCTAssertEqual(cache.lists["pl1"]?.tracks.map(\.songKey), ["a", "b", "c"])
    }

    func testWithNoCacheTheCoordinatorWorksAsBefore() async throws {
        let api = FakeAPI()
        api.scriptManifests("pl1", [.success(manifest(["a"]))])
        let (coordinator, _, _) = try make(cache: nil, api: api)
        XCTAssertNil(coordinator.manifest)
        await coordinator.load()
        XCTAssertEqual(coordinator.manifest?.tracks.map(\.songKey), ["a"])
    }
}
