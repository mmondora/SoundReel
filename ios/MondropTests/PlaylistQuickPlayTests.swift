import XCTest
@testable import Mondrop

/// «in mondrop voglio avere il bottone play, in homepage, direttamente sulla play list, in un angolo - oppure con una gesture» (Michele, 12 November; spec
/// 2026-11-12-mondrop-home-play-loop-reels-design.md M1): the play on the card of a playlist builds the queue the way «Suona» does on the page of the playlist — the phone's songs
/// first — from the list the phone kept or, when it has none, from SoundReel; «Suona in loop» sets the loop before it starts; and nothing here starts a sync.
@MainActor
final class PlaylistQuickPlayTests: XCTestCase {
    private final class FakePlayer: QueuePlaying {
        private(set) var events: [String] = []
        private(set) var queues: [PlayQueue] = []
        func start(_ queue: PlayQueue) { queues.append(queue); events.append("start") }
        func setRepeatMode(_ mode: RepeatMode) { events.append("repeat:\(mode.rawValue)") }
    }

    private final class MemoryCache: PlaylistManifestCaching, @unchecked Sendable {
        var kept: [String: OfflineManifest] = [:]
        private(set) var saved: [String] = []
        func load(playlistId: String) -> OfflineManifest? { kept[playlistId] }
        func save(_ manifest: OfflineManifest) { kept[manifest.playlistId] = manifest; saved.append(manifest.playlistId) }
        func prune(keeping ids: Set<String>) {}
    }

    /// An API whose manifest does not come until the test lets it: a slow network.
    private final class GatedAPI: MondropAPIProtocol, @unchecked Sendable {
        private let lock = NSLock()
        private var waiting: CheckedContinuation<OfflineManifest, Error>?
        private(set) var asked = 0
        func offlineManifest(playlistId: String) async throws -> OfflineManifest {
            // a second reading is a failure, not a second wait: a play that asks twice must FAIL the test, never hang it
            let again = lock.withLock { () -> Bool in asked += 1; return asked > 1 }
            if again { throw MondropAPIError.http(500, "asked twice") }
            return try await withCheckedThrowingContinuation { continuation in
                lock.withLock { waiting = continuation }
            }
        }
        func release(_ manifest: OfflineManifest) { lock.withLock { waiting }?.resume(returning: manifest) }
        func listPlaylists() async throws -> [MondropPlaylist] { throw MondropAPIError.http(404, nil) }
        func prepare(playlistId: String, retryFailed: Bool) async throws -> OfflineManifest { throw MondropAPIError.http(404, nil) }
        func net() async throws -> NetInfo { throw MondropAPIError.http(404, nil) }
        func track(songKey: String) async throws -> OfflineTrack { throw MondropAPIError.http(404, nil) }
        func requestDownload(songKey: String, priority: DownloadPriority) async throws -> DownloadAck { throw MondropAPIError.http(404, nil) }
        func setSource(songKey: String, youtubeUrl: String) async throws { throw MondropAPIError.http(404, nil) }
    }

    private func tracks(_ keys: [String], state: String? = "ready") -> [OfflineTrack] { keys.map { TestSupport.track($0, state: state) } }

    private func make(
        local: Set<String> = [], cache: MemoryCache? = nil, api: MondropAPIProtocol? = nil
    ) -> (quick: PlaylistQuickPlay, player: FakePlayer, cache: MemoryCache) {
        let cache = cache ?? MemoryCache()
        let api = api ?? FakeAPI()
        let player = FakePlayer()
        let quick = PlaylistQuickPlay(
            api: api, cache: cache, player: player,
            isLocal: { local.contains($0) },
            state: { local.contains($0.songKey) ? .local : .online(percent: nil) }
        )
        return (quick, player, cache)
    }

    // MARK: where the list comes from

    func testAPlaylistPlaysFromTheListThePhoneKeptAndNothingIsAsked() async {
        let cache = MemoryCache()
        cache.kept["pl1"] = TestSupport.manifest("pl1", tracks(["a", "b", "c"]))
        let api = FakeAPI()
        let rig = make(cache: cache, api: api)

        let outcome = await rig.quick.play(playlistId: "pl1", name: "Road trip")

        XCTAssertEqual(outcome, .started)
        XCTAssertEqual(rig.player.queues.first?.items.map(\.songKey), ["a", "b", "c"])
        XCTAssertEqual(rig.player.queues.first?.startIndex, 0, "from the top")
        XCTAssertEqual(rig.player.queues.first?.label, "Playlist · Road trip", "«In coda: Playlist · Road trip», like the page")
        XCTAssertEqual(rig.player.queues.first?.playlistId, "pl1", "the listens are credited to the playlist")
        XCTAssertEqual(api.calls, [], "the kept list is enough: SoundReel is not asked")
    }

    func testWhenThePhoneHasNoListSoundReelIsAskedAndTheListIsKept() async {
        let api = FakeAPI()
        api.scriptManifests("pl1", [.success(TestSupport.manifest("pl1", tracks(["a", "b"])))])
        let rig = make(api: api)

        let outcome = await rig.quick.play(playlistId: "pl1", name: "Road trip")

        XCTAssertEqual(outcome, .started)
        XCTAssertEqual(api.calls, ["manifest:pl1"], "one reading, no prepare and no sync")
        XCTAssertEqual(rig.player.queues.first?.items.map(\.songKey), ["a", "b"])
        XCTAssertEqual(rig.cache.saved, ["pl1"], "kept for the next time and for the page of the playlist")
    }

    func testAKeptListWithNothingToPlayIsAskedAgainAndTheFreshOneIsUsed() async {
        let cache = MemoryCache()
        cache.kept["pl1"] = TestSupport.manifest("pl1", tracks(["a"], state: "no_source"))
        let api = FakeAPI()
        api.scriptManifests("pl1", [.success(TestSupport.manifest("pl1", tracks(["a", "b"])))])
        let rig = make(cache: cache, api: api)

        let outcome = await rig.quick.play(playlistId: "pl1", name: "Road trip")

        XCTAssertEqual(outcome, .started)
        XCTAssertEqual(rig.player.queues.first?.items.map(\.songKey), ["a", "b"])
    }

    // MARK: the order

    func testThePhonesSongsGoFirstLikeOnThePageOfThePlaylist() async {
        let cache = MemoryCache()
        cache.kept["pl1"] = TestSupport.manifest("pl1", tracks(["a", "b", "c", "d"]))
        let rig = make(local: ["c", "d"], cache: cache)

        await rig.quick.play(playlistId: "pl1", name: "Road trip")

        XCTAssertEqual(rig.player.queues.first?.items.map(\.songKey), ["c", "d", "a", "b"], "«Vanno privilegiati i file già scaricati»; the playlist's own order inside each group")
    }

    func testShuffledMixesEachGroupAndTheDownloadedOnesPlayFirst() async {
        let cache = MemoryCache()
        cache.kept["pl1"] = TestSupport.manifest("pl1", tracks(["a", "b", "c", "d", "e", "f"]))
        let rig = make(local: ["d", "e", "f"], cache: cache)

        await rig.quick.play(playlistId: "pl1", name: "Road trip", shuffled: true)

        let keys = rig.player.queues.first?.items.map(\.songKey) ?? []
        XCTAssertEqual(keys.count, 6)
        XCTAssertEqual(Set(keys.prefix(3)), ["d", "e", "f"], "the phone's songs first, mixed among themselves")
        XCTAssertEqual(Set(keys.suffix(3)), ["a", "b", "c"])
    }

    func testASongTheServerFoundNoSourceForIsLeftOutUnlessItIsOnThePhone() async {
        let cache = MemoryCache()
        cache.kept["pl1"] = TestSupport.manifest("pl1", [TestSupport.track("a"), TestSupport.track("x", state: "no_source"), TestSupport.track("y", state: "no_source")])
        let rig = make(local: ["y"], cache: cache)

        await rig.quick.play(playlistId: "pl1", name: "Road trip")

        XCTAssertEqual(Set(rig.player.queues.first?.items.map(\.songKey) ?? []), ["a", "y"])
    }

    // MARK: the loop

    func testTheLoopIsSetBeforeTheQueueStartsAndOnlyWhenAsked() async {
        let cache = MemoryCache()
        cache.kept["pl1"] = TestSupport.manifest("pl1", tracks(["a", "b"]))

        let looping = make(cache: cache)
        await looping.quick.play(playlistId: "pl1", name: "Road trip", loop: true)
        XCTAssertEqual(looping.player.events, ["repeat:all", "start"], "the whole playlist goes round, and the loop is on from the first song")

        let plain = make(cache: cache)
        await plain.quick.play(playlistId: "pl1", name: "Road trip")
        XCTAssertEqual(plain.player.events, ["start"], "«Suona» does not touch the loop the person chose")
    }

    // MARK: when it cannot

    func testAPlaylistWithNothingToPlaySaysSoAndStartsNothing() async {
        let cache = MemoryCache()
        cache.kept["pl1"] = TestSupport.manifest("pl1", tracks(["a", "b"], state: "no_source"))
        let rig = make(cache: cache)          // the network is not there either (no script)

        let outcome = await rig.quick.play(playlistId: "pl1", name: "Road trip")

        XCTAssertEqual(outcome, .nothingToPlay)
        XCTAssertEqual(rig.player.events, [])
    }

    func testNeitherAKeptListNorTheNetworkIsAnUnreadablePlaylist() async {
        let rig = make()

        let outcome = await rig.quick.play(playlistId: "pl1", name: "Road trip")

        XCTAssertEqual(outcome, .unreadable)
        XCTAssertEqual(rig.player.events, [], "the player is left alone")
        XCTAssertNil(rig.quick.loadingId, "and the button is free again")
    }

    func testAnEmptyPlaylistHasNothingToPlay() async {
        let cache = MemoryCache()
        cache.kept["pl1"] = TestSupport.manifest("pl1", [])
        let api = FakeAPI()
        api.scriptManifests("pl1", [.success(TestSupport.manifest("pl1", []))])
        let rig = make(cache: cache, api: api)

        let outcome = await rig.quick.play(playlistId: "pl1", name: "Road trip")

        XCTAssertEqual(outcome, .nothingToPlay)
    }

    // MARK: a double tap

    func testASecondTapWhileTheListIsOnItsWayStartsNothingMore() async throws {
        let api = GatedAPI()
        let rig = make(api: api)

        let first = Task { await rig.quick.play(playlistId: "pl1", name: "Road trip") }
        try await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(rig.quick.loadingId, "pl1", "the button shows it is working")

        let second = await rig.quick.play(playlistId: "pl1", name: "Road trip")
        XCTAssertEqual(second, .busy)
        XCTAssertEqual(api.asked, 1, "one reading, not two")

        api.release(TestSupport.manifest("pl1", tracks(["a", "b"])))
        let outcome = await first.value
        XCTAssertEqual(outcome, .started)
        XCTAssertEqual(rig.player.queues.count, 1, "one queue, not two")
        XCTAssertNil(rig.quick.loadingId)
    }

    // MARK: the words

    func testTheWordsOfWhatWentWrong() {
        XCTAssertEqual(PlaylistQuickPlay.Outcome.unreadable.message(playlistName: "Road trip"), "Non riesco a leggere la playlist.")
        XCTAssertEqual(PlaylistQuickPlay.Outcome.nothingToPlay.message(playlistName: "Road trip"), "Niente da suonare in «Road trip».")
        XCTAssertNil(PlaylistQuickPlay.Outcome.started.message(playlistName: "Road trip"))
        XCTAssertNil(PlaylistQuickPlay.Outcome.busy.message(playlistName: "Road trip"))
    }
}
