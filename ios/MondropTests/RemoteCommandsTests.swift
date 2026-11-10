import MediaPlayer
import XCTest
@testable import Mondrop

/// What Bluetooth, the car and the lock screen can press (spec 2026-11-10-mondrop-like-and-repeat-design.md L5, L6): the loop and the like, on
/// top of play, pause, avanti and indietro; every command that arrives is written down in ONE place so that Settings can say what the car
/// really sends. The handlers of the system are thin: they call `perform`, which is what is tested here.
final class RemoteCommandHistoryTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func testTheNewestCommandIsFirst() {
        var list: [RemoteCommandRecord] = []
        list = RemoteCommandHistory.adding("Play", at: t0, to: list)
        list = RemoteCommandHistory.adding("Pausa", at: t0.addingTimeInterval(5), to: list)
        list = RemoteCommandHistory.adding("Avanti", at: t0.addingTimeInterval(9), to: list)
        XCTAssertEqual(list.map(\.name), ["Avanti", "Pausa", "Play"])
        XCTAssertEqual(list.first?.at, t0.addingTimeInterval(9))
    }

    func testOnlyTheLastTwentyAreKept() {
        var list: [RemoteCommandRecord] = []
        for n in 0..<25 { list = RemoteCommandHistory.adding("c\(n)", at: t0.addingTimeInterval(Double(n)), to: list) }
        XCTAssertEqual(list.count, 20)
        XCTAssertEqual(RemoteCommandHistory.capacity, 20)
        XCTAssertEqual(list.first?.name, "c24")
        XCTAssertEqual(list.last?.name, "c5", "the five oldest are gone")
    }

    func testTheCommandsHaveTheirNamesInItalian() {
        XCTAssertEqual(RemoteCommand.play.logName, "Play")
        XCTAssertEqual(RemoteCommand.pause.logName, "Pausa")
        XCTAssertEqual(RemoteCommand.togglePlayPause.logName, "Play/Pausa")
        XCTAssertEqual(RemoteCommand.next.logName, "Avanti")
        XCTAssertEqual(RemoteCommand.previous.logName, "Indietro")
        XCTAssertEqual(RemoteCommand.repeatMode(.off).logName, "Ripeti: no")
        XCTAssertEqual(RemoteCommand.repeatMode(.all).logName, "Ripeti: tutto")
        XCTAssertEqual(RemoteCommand.repeatMode(.one).logName, "Ripeti: questo brano")
        XCTAssertEqual(RemoteCommand.like(negative: false).logName, "Mi piace")
        XCTAssertEqual(RemoteCommand.like(negative: true).logName, "Non mi piace più")
    }
}

@MainActor
final class RemoteCommandLogTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite = ""

    override func setUp() {
        suite = "mondrop.test.commandlog.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    func testWhatArrivedIsKeptNewestFirstWithItsTime() {
        var now = Date(timeIntervalSince1970: 1_800_000_000)
        let log = RemoteCommandLog(defaults: defaults, now: { now })
        log.record("Play")
        now = now.addingTimeInterval(30)
        log.record("Ripeti: tutto")
        XCTAssertEqual(log.entries.map(\.name), ["Ripeti: tutto", "Play"])
        XCTAssertEqual(log.entries.first?.at, now)
    }

    func testItIsKeptBetweenLaunches() {
        let first = RemoteCommandLog(defaults: defaults, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        first.record("Avanti")
        first.record("Mi piace")
        let second = RemoteCommandLog(defaults: defaults)
        XCTAssertEqual(second.entries.map(\.name), ["Mi piace", "Avanti"])
    }

    func testTheLastTwentyAreKeptOnTheDiskToo() {
        let log = RemoteCommandLog(defaults: defaults)
        for n in 0..<30 { log.record("c\(n)") }
        XCTAssertEqual(RemoteCommandLog(defaults: defaults).entries.count, 20)
        XCTAssertEqual(RemoteCommandLog(defaults: defaults).entries.first?.name, "c29")
    }

    func testSomethingUnreadableInTheDefaultsIsAnEmptyList() {
        defaults.set(Data("not json".utf8), forKey: RemoteCommandLog.key)
        XCTAssertTrue(RemoteCommandLog(defaults: defaults).entries.isEmpty)
        defaults.set("a string", forKey: RemoteCommandLog.key)
        XCTAssertTrue(RemoteCommandLog(defaults: defaults).entries.isEmpty)
    }

    func testItCanBeCleared() {
        let log = RemoteCommandLog(defaults: defaults)
        log.record("Play")
        log.clear()
        XCTAssertTrue(log.entries.isEmpty)
        XCTAssertTrue(RemoteCommandLog(defaults: defaults).entries.isEmpty)
    }
}

@MainActor
final class RemoteCommandsTests: XCTestCase {
    private var dir: URL!
    private var defaults: UserDefaults!
    private var suite = ""

    struct Rig {
        let player: LocalAudioPlayer
        let likes: LikesStore
        let log: RemoteCommandLog
        let repeatStore: MemoryRepeatModeStore
        let recorder: PlayRecorder
        let events: EventQueue
        let clock: FakeTrackerClock
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        dir = try TestSupport.tempDir("remote-commands")
        suite = "mondrop.test.remote.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    private func make(songs: Int = 3, startAt: Int = 0, loop: RepeatMode = .off) -> Rig {
        let offline = OfflineStore(root: dir.appendingPathComponent("offline"))
        let likes = LikesStore(
            directory: dir.appendingPathComponent("likes"), transport: FakeLikesTransport(), currentUser: { "mike" },
            clock: SleepLog().clock, autoFlush: false
        )
        let log = RemoteCommandLog(defaults: defaults, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        let repeatStore = MemoryRepeatModeStore(loop)
        let clock = FakeTrackerClock()
        let events = EventQueue(directory: dir.appendingPathComponent("events"))
        let recorder = PlayRecorder(queue: events, store: offline, uploader: nil, journal: MemoryJournal(), clock: clock.clock)
        let player = LocalAudioPlayer(
            store: offline, api: FakeAPI(), recorder: recorder,
            snapshots: QueueSnapshotStore(directory: dir, defaults: defaults, positionKey: "position"),
            lyricsLoader: LyricsLoader(transport: FakeLyricsTransport([.success(nil)]), directory: dir.appendingPathComponent("lyrics")),
            repeatStore: repeatStore, likes: likes, commandLog: log
        )
        if songs > 0 {
            let items = (0..<songs).map { QueueItem(songKey: "artist::song \($0)", title: "Song \($0)", artist: "Artist") }
            player.setQueue(items, startAt: startAt, autoplay: false)
        }
        return Rig(player: player, likes: likes, log: log, repeatStore: repeatStore, recorder: recorder, events: events, clock: clock)
    }

    // MARK: what is told to the system

    func testTheSystemIsToldTheLoopAndTheLikeAreThereAndNothingElseIsNew() {
        let center = MPRemoteCommandCenter.shared()
        let before = (center.changeShuffleModeCommand.isEnabled, center.dislikeCommand.isEnabled, center.bookmarkCommand.isEnabled)
        _ = make()
        XCTAssertTrue(center.changeRepeatModeCommand.isEnabled)
        XCTAssertTrue(center.likeCommand.isEnabled)
        XCTAssertEqual(center.likeCommand.localizedTitle, "Mi piace")
        XCTAssertEqual(center.changeShuffleModeCommand.isEnabled, before.0, "the shuffle was not asked for: the player leaves it alone")
        XCTAssertEqual(center.dislikeCommand.isEnabled, before.1, "no dislike")
        XCTAssertEqual(center.bookmarkCommand.isEnabled, before.2, "no bookmark")
    }

    func testThePlayerNamesNoCommandBeyondTheOnesAsked() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("MondropKit/LocalAudioPlayer.swift"), encoding: .utf8)
        for untouched in ["changeShuffleModeCommand", "dislikeCommand", "bookmarkCommand", "ratingCommand", "skipForwardCommand", "seekForwardCommand"] {
            XCTAssertFalse(source.contains(untouched), "«\(untouched)» was not asked for (spec L5: only the loop and the like are new)")
        }
    }

    func testTheLoopTheSystemShowsIsAlwaysTheOneThePlayerHas() {
        let rig = make(loop: .all)
        let center = MPRemoteCommandCenter.shared()
        XCTAssertEqual(rig.player.repeatMode, .all, "a player that starts finds the loop the user had left")
        XCTAssertEqual(center.changeRepeatModeCommand.currentRepeatType, .all)
        rig.player.setRepeatMode(.one)
        XCTAssertEqual(center.changeRepeatModeCommand.currentRepeatType, .one)
        rig.player.cycleRepeatMode()
        XCTAssertEqual(rig.player.repeatMode, .off)
        XCTAssertEqual(center.changeRepeatModeCommand.currentRepeatType, .off, "also when it changes from the Player's button")
    }

    func testTheLoopIsKeptForTheNextLaunch() {
        let rig = make()
        rig.player.setRepeatMode(.one)
        XCTAssertEqual(rig.repeatStore.mode, .one)
        rig.player.cycleRepeatMode()
        XCTAssertEqual(rig.repeatStore.mode, .off)
    }

    // MARK: the loop from outside

    func testARepeatCommandChangesTheLoopAndIsWrittenDown() {
        let rig = make()
        XCTAssertEqual(rig.player.perform(.repeatMode(.all)), .success)
        XCTAssertEqual(rig.player.repeatMode, .all)
        XCTAssertEqual(rig.log.entries.first?.name, "Ripeti: tutto")
        XCTAssertEqual(rig.player.perform(.repeatMode(.one)), .success)
        XCTAssertEqual(rig.player.repeatMode, .one)
        XCTAssertEqual(rig.player.perform(.repeatMode(.off)), .success)
        XCTAssertEqual(rig.player.repeatMode, .off)
        XCTAssertEqual(rig.log.entries.map(\.name), ["Ripeti: no", "Ripeti: questo brano", "Ripeti: tutto"])
    }

    func testTheLoopIsASettingSoItWorksWithNothingQueued() {
        let rig = make(songs: 0)
        XCTAssertEqual(rig.player.perform(.repeatMode(.all)), .success)
        XCTAssertEqual(rig.player.repeatMode, .all)
    }

    // MARK: the like from outside

    func testALikeCommandLikesTheSongThatPlaysAndTheSystemIsToldItIsActive() {
        let rig = make(startAt: 1)
        let center = MPRemoteCommandCenter.shared()
        XCTAssertFalse(center.likeCommand.isActive)
        XCTAssertEqual(rig.player.perform(.like(negative: false)), .success)
        XCTAssertTrue(rig.likes.isLiked("artist::song 1"))
        XCTAssertFalse(rig.likes.isLiked("artist::song 0"), "only the song that plays")
        XCTAssertTrue(center.likeCommand.isActive, "the car can show the heart full")
        XCTAssertEqual(rig.log.entries.first?.name, "Mi piace")
    }

    func testTheSameCommandAgainTakesTheLikeBack() {
        let rig = make()
        rig.player.perform(.like(negative: false))
        XCTAssertEqual(rig.player.perform(.like(negative: false)), .success)
        XCTAssertFalse(rig.likes.isLiked("artist::song 0"), "pressed on a liked song, the button unlikes it")
        XCTAssertFalse(MPRemoteCommandCenter.shared().likeCommand.isActive)
    }

    func testANegativeLikeCommandUnlikesAndNeverLikes() {
        let rig = make()
        rig.likes.setLiked(true, songKey: "artist::song 0")
        XCTAssertEqual(rig.player.perform(.like(negative: true)), .success)
        XCTAssertFalse(rig.likes.isLiked("artist::song 0"))
        XCTAssertEqual(rig.player.perform(.like(negative: true)), .success, "unlike of a song that is not liked: nothing to do, nothing wrong")
        XCTAssertFalse(rig.likes.isLiked("artist::song 0"))
        XCTAssertEqual(rig.log.entries.first?.name, "Non mi piace più")
    }

    func testALikeCommandWithNothingPlayingHasNothingToAct() {
        let rig = make(songs: 0)
        XCTAssertEqual(rig.player.perform(.like(negative: false)), .noActionableNowPlayingItem)
        XCTAssertEqual(rig.log.entries.first?.name, "Mi piace", "it arrived: it is written down even when there is nothing to do")
        XCTAssertFalse(MPRemoteCommandCenter.shared().likeCommand.isActive)
    }

    func testTheSystemAlwaysShowsTheHeartOfTheSongThatPlaysNow() {
        let rig = make(startAt: 0)
        let center = MPRemoteCommandCenter.shared()
        rig.likes.setLiked(true, songKey: "artist::song 0")
        XCTAssertTrue(center.likeCommand.isActive, "liked from the screen: the car follows")
        rig.player.next()                                      // song 1: not liked
        XCTAssertFalse(center.likeCommand.isActive)
        rig.player.previous()
        XCTAssertTrue(center.likeCommand.isActive, "back on the liked one")
        rig.likes.setLiked(false, songKey: "artist::song 0")   // another phone took it back and the app synced
        XCTAssertFalse(center.likeCommand.isActive)
    }

    // MARK: every command in one place

    func testEveryCommandThatArrivesIsWrittenDownByTheSamePlace() {
        let rig = make()
        rig.player.perform(.play)
        rig.player.perform(.pause)
        rig.player.perform(.togglePlayPause)
        rig.player.perform(.next)
        rig.player.perform(.previous)
        rig.player.perform(.repeatMode(.all))
        rig.player.perform(.like(negative: false))
        XCTAssertEqual(
            rig.log.entries.map(\.name),
            ["Mi piace", "Ripeti: tutto", "Indietro", "Avanti", "Play/Pausa", "Pausa", "Play"],
            "old and new, newest first"
        )
    }

    func testAvantiAndIndietroStillMoveTheQueue() {
        let rig = make(startAt: 0)
        XCTAssertEqual(rig.player.perform(.next), .success)
        XCTAssertEqual(rig.player.index, 1)
        XCTAssertEqual(rig.player.perform(.previous), .success)
        XCTAssertEqual(rig.player.index, 0)
    }

    // MARK: the loop in the queue

    func testAvantiOnTheLastSongWithTheWholeQueueLoopingGoesToTheFirst() {
        let rig = make(startAt: 2, loop: .all)
        rig.player.next()
        XCTAssertEqual(rig.player.index, 0)
    }

    func testAvantiOnTheLastSongWithTheLoopOffStopsAsBefore() {
        let rig = make(startAt: 2, loop: .off)
        rig.player.next()
        XCTAssertEqual(rig.player.index, 2)
        XCTAssertFalse(rig.player.playing)
    }

    func testAvantiWithThisSongLoopingGoesToTheNextAndKeepsTheLoop() {
        let rig = make(startAt: 0, loop: .one)
        rig.player.next()
        XCTAssertEqual(rig.player.index, 1)
        XCTAssertEqual(rig.player.repeatMode, .one, "the loop stays on")
    }

    func testAvantiOnTheLastSongWithThisSongLoopingStopsLikeWithTheLoopOff() {
        let rig = make(startAt: 2, loop: .one)
        rig.player.next()
        XCTAssertEqual(rig.player.index, 2)
        XCTAssertFalse(rig.player.playing)
    }

    func testASongThatEndsWithTheWholeQueueLoopingBeginsTheFirstAfterTheLast() {
        let rig = make(startAt: 2, loop: .all)
        rig.player.songEnded()
        XCTAssertEqual(rig.player.index, 0)
    }

    func testASongThatEndsInTheMiddleGoesOnToTheNextWhateverTheLoopIs() {
        for loop in [RepeatMode.off, .all] {
            let rig = make(startAt: 0, loop: loop)
            rig.player.songEnded()
            XCTAssertEqual(rig.player.index, 1, "\(loop)")
        }
    }

    func testASongThatEndsByItselfIsACompletedListenWhateverComesNext() throws {
        for loop in [RepeatMode.off, .all] {
            let rig = make(startAt: 0, loop: loop)
            let tracker = rig.recorder.tracker
            tracker.begin(songKey: "artist::song 0", durationMs: 10_000, origin: .local, playlistId: nil)
            tracker.setPlaying(true)
            rig.clock.advance(10)
            let before = rig.events.pendingPlays(limit: 10).count          // the folder of the events is shared by the two rigs
            rig.player.songEnded()
            let plays = rig.events.pendingPlays(limit: 10)
            XCTAssertEqual(plays.count, before + 1, "\(loop)")
            XCTAssertEqual(plays.last?.completed, true, "it arrived at the end (\(loop))")
        }
    }

    func testAvantiOnTheOnlySongWithTheWholeQueueLoopingClosesThePassAsNotCompleted() throws {
        let rig = make(songs: 1, startAt: 0, loop: .all)
        let tracker = rig.recorder.tracker
        tracker.begin(songKey: "artist::song 0", durationMs: 10_000, origin: .local, playlistId: nil)
        tracker.setPlaying(true)
        rig.clock.advance(6)
        rig.player.next()
        let plays = rig.events.pendingPlays(limit: 10)
        XCTAssertEqual(plays.count, 1)
        XCTAssertEqual(plays.first?.completed, false, "the user cut it with «avanti»")
        XCTAssertEqual(plays.first?.listenedMs, 6_000)
    }

    func testASongThatEndsAtTheEndOfAQueueWithTheLoopOffStops() {
        let rig = make(startAt: 2, loop: .off)
        rig.player.songEnded()
        XCTAssertEqual(rig.player.index, 2)
        XCTAssertFalse(rig.player.playing)
    }

    func testASongThatEndsWithThisSongLoopingStaysWhereItIs() {
        let rig = make(startAt: 1, loop: .one)
        rig.player.songEnded()
        XCTAssertEqual(rig.player.index, 1)
        XCTAssertEqual(rig.player.queue.count, 3)
    }

    // MARK: every pass of a loop is a listen

    func testALoopedSongEndsAsACompletedListenAndStartsAnotherOfItsOwn() throws {
        let rig = make()
        let tracker = rig.recorder.tracker
        tracker.begin(songKey: "artist::song 0", durationMs: 10_000, origin: .local, playlistId: "p1")
        tracker.setPlaying(true)
        rig.clock.advance(10)
        let firstId = try XCTUnwrap(tracker.openSession?.id)

        rig.player.closeListenAndStartAnother(completed: true)
        var plays = rig.events.pendingPlays(limit: 10)
        XCTAssertEqual(plays.count, 1)
        XCTAssertEqual(plays.first?.songKey, "artist::song 0")
        XCTAssertEqual(plays.first?.completed, true, "it arrived at the end")
        XCTAssertEqual(plays.first?.listenedMs, 10_000)
        XCTAssertEqual(plays.first?.id, firstId)
        let second = try XCTUnwrap(tracker.openSession)
        XCTAssertNotEqual(second.id, firstId, "the next pass is a listen of its own")
        XCTAssertEqual(second.songKey, "artist::song 0")
        XCTAssertEqual(second.playlistId, "p1", "same playlist, same origin")

        tracker.setPlaying(true)
        rig.clock.advance(10)
        rig.player.closeListenAndStartAnother(completed: true)
        plays = rig.events.pendingPlays(limit: 10)
        XCTAssertEqual(plays.count, 2)
        XCTAssertEqual(Set(plays.map(\.id)).count, 2, "no duplicate id: each pass counts once")
        XCTAssertNotEqual(tracker.openSession?.id, second.id)
    }

    func testAPassTheUserCutShortWithAvantiIsNotACompletedListen() throws {
        let rig = make()
        let tracker = rig.recorder.tracker
        tracker.begin(songKey: "artist::song 0", durationMs: 10_000, origin: .local, playlistId: nil)
        tracker.setPlaying(true)
        rig.clock.advance(6)
        rig.player.closeListenAndStartAnother(completed: false)
        let plays = rig.events.pendingPlays(limit: 10)
        XCTAssertEqual(plays.count, 1)
        XCTAssertEqual(plays.first?.completed, false)
        XCTAssertEqual(plays.first?.listenedMs, 6_000)
        XCTAssertNotNil(tracker.openSession)
    }
}
