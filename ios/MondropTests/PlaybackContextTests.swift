import AVFoundation
import XCTest
@testable import Mondrop

/// What the player says about itself to the sync of the playlist that plays (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U2): is
/// a song really playing, and which playlist was the queue started from. A queue that a relaunch brings back is loaded and PAUSED: that is not playing.
@MainActor
final class PlaybackContextTests: XCTestCase {
    private var dir: URL!
    private var defaults: UserDefaults!
    private var suite = ""

    override func setUpWithError() throws {
        continueAfterFailure = false
        dir = try TestSupport.tempDir("playback-context")
        suite = "mondrop.test.playbackcontext.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    /// Silence as a WAV file (PCM 16 bit, mono, 8 kHz).
    private static func silentWAV(seconds: Double) -> Data {
        let rate: UInt32 = 8_000
        let bytes = UInt32(Double(rate) * 2 * seconds)
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append(Data("RIFF".utf8)); u32(36 + bytes); d.append(Data("WAVE".utf8))
        d.append(Data("fmt ".utf8)); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        d.append(Data("data".utf8)); u32(bytes)
        d.append(Data(repeating: 0, count: Int(bytes)))
        return d
    }

    private func newPlayer(songs: Int) throws -> LocalAudioPlayer {
        let offline = OfflineStore(root: dir.appendingPathComponent("offline"))
        for n in 0..<songs where offline.item(songKey: "t::song \(n)") == nil {
            let staged = offline.stagingURL()
            try Self.silentWAV(seconds: 1).write(to: staged)
            try offline.install(stagedFile: staged, songKey: "t::song \(n)", metadata: InstallMetadata(title: "Song \(n)", artist: "T", version: "1-1"))
        }
        let clock = FakeTrackerClock()
        let events = EventQueue(directory: dir.appendingPathComponent("events"))
        let recorder = PlayRecorder(queue: events, store: offline, uploader: nil, journal: MemoryJournal(), clock: clock.clock)
        return LocalAudioPlayer(
            store: offline, api: FakeAPI(), recorder: recorder,
            snapshots: QueueSnapshotStore(directory: dir, defaults: defaults, positionKey: "position"),
            lyricsLoader: LyricsLoader(transport: FakeLyricsTransport([.success(nil)]), directory: dir.appendingPathComponent("lyrics")),
            repeatStore: MemoryRepeatModeStore(.off),
            likes: LikesStore(directory: dir.appendingPathComponent("likes"), transport: FakeLikesTransport(), currentUser: { "mike" }, clock: SleepLog().clock, autoFlush: false),
            commandLog: RemoteCommandLog(defaults: defaults)
        )
    }

    private func items(_ n: Int) -> [QueueItem] {
        (0..<n).map { QueueItem(songKey: "t::song \($0)", title: "Song \($0)", artist: "T") }
    }

    /// Everything the observer hears, in order.
    private final class Heard {
        var contexts: [PlaybackContext] = []
    }

    private func listen(_ player: LocalAudioPlayer) -> Heard {
        let heard = Heard()
        player.observePlayback { heard.contexts.append($0) }
        return heard
    }

    // MARK: a queue started from a playlist

    func testTheObserverHearsThePresentFirst() throws {
        let player = try newPlayer(songs: 2)
        let heard = listen(player)
        XCTAssertEqual(heard.contexts, [PlaybackContext(isPlaying: false, playlistId: nil)])
    }

    func testANewObserverHearsThePresentToo() throws {
        let player = try newPlayer(songs: 2)
        player.setQueue(items(2), startAt: 0, playlistId: "a", label: "Playlist · A", autoplay: false)
        let first = listen(player)
        let second = listen(player)
        XCTAssertEqual(first.contexts, [PlaybackContext(isPlaying: false, playlistId: "a")])
        XCTAssertEqual(second.contexts, [PlaybackContext(isPlaying: false, playlistId: "a")], "an observer that comes later is told where things are, not only what changes next")
        player.setQueue(items(2), startAt: 0, playlistId: "b", label: "Playlist · B", autoplay: false)
        XCTAssertEqual(first.contexts.count, 1, "the first observer was replaced: it hears nothing more")
        XCTAssertEqual(second.contexts.last, PlaybackContext(isPlaying: false, playlistId: "b"))
    }

    func testAQueueStartedFromAPlaylistIsPlayingAndNamesThePlaylist() throws {
        let player = try newPlayer(songs: 2)
        let heard = listen(player)
        player.start(PlayQueue(items: items(2), startIndex: 0, label: "Playlist · Road trip", playlistId: "pl1"))
        XCTAssertEqual(player.queuePlaylistId, "pl1")
        XCTAssertTrue(player.playing)
        XCTAssertEqual(heard.contexts.last, PlaybackContext(isPlaying: true, playlistId: "pl1"))
        XCTAssertEqual(player.playbackContext, PlaybackContext(isPlaying: true, playlistId: "pl1"))
    }

    func testAQueueNotBornFromAPlaylistHasNone() throws {
        let player = try newPlayer(songs: 2)
        let heard = listen(player)
        player.start(PlayQueue(items: items(2), startIndex: 0, label: "Ricerca · Thriller", playlistId: nil))
        XCTAssertNil(player.queuePlaylistId)
        XCTAssertEqual(heard.contexts.last, PlaybackContext(isPlaying: true, playlistId: nil))
    }

    func testAddingASongFromCercaToThePlayingQueueKeepsThePlaylistOfTheQueue() throws {
        // «Aggiungi in coda» adds to the queue that plays: the queue is still the one that was started from the playlist
        let player = try newPlayer(songs: 3)
        player.start(PlayQueue(items: items(2), startIndex: 0, label: "Playlist · Road trip", playlistId: "pl1"))
        _ = player.append([TestSupport.track("t::song 2")], isLocal: { _ in true })
        XCTAssertEqual(player.queuePlaylistId, "pl1")
    }

    // MARK: switching, and every change reaches the observer in the right order

    func testOnceTheQueueIsAnotherPlaylistThePlayerNeverNamesTheOldOneAgain() throws {
        let player = try newPlayer(songs: 2)
        let heard = listen(player)
        player.start(PlayQueue(items: items(2), startIndex: 0, label: "Playlist · A", playlistId: "a"))
        player.start(PlayQueue(items: items(2), startIndex: 1, label: "Playlist · B", playlistId: "b"))
        XCTAssertEqual(heard.contexts.last, PlaybackContext(isPlaying: true, playlistId: "b"))
        let ids = heard.contexts.compactMap(\.playlistId)
        let lastA = try XCTUnwrap(ids.lastIndex(of: "a"))
        let firstB = try XCTUnwrap(ids.firstIndex(of: "b"))
        XCTAssertLessThan(lastA, firstB, "from the moment the queue is «b» the player says «b»: a stale name would sync the playlist that no longer plays")
    }

    func testTheObserverHearsTheQueueChangeEvenWhenNothingPlays() throws {
        // a queue that is only loaded, paused: the playlist it came from is still news (the sync of the playlist that was playing has to stop)
        let player = try newPlayer(songs: 2)
        let heard = listen(player)
        player.setQueue(items(2), startAt: 0, playlistId: "a", label: "Playlist · A", autoplay: false)
        XCTAssertEqual(heard.contexts.last, PlaybackContext(isPlaying: false, playlistId: "a"))
        player.setQueue(items(2), startAt: 0, playlistId: nil, label: "Aggiunti dalla ricerca", autoplay: false)
        XCTAssertEqual(heard.contexts.last, PlaybackContext(isPlaying: false, playlistId: nil))
        XCTAssertEqual(heard.contexts.count, 3, "the present, then the two changes")
    }

    func testEmptyingTheQueueIsNewsToo() throws {
        // nothing is loaded any more: the playlist the queue came from is gone with it, and the sync of that playlist has to hear it
        let player = try newPlayer(songs: 2)
        let heard = listen(player)
        player.setQueue(items(2), startAt: 0, playlistId: "a", label: "Playlist · A", autoplay: false)
        XCTAssertEqual(heard.contexts.last, PlaybackContext(isPlaying: false, playlistId: "a"))
        player.setQueue([], startAt: 0, playlistId: nil, label: nil, autoplay: false)
        XCTAssertEqual(heard.contexts.last, PlaybackContext(isPlaying: false, playlistId: nil))
        XCTAssertNil(player.queuePlaylistId)
    }

    func testTheObserverHearsAChangeOnceNotEveryTimeTheSameThingIsSet() throws {
        let player = try newPlayer(songs: 2)
        let heard = listen(player)
        player.setQueue(items(2), startAt: 0, playlistId: "a", label: "Playlist · A", autoplay: false)
        let afterLoading = heard.contexts.count
        player.pauseOnly()
        player.pauseOnly()
        XCTAssertEqual(heard.contexts.count, afterLoading, "pausing what is already paused is nothing new")
    }

    // MARK: a queue the phone brings back

    func testAQueueBroughtBackAtLaunchIsLoadedForItsPlaylistButNotPlaying() throws {
        let first = try newPlayer(songs: 2)
        first.setQueue(items(2), startAt: 1, playlistId: "pl1", label: "Playlist · Road trip", autoplay: false)

        let relaunched = try newPlayer(songs: 2)
        let heard = listen(relaunched)
        XCTAssertEqual(heard.contexts, [PlaybackContext(isPlaying: false, playlistId: "pl1")], "the playlist comes back, and it is not playing")
        XCTAssertFalse(relaunched.playing)
        XCTAssertEqual(relaunched.queuePlaylistId, "pl1")
    }

    func testTheUserPressingPlayOnTheBroughtBackQueueMakesItPlayingForTheSamePlaylist() throws {
        let first = try newPlayer(songs: 2)
        first.setQueue(items(2), startAt: 0, playlistId: "pl1", label: "Playlist · Road trip", autoplay: false)
        let relaunched = try newPlayer(songs: 2)
        let heard = listen(relaunched)
        relaunched.playOnly()
        XCTAssertEqual(heard.contexts.last, PlaybackContext(isPlaying: true, playlistId: "pl1"))
    }

    // MARK: the real player wired to the sync of the playing playlist

    private struct Wired {
        let sync: PlayingPlaylistSync
        let api: FakeAPI
        let rig: EngineRig
    }

    /// What the app does with the shared player, with a player of the test's own and fakes behind the sync.
    private func wire(_ player: LocalAudioPlayer, limit: SyncWarnLimit = .gb2) throws -> Wired {
        let rig = try EngineRig()
        let api = FakeAPI()
        api.scriptPrepare("pl1", [TestSupport.manifest("pl1", [TestSupport.track("x1"), TestSupport.track("x2")])])
        api.scriptPrepare("pl2", [TestSupport.manifest("pl2", [TestSupport.track("y1")])])
        let sync = PlayingPlaylistSync(api: api, engine: rig.engine, limit: { limit }, hasKey: { true }, clock: FakeClock().clock)
        player.observePlayback { sync.playbackChanged($0) }
        return Wired(sync: sync, api: api, rig: rig)
    }

    func testAQueueStartedFromAPlaylistOnTheRealPlayerSyncsThatPlaylist() async throws {
        let player = try newPlayer(songs: 2)
        let w = try wire(player)
        player.start(PlayQueue(items: items(2), startIndex: 0, label: "Playlist · Road trip", playlistId: "pl1"))
        await w.sync.settledOrFail()
        XCTAssertEqual(w.api.calls, ["prepare:pl1:retry=false"])
        XCTAssertEqual(Set(w.rig.engine.progress.keys), ["x1", "x2"])
    }

    func testAQueueFromCercaOnTheRealPlayerSyncsNothing() async throws {
        let player = try newPlayer(songs: 2)
        let w = try wire(player)
        player.start(PlayQueue(items: items(2), startIndex: 0, label: "Ricerca · Thriller", playlistId: nil))
        XCTAssertTrue(player.playing)
        await w.sync.settledOrFail()
        XCTAssertTrue(w.api.calls.isEmpty)
        XCTAssertTrue(w.rig.engine.progress.isEmpty)
    }

    func testAQueueBroughtBackPausedSyncsNothingUntilTheUserPlaysIt() async throws {
        let first = try newPlayer(songs: 2)
        first.setQueue(items(2), startAt: 0, playlistId: "pl1", label: "Playlist · Road trip", autoplay: false)

        let relaunched = try newPlayer(songs: 2)
        let w = try wire(relaunched)
        await w.sync.settledOrFail()
        XCTAssertFalse(relaunched.playing)
        XCTAssertTrue(w.api.calls.isEmpty, "the playlist is back in the queue but nothing plays: nothing is synced")

        relaunched.playOnly()
        await w.sync.settledOrFail()
        XCTAssertEqual(w.api.calls, ["prepare:pl1:retry=false"], "the user pressed play")
    }

    func testSwitchingFromOnePlaylistToAnotherOnTheRealPlayerSyncsTheSecond() async throws {
        let player = try newPlayer(songs: 2)
        let w = try wire(player)
        player.start(PlayQueue(items: items(2), startIndex: 0, label: "Playlist · A", playlistId: "pl1"))
        await w.sync.settledOrFail()
        player.start(PlayQueue(items: items(2), startIndex: 1, label: "Playlist · B", playlistId: "pl2"))
        await w.sync.settledOrFail()
        XCTAssertEqual(w.api.calls, ["prepare:pl1:retry=false", "prepare:pl2:retry=false"])
        XCTAssertEqual(Set(w.rig.engine.progress.keys), ["x1", "x2", "y1"])
    }

    func testTheSongsOfThePlaylistStartedAgainOnTheRealPlayerAreNotSyncedTwice() async throws {
        let player = try newPlayer(songs: 2)
        let w = try wire(player)
        player.start(PlayQueue(items: items(2), startIndex: 0, label: "Playlist · A", playlistId: "pl1"))
        player.start(PlayQueue(items: items(2), startIndex: 1, label: "Playlist · A", playlistId: "pl1"))   // another song of the same playlist
        player.next()
        player.previous()
        await w.sync.settledOrFail()
        XCTAssertEqual(w.api.calls, ["prepare:pl1:retry=false"])
    }

    // MARK: only the shared player reports to the app

    func testAPlayerThatNobodyObservesReportsToNobody() throws {
        let player = try newPlayer(songs: 2)
        player.setQueue(items(2), startAt: 0, playlistId: "a", label: "Playlist · A", autoplay: false)
        XCTAssertEqual(player.playbackContext, PlaybackContext(isPlaying: false, playlistId: "a"))
    }
}
