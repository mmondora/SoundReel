import XCTest
@testable import Mondrop

/// Siri (spec 2026-11-10-mondrop-like-and-repeat-design.md L9): the Tesla shows no repeat and no heart over Bluetooth, so the like and the loop
/// can also be asked by voice, whatever the head unit shows. What is decided (nothing playing, already liked, the loop asked for) is plain
/// code, tested here. Siri itself cannot be tested on a simulator: the sentences and the intents are checked by `SiriIntentsTests` (what they
/// say, where they run, that they share the app's own state) and the rest is tried by hand.
final class VoiceDecisionTests: XCTestCase {
    private let song = CurrentSong(songKey: "daft punk::one more time", title: "One More Time")

    // MARK: asking for the like

    func testNothingPlayingHasNothingToLike() {
        for wanted in [true, false] {
            let decision = VoiceDecision.like(wanted: wanted, current: nil, isLiked: false)
            XCTAssertEqual(decision.outcome, .nothingPlaying)
            XCTAssertFalse(decision.change)
        }
    }

    func testALikeOfASongThatIsNotLikedChangesIt() {
        let decision = VoiceDecision.like(wanted: true, current: song, isLiked: false)
        XCTAssertEqual(decision.outcome, .liked(title: "One More Time"))
        XCTAssertTrue(decision.change)
    }

    func testALikeOfASongThatIsAlreadyLikedChangesNothingAndSaysSo() {
        let decision = VoiceDecision.like(wanted: true, current: song, isLiked: true)
        XCTAssertEqual(decision.outcome, .alreadyLiked(title: "One More Time"))
        XCTAssertFalse(decision.change, "«mi piace» twice is not an unlike: Siri is never a switch")
    }

    func testAnUnlikeOfALikedSongChangesIt() {
        let decision = VoiceDecision.like(wanted: false, current: song, isLiked: true)
        XCTAssertEqual(decision.outcome, .unliked(title: "One More Time"))
        XCTAssertTrue(decision.change)
    }

    func testAnUnlikeOfASongThatIsNotLikedChangesNothingAndSaysSo() {
        let decision = VoiceDecision.like(wanted: false, current: song, isLiked: false)
        XCTAssertEqual(decision.outcome, .wasNotLiked(title: "One More Time"))
        XCTAssertFalse(decision.change)
    }

    func testTheTitleIsTrimmedAndWithoutOneTheSongIsCalledQuestoBrano() {
        let spaced = CurrentSong(songKey: "k", title: "  Africa \n")
        XCTAssertEqual(VoiceDecision.like(wanted: true, current: spaced, isLiked: false).outcome, .liked(title: "Africa"))
        let nameless = CurrentSong(songKey: "k", title: "   ")
        XCTAssertEqual(VoiceDecision.like(wanted: true, current: nameless, isLiked: false).outcome, .liked(title: "questo brano"))
    }
}

final class VoiceOutcomeTests: XCTestCase {
    func testWhatSiriSaysIsShortAndItalian() {
        XCTAssertEqual(VoiceOutcome.liked(title: "Africa").spoken, "Fatto: ti piace «Africa».")
        XCTAssertEqual(VoiceOutcome.alreadyLiked(title: "Africa").spoken, "Ti piace già «Africa».")
        XCTAssertEqual(VoiceOutcome.unliked(title: "Africa").spoken, "Fatto: «Africa» non ti piace più.")
        XCTAssertEqual(VoiceOutcome.wasNotLiked(title: "Africa").spoken, "«Africa» non era tra i brani che ti piacciono.")
        XCTAssertEqual(VoiceOutcome.nothingPlaying.spoken, "Non c'è nessun brano in riproduzione.")
    }

    func testTheLoopIsSaidInItsThreeStates() {
        XCTAssertEqual(VoiceOutcome.repeatSet(.one).spoken, "Ripetizione: questo brano.")
        XCTAssertEqual(VoiceOutcome.repeatSet(.all).spoken, "Ripetizione: tutta la coda.")
        XCTAssertEqual(VoiceOutcome.repeatSet(.off).spoken, "Ripetizione: spenta.")
    }

    func testTheCommandsHaveTheNameTheListOfTheSettingsShows() {
        XCTAssertEqual(VoiceCommand.like.logName, "Siri: Mi piace")
        XCTAssertEqual(VoiceCommand.unlike.logName, "Siri: Non mi piace più")
        XCTAssertEqual(VoiceCommand.repeatMode(.one).logName, "Siri: Ripeti: questo brano")
        XCTAssertEqual(VoiceCommand.repeatMode(.all).logName, "Siri: Ripeti: tutto")
        XCTAssertEqual(VoiceCommand.repeatMode(.off).logName, "Siri: Ripeti: no")
    }
}

/// The voice acts on the player and the likes the app uses, and is written down in the list of the commands received.
@MainActor
final class VoiceCommandsPlayerTests: XCTestCase {
    private var dir: URL!
    private var defaults: UserDefaults!
    private var suite = ""

    override func setUpWithError() throws {
        continueAfterFailure = false
        dir = try TestSupport.tempDir("voice")
        suite = "mondrop.test.voice.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    private func make(songs: Int = 2) -> (player: LocalAudioPlayer, likes: LikesStore, log: RemoteCommandLog) {
        let offline = OfflineStore(root: dir.appendingPathComponent("offline"))
        let likes = LikesStore(
            directory: dir.appendingPathComponent("likes"), transport: FakeLikesTransport(), currentUser: { "mike" },
            clock: SleepLog().clock, autoFlush: false
        )
        let log = RemoteCommandLog(defaults: defaults, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        let player = LocalAudioPlayer(
            store: offline, api: FakeAPI(),
            recorder: PlayRecorder(queue: EventQueue(directory: dir.appendingPathComponent("events")), store: offline, uploader: nil, journal: MemoryJournal()),
            snapshots: QueueSnapshotStore(directory: dir, defaults: defaults, positionKey: "position"),
            lyricsLoader: LyricsLoader(transport: FakeLyricsTransport([.success(nil)]), directory: dir.appendingPathComponent("lyrics")),
            repeatStore: MemoryRepeatModeStore(), likes: likes, commandLog: log
        )
        if songs > 0 {
            player.setQueue((0..<songs).map { QueueItem(songKey: "artist::song \($0)", title: "Song \($0)", artist: "Artist") }, startAt: 0, autoplay: false)
        }
        return (player, likes, log)
    }

    func testALikeByVoiceLikesTheSongThatPlaysAndIsWrittenDown() {
        let rig = make()
        XCTAssertEqual(rig.player.perform(voice: .like), .liked(title: "Song 0"))
        XCTAssertTrue(rig.likes.isLiked("artist::song 0"))
        XCTAssertFalse(rig.likes.isLiked("artist::song 1"))
        XCTAssertEqual(rig.log.entries.first?.name, "Siri: Mi piace")
    }

    func testTheSameWordsTwiceNeverTakeTheLikeBack() {
        let rig = make()
        rig.player.perform(voice: .like)
        XCTAssertEqual(rig.player.perform(voice: .like), .alreadyLiked(title: "Song 0"))
        XCTAssertTrue(rig.likes.isLiked("artist::song 0"), "the voice is not the button of the car: «mi piace» twice stays a like")
        XCTAssertEqual(rig.likes.pendingCount, 1, "and the server is told once")
    }

    func testAnUnlikeByVoiceTakesTheLikeBack() {
        let rig = make()
        rig.likes.setLiked(true, songKey: "artist::song 0")
        XCTAssertEqual(rig.player.perform(voice: .unlike), .unliked(title: "Song 0"))
        XCTAssertFalse(rig.likes.isLiked("artist::song 0"))
        XCTAssertEqual(rig.log.entries.first?.name, "Siri: Non mi piace più")
        XCTAssertEqual(rig.player.perform(voice: .unlike), .wasNotLiked(title: "Song 0"))
    }

    func testWithNothingQueuedTheVoiceHasNothingToActOnAndIsStillWrittenDown() {
        let rig = make(songs: 0)
        XCTAssertEqual(rig.player.perform(voice: .like), .nothingPlaying)
        XCTAssertEqual(rig.likes.pendingCount, 0)
        XCTAssertEqual(rig.log.entries.first?.name, "Siri: Mi piace", "it arrived: the Settings say so even when there was nothing to do")
    }

    func testTheLoopByVoiceIsTheSameLoopAsTheButtonAndTheCars() {
        let rig = make()
        XCTAssertEqual(rig.player.perform(voice: .repeatMode(.one)), .repeatSet(.one))
        XCTAssertEqual(rig.player.repeatMode, .one)
        XCTAssertEqual(rig.log.entries.first?.name, "Siri: Ripeti: questo brano")
        rig.player.perform(voice: .repeatMode(.off))
        XCTAssertEqual(rig.player.repeatMode, .off)
        XCTAssertEqual(rig.log.entries.map(\.name), ["Siri: Ripeti: no", "Siri: Ripeti: questo brano"])
    }

    func testTheVoiceAndTheCarShareOneList() {
        let rig = make()
        rig.player.perform(.next)
        rig.player.perform(voice: .like)
        rig.player.perform(.repeatMode(.all))
        XCTAssertEqual(rig.log.entries.map(\.name), ["Ripeti: tutto", "Siri: Mi piace", "Avanti"])
    }

    func testTheGlueOfTheIntentsSaysWhatSiriSays() {
        let rig = make()
        XCTAssertEqual(VoiceActions.run(.like, on: rig.player), "Fatto: ti piace «Song 0».")
        XCTAssertEqual(VoiceActions.run(.repeatMode(.all), on: rig.player), "Ripetizione: tutta la coda.")
        XCTAssertEqual(VoiceActions.run(.unlike, on: rig.player), "Fatto: «Song 0» non ti piace più.")
    }
}
