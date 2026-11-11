import XCTest
@testable import Mondrop

/// The sync of the playlist that is PLAYING (Michele, 11 November, trying build 15: «Il sync deve girare solo per playlist che sto suonando. Non di tutti in
/// assoluto.»; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U2): when a queue starts from a playlist, or the playing queue goes to
/// another one, SoundReel is asked to prepare it and the songs that are missing from the phone are downloaded in the background — after a question when they
/// are more than the user's limit. Nothing is downloaded for a playlist that does not play.
@MainActor
final class PlayingPlaylistSyncTests: XCTestCase {
    private let mb = 1_000_000
    private let gb = 1_000_000_000

    /// A clock whose `sleep` waits until the test lets it go (or the task is cancelled): the test can do something while a sync waits between two readings.
    private final class ManualClock: @unchecked Sendable {
        private let lock = NSLock()
        private var waiters: [Int: CheckedContinuation<Void, Error>] = [:]
        private var next = 0
        private var _sleeps = 0

        var sleeps: Int { lock.withLock { _sleeps } }
        var isWaiting: Bool { lock.withLock { !waiters.isEmpty } }

        var clock: PreparationClock {
            PreparationClock(sleep: { [self] _ in try await sleep() }, now: { Date(timeIntervalSince1970: 1_000_000) })
        }

        private func sleep() async throws {
            let id = lock.withLock { () -> Int in next += 1; _sleeps += 1; return next }
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    lock.withLock { waiters[id] = continuation }
                    if Task.isCancelled, let mine = lock.withLock({ waiters.removeValue(forKey: id) }) { mine.resume(throwing: CancellationError()) }
                }
            } onCancel: {
                let mine = lock.withLock { waiters.removeValue(forKey: id) }
                mine?.resume(throwing: CancellationError())
            }
        }

        /// The oldest sleeper wakes up.
        func release() {
            let first = lock.withLock { () -> CheckedContinuation<Void, Error>? in
                guard let id = waiters.keys.min() else { return nil }
                return waiters.removeValue(forKey: id)
            }
            first?.resume()
        }
    }

    private final class Box: @unchecked Sendable {
        var limit: SyncWarnLimit = .gb2
        var hasKey = true
        var started = 0
    }

    private struct Rig {
        let sync: PlayingPlaylistSync
        let engineRig: EngineRig
        let api: FakeAPI
        let box: Box
        var engine: SyncEngine { engineRig.engine }
    }

    private func make(
        limit: SyncWarnLimit = .gb2, hasKey: Bool = true, declines: SyncDeclines = SyncDeclines(), clock: PreparationClock? = nil
    ) throws -> Rig {
        let engineRig = try EngineRig()
        let api = FakeAPI()
        let box = Box()
        box.limit = limit
        box.hasKey = hasKey
        let sync = PlayingPlaylistSync(
            api: api, engine: engineRig.engine,
            limit: { box.limit }, hasKey: { box.hasKey },
            declines: declines, clock: clock ?? FakeClock().clock, pollInterval: 5, pollTimeout: 600,
            onSyncStarted: { box.started += 1 }
        )
        return Rig(sync: sync, engineRig: engineRig, api: api, box: box)
    }

    private func ctx(_ playing: Bool, _ playlist: String?) -> PlaybackContext { PlaybackContext(isPlaying: playing, playlistId: playlist) }

    /// Playlist `id` with these tracks (ready, `size` bytes each by default).
    private func script(_ api: FakeAPI, _ id: String, _ keys: [String], size: Int = 100, state: String = "ready") {
        api.scriptPrepare(id, [TestSupport.manifest(id, keys.map { TestSupport.track($0, state: state, bytes: size) })])
    }

    private func queued(_ rig: Rig) -> Set<String> { Set(rig.engine.progress.keys) }

    private func prepares(_ rig: Rig) -> [String] { rig.api.calls.filter { $0.hasPrefix("prepare:") } }

    /// Waits until the sync has put its question on screen.
    private func untilAsking(_ sync: PlayingPlaylistSync) async throws -> SyncSizeQuestion {
        for _ in 0..<1_000 {
            if case .asking(let question) = sync.phase { return question }
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        XCTFail("the sync never asked")
        throw CancellationError()
    }

    private func until(_ what: String, _ condition: () -> Bool) async throws {
        for _ in 0..<1_000 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        XCTFail("never happened: \(what)")
        throw CancellationError()
    }

    // MARK: what starts a sync

    func testAQueueThatStartsFromAPlaylistPreparesItAndDownloadsItsMissingSongs() async throws {
        let r = try make()
        script(r.api, "a", ["a1", "a2", "a3"])
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertEqual(r.api.calls, ["prepare:a:retry=false"], "it prepares the playlist, the way the «Sync» inside a playlist does, and asks nothing else")
        XCTAssertEqual(queued(r), ["a1", "a2", "a3"])
        XCTAssertEqual(r.box.started, 1)
    }

    func testTheSongsAlreadyOnThePhoneAreNotDownloadedAgain() async throws {
        let r = try make()
        script(r.api, "a", ["on", "off"])
        try r.engineRig.installLocal("on", version: "100-1", bytes: 100)
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertEqual(queued(r), ["off"])
    }

    func testAtTheFirstAccessNothingIsAskedOfTheServerAndNothingDownloads() async throws {
        // «Il sync deve girare solo per playlist che sto suonando. Non di tutti in assoluto.»: the app opens, the player has nothing or a queue brought back
        // paused, and the playlists are not synced — not one, not all of them
        let r = try make()
        script(r.api, "a", ["a1", "a2"])
        script(r.api, "b", ["b1"])
        r.api.setPlaylists([MondropPlaylist(id: "a", name: "A", songCount: 2), MondropPlaylist(id: "b", name: "B", songCount: 1)])
        r.sync.playbackChanged(ctx(false, nil))                  // a phone with no queue
        await r.sync.settledOrFail()
        XCTAssertTrue(r.api.calls.isEmpty, "not even the list of the playlists: this object asks the server nothing by itself")
        XCTAssertTrue(queued(r).isEmpty)
        XCTAssertTrue(r.sync.runningPlaylists.isEmpty)
        XCTAssertEqual(r.sync.phase, .idle)

        r.sync.playbackChanged(ctx(false, "a"))                  // a phone whose queue came back paused
        await r.sync.settledOrFail()
        XCTAssertTrue(r.api.calls.isEmpty)
        XCTAssertTrue(queued(r).isEmpty)
    }

    func testAQueueNotBornFromAPlaylistDownloadsNothing() async throws {
        let r = try make()
        script(r.api, "a", ["a1"])
        r.sync.playbackChanged(ctx(true, nil))      // a song of Cerca, a library choice, the phone
        await r.sync.settledOrFail()
        XCTAssertTrue(r.api.calls.isEmpty)
        XCTAssertTrue(queued(r).isEmpty)
        XCTAssertTrue(r.sync.runningPlaylists.isEmpty)
    }

    func testAQueueBroughtBackPausedAtLaunchDownloadsNothingUntilTheUserPlays() async throws {
        let r = try make()
        script(r.api, "a", ["a1"])
        r.sync.playbackChanged(ctx(false, "a"))
        r.sync.playbackChanged(ctx(false, "a"))
        await r.sync.settledOrFail()
        XCTAssertTrue(r.api.calls.isEmpty, "restored and paused is not playing")
        XCTAssertTrue(queued(r).isEmpty)

        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertEqual(prepares(r), ["prepare:a:retry=false"])
        XCTAssertEqual(queued(r), ["a1"])
    }

    func testTheSyncNeverMakesPlaybackWait() async throws {
        let r = try make()
        script(r.api, "a", ["a1"])
        r.sync.playbackChanged(ctx(true, "a"))
        XCTAssertTrue(r.api.calls.isEmpty, "back from the call before the server was asked anything: the sync runs on its own")
        XCTAssertEqual(r.sync.runningPlaylists, ["a"])
        await r.sync.settledOrFail()
        XCTAssertFalse(r.api.calls.isEmpty)
        XCTAssertTrue(r.sync.runningPlaylists.isEmpty)
    }

    func testWithNoKeyNothingHappens() async throws {
        let r = try make(hasKey: false)
        script(r.api, "a", ["a1"])
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertTrue(r.api.calls.isEmpty)
        XCTAssertTrue(queued(r).isEmpty)
    }

    func testTheStartHookIsCalledOncePerSyncThatStarts() async throws {
        // the hook refreshes what the share sheet offers; asking iOS for notifications is for the «Sync» the user presses inside a playlist, never for this
        let r = try make()
        script(r.api, "a", ["a1"])
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertEqual(r.box.started, 1, "one call of the hook per sync that starts")
    }

    // MARK: the same playlist twice, a switch

    func testThePlayerSayingTheSameThingTwiceSyncsOnce() async throws {
        let r = try make()
        script(r.api, "a", ["a1"])
        r.sync.playbackChanged(ctx(true, "a"))
        r.sync.playbackChanged(ctx(true, "a"))
        r.sync.playbackChanged(ctx(false, "a"))
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertEqual(prepares(r).count, 1)
    }

    func testOnceItsSyncHasFinishedTheGapsBetweenSongsDoNotSyncThePlaylistAgain() async throws {
        let r = try make()
        script(r.api, "a", ["a1"])
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()                              // the sync ended well
        r.sync.playbackChanged(ctx(false, "a"))             // the gap between two songs…
        r.sync.playbackChanged(ctx(true, "a"))              // …and the next one starts
        await r.sync.settledOrFail()
        XCTAssertEqual(prepares(r).count, 1, "a sync that went well is not asked for again at every song")
    }

    func testAskedTwiceWhileItsSyncRunsItStartsOneRun() async throws {
        let manual = ManualClock()
        let r = try make(clock: manual.clock)
        r.api.scriptPrepare("a", [TestSupport.manifest("a", [TestSupport.track("a1"), TestSupport.track("a2", state: "preparing")])])
        r.api.scriptManifests("a", [.success(TestSupport.manifest("a", [TestSupport.track("a1"), TestSupport.track("a2")]))])
        r.sync.startSync(of: "a")
        try await until("the first run waits for the server") { manual.isWaiting }
        r.sync.startSync(of: "a")
        r.sync.startSync(of: "a")
        XCTAssertEqual(prepares(r).count, 1, "the sync of «a» is already running")
        manual.release()
        await r.sync.settledOrFail()
        XCTAssertEqual(prepares(r).count, 1)
        XCTAssertEqual(queued(r), ["a1", "a2"])
    }

    func testSwitchingToAnotherPlaylistStopsTheReadingsOfTheFirstAndSyncsTheNewOne() async throws {
        let manual = ManualClock()
        let r = try make(clock: manual.clock)
        r.api.scriptPrepare("a", [TestSupport.manifest("a", [TestSupport.track("a1"), TestSupport.track("a2", state: "preparing")])])
        r.api.scriptManifests("a", [.success(TestSupport.manifest("a", [TestSupport.track("a1"), TestSupport.track("a2")]))])
        script(r.api, "b", ["b1"])

        r.sync.playbackChanged(ctx(true, "a"))
        try await until("«a» waits for the server") { manual.isWaiting }
        XCTAssertEqual(queued(r), ["a1"])

        r.sync.playbackChanged(ctx(true, "b"))
        await r.sync.settledOrFail()
        XCTAssertFalse(r.api.calls.contains("manifest:a"), "«a» is no longer the playlist that plays: it is not read again")
        XCTAssertEqual(queued(r), ["a1", "b1"], "a2 never came: nothing is downloaded for a playlist that does not play")
        XCTAssertEqual(prepares(r), ["prepare:a:retry=false", "prepare:b:retry=false"])
    }

    func testAQueueFromCercaAfterAPlaylistStopsItsSyncToo() async throws {
        let manual = ManualClock()
        let r = try make(clock: manual.clock)
        r.api.scriptPrepare("a", [TestSupport.manifest("a", [TestSupport.track("a1"), TestSupport.track("a2", state: "preparing")])])
        r.api.scriptManifests("a", [.success(TestSupport.manifest("a", [TestSupport.track("a1"), TestSupport.track("a2")]))])
        r.sync.playbackChanged(ctx(true, "a"))
        try await until("«a» waits for the server") { manual.isWaiting }
        r.sync.playbackChanged(ctx(true, nil))
        await r.sync.settledOrFail()
        XCTAssertEqual(queued(r), ["a1"])
        XCTAssertFalse(r.api.calls.contains("manifest:a"))
    }

    func testComingBackWhileTheOldSyncIsStillUnwindingKeepsTheNewRun() async throws {
        let manual = ManualClock()
        let r = try make(clock: manual.clock)
        r.api.scriptPrepare("a", [TestSupport.manifest("a", [TestSupport.track("a1"), TestSupport.track("a2", state: "preparing")])])
        r.api.scriptManifests("a", [.success(TestSupport.manifest("a", [TestSupport.track("a1"), TestSupport.track("a2")]))])
        r.sync.playbackChanged(ctx(true, "a"))
        try await until("the first sync of «a» waits for the server") { manual.isWaiting }

        r.sync.playbackChanged(ctx(true, nil))      // away from «a»: its sync is told to stop…
        r.sync.playbackChanged(ctx(true, "a"))      // …and the user is back before it has finished stopping
        try await until("the second sync of «a» waits for the server") { manual.isWaiting }
        XCTAssertEqual(r.sync.runningPlaylists, ["a"], "the end of the old sync does not take the new one away")
        r.sync.startSync(of: "a")
        XCTAssertEqual(prepares(r).count, 2, "the second sync is the one that runs: nothing starts a third")

        manual.release()
        await r.sync.settledOrFail()
        XCTAssertEqual(queued(r), ["a1", "a2"])
    }

    /// An API whose `prepare` waits until the test lets it answer, and answers even if the task was cancelled meanwhile (the HTTP answer can arrive after the user moved on).
    private final class SlowAPI: MondropAPIProtocol, @unchecked Sendable {
        let manifest: OfflineManifest
        private let lock = NSLock()
        private var waiting: CheckedContinuation<Void, Never>?
        init(_ manifest: OfflineManifest) { self.manifest = manifest }
        var isWaiting: Bool { lock.withLock { waiting != nil } }
        func release() {
            let mine = lock.withLock { () -> CheckedContinuation<Void, Never>? in defer { waiting = nil }; return waiting }
            mine?.resume()
        }
        func prepare(playlistId: String, retryFailed: Bool) async throws -> OfflineManifest {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in lock.withLock { waiting = continuation } }
            return manifest
        }
        func listPlaylists() async throws -> [MondropPlaylist] { [] }
        func offlineManifest(playlistId: String) async throws -> OfflineManifest { manifest }
        func net() async throws -> NetInfo { throw MondropAPIError.http(503, "down") }
        func track(songKey: String) async throws -> OfflineTrack { throw MondropAPIError.http(503, "down") }
        func requestDownload(songKey: String, priority: DownloadPriority) async throws -> DownloadAck { throw MondropAPIError.http(503, "down") }
        func setSource(songKey: String, youtubeUrl: String) async throws { throw MondropAPIError.http(503, "down") }
    }

    func testAnAnswerFromTheServerThatArrivesAfterTheUserMovedOnAsksNothingAndQueuesNothing() async throws {
        let engineRig = try EngineRig()
        let slow = SlowAPI(TestSupport.manifest("a", ["a1", "a2", "a3", "a4"].map { TestSupport.track($0, bytes: 1 * gb) }))
        let sync = PlayingPlaylistSync(api: slow, engine: engineRig.engine, limit: { .gb2 }, hasKey: { true }, clock: FakeClock().clock)
        sync.playbackChanged(ctx(true, "a"))
        try await until("the server is asked to prepare «a»") { slow.isWaiting }

        sync.playbackChanged(ctx(true, nil))      // the user went on to a song of Cerca
        slow.release()                            // and now the server answers: 4 GB, over the limit
        await sync.settledOrFail()
        XCTAssertEqual(sync.phase, .idle, "a playlist that no longer plays asks nothing")
        XCTAssertTrue(engineRig.engine.progress.isEmpty, "and nothing is downloaded for it")
    }

    func testComingBackToAPlaylistSyncsItAgainAndPicksWhatWasMissing() async throws {
        let r = try make()
        script(r.api, "a", ["a1"])
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        script(r.api, "a", ["a1", "a2"])
        r.sync.playbackChanged(ctx(true, nil))
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertEqual(prepares(r).count, 2)
        XCTAssertEqual(queued(r), ["a1", "a2"])
    }

    // MARK: songs the server is still preparing

    func testSongsThatTurnReadyWhileItPlaysAreDownloadedAsTheyAre() async throws {
        let r = try make()
        r.api.scriptPrepare("a", [TestSupport.manifest("a", [TestSupport.track("a1"), TestSupport.track("a2", state: "preparing"), TestSupport.track("a3", state: "preparing")])])
        r.api.scriptManifests("a", [
            .success(TestSupport.manifest("a", [TestSupport.track("a1"), TestSupport.track("a2"), TestSupport.track("a3", state: "preparing")])),
            .success(TestSupport.manifest("a", [TestSupport.track("a1"), TestSupport.track("a2"), TestSupport.track("a3")])),
        ])
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertEqual(queued(r), ["a1", "a2", "a3"])
        XCTAssertEqual(r.api.calls.filter { $0 == "manifest:a" }.count, 2)
    }

    // MARK: over the limit it asks

    private func setUpBig(_ api: FakeAPI) {
        script(api, "a", ["a1", "a2", "a3", "a4"], size: 1 * gb)     // 4 GB over a 2 GB limit
    }

    func testOverTheLimitItAsksBeforeDownloadingAnythingAndAllDownloadsEverything() async throws {
        let r = try make()
        setUpBig(r.api)
        r.sync.playbackChanged(ctx(true, "a"))
        let question = try await untilAsking(r.sync)
        XCTAssertEqual(question.songs, 4)
        XCTAssertEqual(question.bytes, 4 * gb)
        XCTAssertEqual(question.limit, .gb2)
        XCTAssertEqual(question.playlistName, "Playlist a")
        XCTAssertTrue(queued(r).isEmpty, "nothing is downloaded while the question is open")
        XCTAssertTrue(r.engineRig.transport.startedKeys.isEmpty)

        r.sync.answer(.all)
        await r.sync.settledOrFail()
        XCTAssertEqual(queued(r), ["a1", "a2", "a3", "a4"])
        XCTAssertEqual(r.sync.phase, .idle)
    }

    func testLimitDownloadsTheFirstSongsOfThePlaylistUntilTheLimitAndTheRestStaysOnline() async throws {
        let r = try make()
        r.api.scriptPrepare("a", [TestSupport.manifest("a", [
            TestSupport.track("a1", bytes: 1 * gb), TestSupport.track("a2", bytes: 1 * gb),
            TestSupport.track("a3", bytes: 1 * gb), TestSupport.track("a4", state: "preparing", bytes: nil),
        ])])
        r.api.scriptManifests("a", [.success(TestSupport.manifest("a", [
            TestSupport.track("a1", bytes: 1 * gb), TestSupport.track("a2", bytes: 1 * gb),
            TestSupport.track("a3", bytes: 1 * gb), TestSupport.track("a4", bytes: 1 * gb),
        ]))])
        r.sync.playbackChanged(ctx(true, "a"))
        let question = try await untilAsking(r.sync)
        XCTAssertEqual(question.songs, 3, "the song the server is still preparing is not counted")
        r.sync.answer(.limit)
        await r.sync.settledOrFail()
        XCTAssertEqual(queued(r), ["a1", "a2"], "the 2 GB of the first songs of the playlist")
        XCTAssertFalse(r.api.calls.contains("manifest:a"), "after «Limita» nothing more is read for that playlist: a4 stays online as well")
    }

    func testCancelDownloadsNothingAndTheQuestionIsNotAskedAgainForThatPlaylistUntilTheAppReopens() async throws {
        let declines = SyncDeclines()
        let r = try make(declines: declines)
        setUpBig(r.api)
        r.sync.playbackChanged(ctx(true, "a"))
        _ = try await untilAsking(r.sync)
        r.sync.answer(.cancel)
        await r.sync.settledOrFail()
        XCTAssertTrue(queued(r).isEmpty, "«Annulla» downloads nothing")
        XCTAssertEqual(r.sync.phase, .idle)
        XCTAssertTrue(declines.isDeclined("a"))

        // the user plays something else and comes back to the playlist: no question, no server call, nothing downloaded
        r.sync.playbackChanged(ctx(true, nil))
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertEqual(prepares(r).count, 1, "not even the server is asked again")
        XCTAssertEqual(r.sync.phase, .idle)
        XCTAssertTrue(queued(r).isEmpty)

        // the app opens again: a new coordinator with a memory of its own asks again
        let reopened = PlayingPlaylistSync(
            api: r.api, engine: r.engine, limit: { .gb2 }, hasKey: { true }, declines: SyncDeclines(), clock: FakeClock().clock
        )
        reopened.playbackChanged(ctx(true, "a"))
        let again = try await untilAsking(reopened)
        XCTAssertEqual(again.songs, 4)
        reopened.answer(.cancel)
        await reopened.settledOrFail()
    }

    func testAPlaylistDeclinedBeforeIsNotSyncedByACoordinatorThatSharesTheMemory() async throws {
        let declines = SyncDeclines()
        declines.decline("a")
        let r = try make(declines: declines)
        setUpBig(r.api)
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertTrue(r.api.calls.isEmpty)
        XCTAssertEqual(r.sync.phase, .idle)
    }

    func testCancelOfOnePlaylistDoesNotSilenceTheOthers() async throws {
        let r = try make()
        setUpBig(r.api)
        script(r.api, "b", ["b1", "b2", "b3", "b4"], size: 1 * gb)
        r.sync.playbackChanged(ctx(true, "a"))
        _ = try await untilAsking(r.sync)
        r.sync.answer(.cancel)
        await r.sync.settledOrFail()
        r.sync.playbackChanged(ctx(true, "b"))
        let question = try await untilAsking(r.sync)
        XCTAssertEqual(question.playlistName, "Playlist b")
        r.sync.answer(.all)
        await r.sync.settledOrFail()
        XCTAssertEqual(queued(r), ["b1", "b2", "b3", "b4"])
    }

    func testLeavingForAnotherPlaylistWhileTheQuestionIsOpenWithdrawsItAndItIsAskedAgainOnTheWayBack() async throws {
        let r = try make()
        setUpBig(r.api)
        script(r.api, "b", ["b1"])
        r.sync.playbackChanged(ctx(true, "a"))
        _ = try await untilAsking(r.sync)

        r.sync.playbackChanged(ctx(true, "b"))
        XCTAssertEqual(r.sync.phase, .idle, "the question of a playlist that no longer plays goes away")
        await r.sync.settledOrFail()
        XCTAssertEqual(queued(r), ["b1"], "nothing was downloaded for «a»")

        // «Annulla» was never said: back on «a» it is asked
        r.sync.playbackChanged(ctx(true, "a"))
        let again = try await untilAsking(r.sync)
        XCTAssertEqual(again.songs, 4)
        r.sync.answer(.cancel)
        await r.sync.settledOrFail()
    }

    func testAnAnswerWhenNothingIsAskedIsIgnoredAndNotKeptForTheNextQuestion() async throws {
        let r = try make()
        r.sync.answer(.all)
        setUpBig(r.api)
        r.sync.playbackChanged(ctx(true, "a"))
        _ = try await untilAsking(r.sync)
        r.sync.answer(.cancel)
        r.sync.answer(.all)      // too late
        await r.sync.settledOrFail()
        XCTAssertTrue(queued(r).isEmpty, "the first answer counts, and the one given before the question did not")
    }

    func testUnderTheLimitItStartsWithoutAsking() async throws {
        let r = try make()
        script(r.api, "a", ["a1", "a2", "a3"], size: 500 * mb)    // 1.5 GB
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertEqual(queued(r), ["a1", "a2", "a3"])
        XCTAssertEqual(r.sync.phase, .idle)
    }

    func testWithTheLimitSetToNeverItNeverAsks() async throws {
        let r = try make(limit: .never)
        script(r.api, "a", ["a1", "a2"], size: 40 * gb)
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertEqual(queued(r), ["a1", "a2"])
    }

    func testTheSizeOfWhatIsAlreadyOnThePhoneDoesNotMakeTheQuestionAppear() async throws {
        let r = try make()
        r.api.scriptPrepare("a", [TestSupport.manifest("a", [
            TestSupport.track("on1", bytes: 1_000), TestSupport.track("on2", bytes: 1_000), TestSupport.track("off", bytes: 1 * gb),
        ])])
        try r.engineRig.installLocal("on1", version: "100-1", bytes: 1_000)
        try r.engineRig.installLocal("on2", version: "100-1", bytes: 1_000)
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertEqual(queued(r), ["off"], "1 GB to download, under the limit")
    }

    func testASongTheUserDeletedFromThePhoneIsNotBroughtBack() async throws {
        let r = try make()
        script(r.api, "a", ["gone", "kept"])
        r.engineRig.store.addSkipped(["gone"])
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertEqual(queued(r), ["kept"])
    }

    // MARK: a sync that did not get through

    func testASyncThatFailedIsTriedAgainAtTheNextSongNotBefore() async throws {
        let r = try make()
        r.api.failPrepare(MondropAPIError.http(503, "down"))
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertEqual(prepares(r).count, 1)
        XCTAssertTrue(queued(r).isEmpty)
        XCTAssertTrue(r.sync.runningPlaylists.isEmpty)

        r.sync.playbackChanged(ctx(false, "a"))          // the gap between two songs: nothing yet
        await r.sync.settledOrFail()
        XCTAssertEqual(prepares(r).count, 1)

        r.api.failPrepare(nil)
        script(r.api, "a", ["a1"])
        r.sync.playbackChanged(ctx(true, "a"))           // the next song starts: the server is asked again
        await r.sync.settledOrFail()
        XCTAssertEqual(prepares(r).count, 2)
        XCTAssertEqual(queued(r), ["a1"])
    }

    // MARK: the cellular rule and the rest stay as they were

    func testTheSyncNeverAsksWhereThePhoneIs() async throws {
        let r = try make()
        script(r.api, "a", ["a1"])
        r.sync.playbackChanged(ctx(true, "a"))
        await r.sync.settledOrFail()
        XCTAssertFalse(r.api.calls.contains("net"), "rule P: the network the phone is on decides nothing")
    }
}
