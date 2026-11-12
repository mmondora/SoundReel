import XCTest
@testable import Mondrop

/// «Inoltre su una playlist voglio anche il bottone 'scarica tutta'» (Michele, 11 November, after build 18; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md §12,
/// U20): the sync of ONE playlist that the person asks for on its page — SoundReel prepares it, what is missing from the phone is queued, a question comes over the limit of the
/// Settings, and the end is announced because the person asked for it.
@MainActor
final class PlaylistDownloadAllTests: XCTestCase {
    private let gb = 1_000_000_000

    private final class Box: @unchecked Sendable {
        var limit: SyncWarnLimit = .gb2
        var started = 0
        var finished = 0
    }

    private struct Rig {
        let all: PlaylistDownloadAll
        let api: FakeAPI
        let engineRig: EngineRig
        let clock: FakeClock
        let questions: SizeQuestionPresenter
        let box: Box
        var engine: SyncEngine { engineRig.engine }
        var store: OfflineStore { engineRig.store }
    }

    private func rig(limit: SyncWarnLimit = .gb2) throws -> Rig {
        let api = FakeAPI()
        let engineRig = try EngineRig(maxParallel: 2)
        let dir = engineRig.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let clock = FakeClock()
        let questions = SizeQuestionPresenter()
        let box = Box()
        box.limit = limit
        let all = PlaylistDownloadAll(
            playlist: MondropPlaylist(id: "pl1", name: "Road trip", songCount: 3),
            api: api, engine: engineRig.engine, limit: { box.limit }, questions: questions,
            clock: clock.clock, pollInterval: 5, pollTimeout: 600,
            onSyncStarted: { box.started += 1 }, onFinished: { box.finished += 1 }
        )
        return Rig(all: all, api: api, engineRig: engineRig, clock: clock, questions: questions, box: box)
    }

    private func m(_ tracks: [OfflineTrack]) -> OfflineManifest { TestSupport.manifest("pl1", tracks) }
    private func queued(_ r: Rig) -> Set<String> { Set(r.engine.progress.keys) }
    private func preparing(_ key: String) -> OfflineTrack { TestSupport.track(key, state: "preparing") }

    private func untilAsking(_ presenter: SizeQuestionPresenter) async {
        for _ in 0..<1_000 where presenter.question == nil { try? await Task.sleep(nanoseconds: 2_000_000) }
    }

    // MARK: the download

    func testItPreparesThePlaylistDownloadsWhatIsMissingAndSaysWhenItIsDone() async throws {
        let r = try rig()
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a"), TestSupport.track("b"), TestSupport.track("c")])])
        XCTAssertFalse(r.all.working)
        r.all.start()
        XCTAssertTrue(r.all.working, "at once: the button says it is at work before anything answers")
        await r.all.settled()
        XCTAssertEqual(r.api.calls.first, "prepare:pl1:retry=false")
        XCTAssertEqual(queued(r), ["a", "b", "c"])
        XCTAssertFalse(r.all.working)
        XCTAssertEqual(r.box.started, 1, "the right moment to ask iOS for notifications: the person has just asked for a sync")
        XCTAssertEqual(r.box.finished, 1, "the page reads the list again")
        XCTAssertNil(r.all.errorText)
    }

    func testWhatIsAskedForIsAnnouncedWhenItEndsBecauseThePersonAskedForIt() async throws {
        let r = try rig()
        var announced: [SyncBatchSummary] = []
        r.engine.onBatchFinished = { announced.append($0) }
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a"), TestSupport.track("b")])])
        r.all.start()
        await r.all.settled()
        for job in r.engineRig.transport.started { try r.engineRig.finish(job.info) }
        XCTAssertEqual(announced, [SyncBatchSummary(downloaded: 2, failed: 0)], "«Sync finito»: not the quiet download of the playlist that plays")
    }

    func testAPressWhileItIsAtWorkDoesNothing() async throws {
        let r = try rig()
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a")])])
        r.all.start()
        r.all.start()
        await r.all.settled()
        XCTAssertEqual(r.api.calls.filter { $0.hasPrefix("prepare:") }.count, 1)
        XCTAssertEqual(r.box.finished, 1)
    }

    func testItCanBePressedAgainAfterItEnded() async throws {
        let r = try rig()
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a")])])
        r.all.start()
        await r.all.settled()
        r.all.start()
        await r.all.settled()
        XCTAssertEqual(r.api.calls.filter { $0.hasPrefix("prepare:") }.count, 2)
        XCTAssertEqual(r.box.finished, 2)
    }

    func testWhileTheServerPreparesItWaitsAndDownloadsEachSongAsItTurnsReady() async throws {
        let r = try rig()
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a"), preparing("b")])])
        r.api.scriptManifests("pl1", [.success(m([TestSupport.track("a"), TestSupport.track("b")]))])
        r.all.start()
        await r.all.settled()
        XCTAssertEqual(r.clock.sleeps, [5], "it read the list again once, five seconds later")
        XCTAssertEqual(queued(r), ["a", "b"])
    }

    func testWhatThePersonTookOffThePhoneOnPurposeStaysOff() async throws {
        let r = try rig()
        r.store.addSkipped(["b"])
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a"), TestSupport.track("b")])])
        r.all.start()
        await r.all.settled()
        XCTAssertEqual(queued(r), ["a"], "«Riscarica» on the row of «b» brings it back, not this button")
    }

    func testWhenSoundReelDoesNotAnswerItSaysWhyAndTheButtonIsFreeAgain() async throws {
        let r = try rig()
        r.api.failPrepare(MondropAPIError.transport("offline"))
        r.all.start()
        await r.all.settled()
        XCTAssertEqual(r.all.errorText, "offline")
        XCTAssertFalse(r.all.working)
        XCTAssertEqual(r.box.finished, 1)
        r.api.failPrepare(nil)
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a")])])
        r.all.start()
        XCTAssertNil(r.all.errorText, "the old error goes as soon as the person presses again, not when the new download ends")
        await r.all.settled()
        XCTAssertNil(r.all.errorText, "a later download clears it")
        XCTAssertEqual(queued(r), ["a"])
    }

    // MARK: the question over the limit

    private func big(_ r: Rig) {
        r.api.scriptPrepare("pl1", [m((1...4).map { TestSupport.track("a\($0)", bytes: 1 * gb) })])      // 4 GB over a 2 GB limit
    }

    func testUnderTheLimitNothingIsAsked() async throws {
        let r = try rig()
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a", bytes: 100), TestSupport.track("b", bytes: 100)])])
        r.all.start()
        await r.all.settled()
        XCTAssertNil(r.questions.question)
        XCTAssertEqual(queued(r), ["a", "b"])
    }

    func testOverTheLimitItAsksBeforeDownloadingAnythingAndAllTakesEverything() async throws {
        let r = try rig()
        big(r)
        r.all.start()
        await untilAsking(r.questions)
        let question = try XCTUnwrap(r.questions.question)
        XCTAssertEqual(question.songs, 4)
        XCTAssertEqual(question.bytes, 4 * gb)
        XCTAssertEqual(question.playlistName, "Playlist pl1", "the name SoundReel gave the playlist in its answer")
        XCTAssertTrue(queued(r).isEmpty, "nothing is downloaded while the question is open")
        XCTAssertTrue(r.all.working)
        r.questions.answer(.all)
        await r.all.settled()
        XCTAssertEqual(queued(r), ["a1", "a2", "a3", "a4"])
        XCTAssertNil(r.questions.question)
    }

    func testLimitDownloadsTheFirstSongsUpToTheLimitAndTheRestStaysOnline() async throws {
        let r = try rig()
        big(r)
        r.all.start()
        await untilAsking(r.questions)
        r.questions.answer(.limit)
        await r.all.settled()
        XCTAssertEqual(queued(r), ["a1", "a2"], "the 2 GB of the first songs")
    }

    func testCancelDownloadsNothingAndAskingAgainIsPossible() async throws {
        let r = try rig()
        big(r)
        r.all.start()
        await untilAsking(r.questions)
        r.questions.answer(.cancel)
        await r.all.settled()
        XCTAssertTrue(queued(r).isEmpty)
        XCTAssertFalse(r.all.working)

        // the person presses again: «Annulla» is not remembered, it is a button and not a rule
        r.all.start()
        await untilAsking(r.questions)
        XCTAssertNotNil(r.questions.question, "asked again")
        r.questions.answer(.all)
        await r.all.settled()
        XCTAssertEqual(queued(r), ["a1", "a2", "a3", "a4"])
    }

    func testLeavingThePageWithTheQuestionOpenEndsTheDownloadWithoutDownloadingAnything() async throws {
        let r = try rig()
        big(r)
        r.all.start()
        await untilAsking(r.questions)
        r.questions.withdraw()
        await r.all.settled()
        XCTAssertTrue(queued(r).isEmpty)
        XCTAssertFalse(r.all.working)
    }
}
