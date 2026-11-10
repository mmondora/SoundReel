import AVFoundation
import XCTest
@testable import Mondrop

/// The end of a song, as the player really gets it (spec 2026-11-10-mondrop-like-and-repeat-design.md L4): the notification of the item that
/// reached its end goes through the REAL wiring of the player (an observer on the AVPlayerItem it made) to the loop and to the accounting of
/// the listens. The AVPlayer of a simulator that runs without an audio device does not advance, so the item is told it has ended: what is not
/// exercised is the audio itself (that `seek(to: .zero)` and `play()` really start the sound again: by hand, with a short song).
@MainActor
final class EndOfSongWiringTests: XCTestCase {
    private var dir: URL!
    private var defaults: UserDefaults!
    private var suite = ""

    override func setUpWithError() throws {
        continueAfterFailure = false
        dir = try TestSupport.tempDir("end-of-song")
        suite = "mondrop.test.endofsong.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    /// Silence as a WAV file (PCM 16 bit, mono, 8 kHz): `AVPlayer` sniffs the content, whatever the store calls the file.
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

    private struct Rig {
        let player: LocalAudioPlayer
        let events: EventQueue
        let recorder: PlayRecorder
        let clock: FakeTrackerClock
    }

    private func make(songs: Int, loop: RepeatMode) throws -> Rig {
        let offline = OfflineStore(root: dir.appendingPathComponent("offline"))
        for n in 0..<songs {
            let staged = offline.stagingURL()
            try Self.silentWAV(seconds: 1).write(to: staged)
            try offline.install(stagedFile: staged, songKey: "t::song \(n)", metadata: InstallMetadata(title: "Song \(n)", artist: "T", version: "1-1"))
        }
        let clock = FakeTrackerClock()
        let events = EventQueue(directory: dir.appendingPathComponent("events"))
        let recorder = PlayRecorder(queue: events, store: offline, uploader: nil, journal: MemoryJournal(), clock: clock.clock)
        let player = LocalAudioPlayer(
            store: offline, api: FakeAPI(), recorder: recorder,
            snapshots: QueueSnapshotStore(directory: dir, defaults: defaults, positionKey: "position"),
            lyricsLoader: LyricsLoader(transport: FakeLyricsTransport([.success(nil)]), directory: dir.appendingPathComponent("lyrics")),
            repeatStore: MemoryRepeatModeStore(loop),
            likes: LikesStore(directory: dir.appendingPathComponent("likes"), transport: FakeLikesTransport(), currentUser: { "mike" }, clock: SleepLog().clock, autoFlush: false),
            commandLog: RemoteCommandLog(defaults: defaults)
        )
        player.setQueue((0..<songs).map { QueueItem(songKey: "t::song \($0)", title: "Song \($0)", artist: "T") }, startAt: 0, autoplay: true)
        return Rig(player: player, events: events, recorder: recorder, clock: clock)
    }

    /// The AVPlayerItem the player made: private, so read by reflection.
    private func loadedItem(_ player: LocalAudioPlayer) -> AVPlayerItem? {
        let child = Mirror(reflecting: player).children.first { $0.label == "player" }
        return (child?.value as? AVPlayer)?.currentItem
    }

    /// The item reaches its end after `listened` seconds of listening (the tracker is told by hand what the audio would tell it).
    private func songReachesItsEnd(_ rig: Rig, after listened: Double) async throws {
        let item = try XCTUnwrap(loadedItem(rig.player), "the player made an AVPlayerItem for the file on the phone")
        rig.recorder.tracker.setPlaying(true)
        rig.clock.advance(listened)
        NotificationCenter.default.post(name: .AVPlayerItemDidPlayToEndTime, object: item)
        for _ in 0..<100 where rig.player.index == 0 && rig.events.pendingPlays(limit: 10).isEmpty { try await Task.sleep(nanoseconds: 20_000_000) }
        try await Task.sleep(nanoseconds: 100_000_000)
    }

    func testWithThisSongLoopingTheEndOfTheItemStartsTheSameSongAgainAndCountsTheFirstPass() async throws {
        let rig = try make(songs: 3, loop: .one)
        let firstSession = try XCTUnwrap(rig.recorder.tracker.openSession?.id)
        try await songReachesItsEnd(rig, after: 10)
        let plays = rig.events.pendingPlays(limit: 10)
        XCTAssertEqual(plays.count, 1)
        XCTAssertEqual(plays.first?.completed, true, "the pass arrived at the end")
        XCTAssertEqual(plays.first?.songKey, "t::song 0")
        XCTAssertEqual(plays.first?.id, firstSession)
        XCTAssertEqual(rig.player.index, 0, "the same song")
        XCTAssertTrue(rig.player.playing)
        let again = try XCTUnwrap(rig.recorder.tracker.openSession, "the next pass has its own listen")
        XCTAssertNotEqual(again.id, firstSession)
        XCTAssertEqual(again.songKey, "t::song 0")
    }

    func testWithTheLoopOffTheEndOfTheItemGoesOnToTheNextSong() async throws {
        let rig = try make(songs: 3, loop: .off)
        try await songReachesItsEnd(rig, after: 10)
        XCTAssertEqual(rig.player.index, 1)
        XCTAssertEqual(rig.events.pendingPlays(limit: 10).first?.completed, true)
    }

    func testWithTheWholeQueueLoopingTheEndOfTheLastSongStartsTheFirst() async throws {
        let rig = try make(songs: 2, loop: .all)
        rig.player.play(at: 1)
        try await songReachesItsEnd(rig, after: 10)
        XCTAssertEqual(rig.player.index, 0)
        XCTAssertTrue(rig.player.playing)
    }

    func testWithTheLoopOffTheEndOfTheLastSongStopsTheQueue() async throws {
        let rig = try make(songs: 2, loop: .off)
        rig.player.play(at: 1)
        try await songReachesItsEnd(rig, after: 10)
        XCTAssertEqual(rig.player.index, 1)
        XCTAssertFalse(rig.player.playing, "the queue ended, as it always did")
    }
}
