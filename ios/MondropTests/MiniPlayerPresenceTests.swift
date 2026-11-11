import AVFoundation
import XCTest
@testable import Mondrop

/// «Il mini player non deve essere visibile se non ci sono cose in play.» (Michele, 11 November, trying build 16; spec
/// 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U13): the bar is there when something was put in play in this run and it has not ended — a song
/// playing, or paused by the user, or a song the user queued from Cerca — and it is NOT there for a queue the phone brought back paused at launch (that is what
/// «Riprendi» on the first page is for), nor after the last song has ended, nor with nothing in the queue.
@MainActor
final class MiniPlayerPresenceTests: XCTestCase {
    private var dir: URL!
    private var defaults: UserDefaults!
    private var suite = ""

    override func setUpWithError() throws {
        continueAfterFailure = false
        dir = try TestSupport.tempDir("mini-player-presence")
        suite = "mondrop.test.miniplayerpresence.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

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

    // MARK: the rule

    func testTheBarIsShownOnlyForASongInPlay() {
        XCTAssertTrue(MiniPlayerPresence.isShown(title: "Song", inPlay: true))
        XCTAssertFalse(MiniPlayerPresence.isShown(title: "Song", inPlay: false), "a song that is only loaded (a queue brought back at launch) is not in play")
        XCTAssertFalse(MiniPlayerPresence.isShown(title: "", inPlay: true), "nothing to name")
        XCTAssertFalse(MiniPlayerPresence.isShown(title: "", inPlay: false))
    }

    func testWhereTheFileInPlayIsFollowsTheStatusOfThePlayer() {
        // «Non è chiaro dove sono i file ( locali o remoto )» (Michele, 11 November): the bar says it with the same three marks as the lists
        XCTAssertNil(MiniPlayerPresence.location(of: .idle), "nothing started: nothing to say")
        XCTAssertEqual(MiniPlayerPresence.location(of: .local), .local)
        XCTAssertEqual(MiniPlayerPresence.location(of: .streaming), .online(percent: nil))
        XCTAssertEqual(MiniPlayerPresence.location(of: .preparing), .online(percent: nil), "waiting for SoundReel to prepare it: it will come from there")
        XCTAssertEqual(MiniPlayerPresence.location(of: .failed("brano non disponibile")), .error("brano non disponibile"))
    }

    // MARK: what puts a song in play

    func testAFreshPlayerHasNothingInPlay() throws {
        let player = try newPlayer(songs: 2)
        XCTAssertFalse(player.inPlay)
    }

    func testAQueueBroughtBackAtLaunchIsLoadedButNotInPlayUntilTheUserPlaysIt() throws {
        let first = try newPlayer(songs: 2)
        first.setQueue(items(2), startAt: 1, playlistId: "pl1", label: "Playlist · Road trip", autoplay: false)

        let relaunched = try newPlayer(songs: 2)
        XCTAssertEqual(relaunched.title, "Song 1", "the song is there, for «Riprendi»")
        XCTAssertFalse(relaunched.inPlay, "…but it is not in play: no bar over the pages")
        XCTAssertFalse(MiniPlayerPresence.isShown(title: relaunched.title, inPlay: relaunched.inPlay))

        relaunched.playOnly()                         // «Riprendi», or the play of the lock screen / the car
        XCTAssertTrue(relaunched.inPlay)
        XCTAssertTrue(MiniPlayerPresence.isShown(title: relaunched.title, inPlay: relaunched.inPlay))
    }

    func testStartingAQueuePutsItInPlayAndPausingKeepsItThere() throws {
        let player = try newPlayer(songs: 2)
        player.start(PlayQueue(items: items(2), startIndex: 0, label: "Playlist · A", playlistId: "a"))
        XCTAssertTrue(player.inPlay)
        player.pauseOnly()
        XCTAssertFalse(player.playing)
        XCTAssertTrue(player.inPlay, "paused by the user: the bar stays, to start it again")
    }

    func testTappingASongOfAQueueBroughtBackPutsItInPlay() throws {
        let first = try newPlayer(songs: 3)
        first.setQueue(items(3), startAt: 0, playlistId: nil, label: "Sul telefono", autoplay: false)
        let relaunched = try newPlayer(songs: 3)
        XCTAssertFalse(relaunched.inPlay)
        relaunched.play(at: 2)
        XCTAssertTrue(relaunched.inPlay)
    }

    func testASongTheUserQueuedFromCercaOnAnEmptyQueueIsInPlay() throws {
        // «Aggiungi in coda» with nothing queued loads the song and waits for «Riproduci»: the user did put it there, and the bar is how they start it
        let player = try newPlayer(songs: 2)
        let outcome = player.append([TestSupport.track("t::song 0")], isLocal: { _ in true })
        XCTAssertEqual(outcome, .addedToEmptyQueue(1))
        XCTAssertFalse(player.playing)
        XCTAssertTrue(player.inPlay)
    }

    func testASongAddedToAQueueBroughtBackDoesNotPutItInPlay() throws {
        let first = try newPlayer(songs: 3)
        first.setQueue(items(2), startAt: 0, playlistId: nil, label: "Sul telefono", autoplay: false)
        let relaunched = try newPlayer(songs: 3)
        _ = relaunched.append([TestSupport.track("t::song 2")], isLocal: { _ in true })
        XCTAssertEqual(relaunched.queue.count, 3)
        XCTAssertFalse(relaunched.inPlay, "nothing was started: the queue is still the one that was brought back")
    }

    // MARK: what takes a song out of play

    func testTheEndOfTheLastSongTakesTheQueueOutOfPlay() throws {
        let player = try newPlayer(songs: 2)
        player.start(PlayQueue(items: items(2), startIndex: 1, label: "Playlist · A", playlistId: "a"))
        XCTAssertTrue(player.inPlay)
        player.songEnded()                            // repeat off, the last song: it stops
        XCTAssertFalse(player.playing)
        XCTAssertFalse(player.inPlay, "nothing is in play any more: the bar goes")
    }

    func testTheEndOfASongThatHasAnotherAfterItKeepsPlaying() throws {
        let player = try newPlayer(songs: 2)
        player.start(PlayQueue(items: items(2), startIndex: 0, label: "Playlist · A", playlistId: "a"))
        player.songEnded()
        XCTAssertEqual(player.index, 1)
        XCTAssertTrue(player.inPlay)
    }

    func testPressingNextOnTheLastSongStopsAndTakesItOutOfPlay() throws {
        let player = try newPlayer(songs: 2)
        player.start(PlayQueue(items: items(2), startIndex: 1, label: "Playlist · A", playlistId: "a"))
        player.next()
        XCTAssertFalse(player.playing)
        XCTAssertFalse(player.inPlay)
    }

    func testPlayingAgainAfterTheEndPutsItBackInPlay() throws {
        let player = try newPlayer(songs: 2)
        player.start(PlayQueue(items: items(2), startIndex: 1, label: "Playlist · A", playlistId: "a"))
        player.songEnded()
        XCTAssertFalse(player.inPlay)
        player.start(PlayQueue(items: items(2), startIndex: 0, label: "Playlist · A", playlistId: "a"))
        XCTAssertTrue(player.inPlay)
    }

    func testEmptyingTheQueueTakesItOutOfPlay() throws {
        let player = try newPlayer(songs: 2)
        player.start(PlayQueue(items: items(2), startIndex: 0, label: "Playlist · A", playlistId: "a"))
        player.setQueue([], startAt: 0, playlistId: nil, label: nil, autoplay: false)
        XCTAssertFalse(player.inPlay)
    }

    func testTheRepeatOfTheWholeQueueNeverEndsSoItStaysInPlay() throws {
        let player = try newPlayer(songs: 2)
        player.setRepeatMode(.all)
        player.start(PlayQueue(items: items(2), startIndex: 1, label: "Playlist · A", playlistId: "a"))
        player.songEnded()
        XCTAssertTrue(player.inPlay, "the loop goes back to the first song")
    }
}
