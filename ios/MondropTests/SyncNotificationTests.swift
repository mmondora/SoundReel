import XCTest
@testable import Mondrop

/// «A sync finito, una notifica locale: Sync finito: N brani scaricati, M errori.» — when it fires, what it says, and
/// that it never gets in the way of the sync.
final class SyncBatchTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    private func batch(queued keys: [String]) -> SyncBatch {
        var b = SyncBatch()
        b.enqueue(keys, at: t0)
        return b
    }

    func testItIsFinishedWhenEverythingItQueuedHasSettled() {
        var b = batch(queued: ["a", "b", "c"])
        XCTAssertFalse(b.isFinished)
        b.markInstalled("a")
        b.markInstalled("b")
        XCTAssertFalse(b.isFinished, "c is still on its way")
        b.markFailed("c", message: "timeout")
        XCTAssertTrue(b.isFinished)
        XCTAssertEqual(b.summary, SyncBatchSummary(downloaded: 2, failed: 1))
    }

    func testAnEmptyBatchIsNotFinishedItIsJustEmpty() {
        let b = SyncBatch()
        XCTAssertTrue(b.isEmpty)
        XCTAssertFalse(b.isFinished)
    }

    func testOnlyASongTheSyncQueuedCanSettleIt() {
        var b = batch(queued: ["a"])
        b.markInstalled("first-play")                       // a download the player started: not the sync's
        b.markFailed("first-play-2", message: "x")
        XCTAssertEqual(b.summary, SyncBatchSummary(downloaded: 0, failed: 0))
        XCTAssertFalse(b.isFinished, "…and it does not close the sync either")
        b.markInstalled("a")
        XCTAssertEqual(b.summary, SyncBatchSummary(downloaded: 1, failed: 0))
    }

    func testASongIsCountedOnce() {
        var b = batch(queued: ["a"])
        b.markInstalled("a")
        b.markInstalled("a")
        b.markFailed("a", message: "late")
        XCTAssertEqual(b.summary, SyncBatchSummary(downloaded: 1, failed: 0))
    }

    func testRetryingAFailedSongTakesItOutOfTheErrors() {
        var b = batch(queued: ["a", "b"])
        b.markFailed("a", message: "timeout")
        b.enqueue(["a"], at: t0)                           // Riprova while b is still going
        XCTAssertFalse(b.isFinished)
        b.markInstalled("a")
        b.markInstalled("b")
        XCTAssertEqual(b.summary, SyncBatchSummary(downloaded: 2, failed: 0))
    }

    func testCancellingIsNeitherASuccessNorAnError() {
        var b = batch(queued: ["a", "b"])
        b.markInstalled("a")
        b.forget("b")
        XCTAssertTrue(b.isFinished)
        XCTAssertEqual(b.summary, SyncBatchSummary(downloaded: 1, failed: 0))
        var all = batch(queued: ["x"])
        all.forget("x")
        XCTAssertTrue(all.isEmpty)
        XCTAssertFalse(all.isFinished)
    }

    func testReconcileDropsWhatIsNeitherRunningNorWaiting() {
        var b = batch(queued: ["a", "b", "c"])
        b.markInstalled("a")
        b.reconcile(stillActive: ["b"])
        XCTAssertEqual(b.pending, ["b"])
        XCTAssertEqual(b.downloaded, ["a"])
    }

    func testItSurvivesBeingSavedAndReadBack() throws {
        var b = batch(queued: ["a", "b", "c"])
        b.markInstalled("a")
        b.markFailed("b", message: "timeout")
        let again = try JSONDecoder.iso.decode(SyncBatch.self, from: try JSONEncoder.iso.encode(b))
        XCTAssertEqual(again, b)
    }

    func testAnUnreadableFileDecodesAsAnEmptyBatchNotACrash() throws {
        XCTAssertEqual(try JSONDecoder.iso.decode(SyncBatch.self, from: Data("{}".utf8)), SyncBatch())
        let junk = try JSONDecoder.iso.decode(SyncBatch.self, from: Data(#"{"pending":7,"failed":[1],"startedAt":"nope"}"#.utf8))
        XCTAssertTrue(junk.isEmpty)
    }

    func testABatchFromAnOldCrashIsStale() {
        let b = batch(queued: ["a"])
        XCTAssertFalse(b.isStale(now: t0.addingTimeInterval(3600)))
        XCTAssertTrue(b.isStale(now: t0.addingTimeInterval(6 * 3600 + 1)))
        XCTAssertFalse(SyncBatch().isStale(now: t0), "nothing to be stale")
    }
}

private extension JSONEncoder {
    static var iso: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }
}

private extension JSONDecoder {
    static var iso: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}

final class SyncNotificationPolicyTests: XCTestCase {
    private func content(
        downloaded: Int = 3, failed: Int = 0, preparing: Int = 0,
        enabled: Bool = true, permission: NotificationPermission = .allowed, active: Bool = false
    ) -> SyncNotificationContent? {
        SyncNotificationPolicy.content(
            for: SyncBatchSummary(downloaded: downloaded, failed: failed), stillPreparing: preparing,
            enabled: enabled, permission: permission, appIsActive: active
        )
    }

    // MARK: what it says

    func testTheMessageOfTheSpec() {
        let c = content(downloaded: 12, failed: 2)
        XCTAssertEqual(c?.title, "Sync finito")
        XCTAssertEqual(c?.body, "12 brani scaricati, 2 errori")
    }

    func testSingularAndPluralInItalian() {
        XCTAssertEqual(content(downloaded: 1, failed: 1)?.body, "1 brano scaricato, 1 errore")
        XCTAssertEqual(content(downloaded: 5, failed: 0)?.body, "5 brani scaricati, 0 errori")
        XCTAssertEqual(content(downloaded: 0, failed: 3)?.body, "0 brani scaricati, 3 errori")
    }

    func testItSaysWhenTheServerIsStillPreparingSomething() {
        XCTAssertEqual(content(downloaded: 2, failed: 0, preparing: 4)?.body, "2 brani scaricati, 0 errori · 4 ancora in preparazione sul server")
        XCTAssertEqual(content(downloaded: 2, preparing: 0)?.body, "2 brani scaricati, 0 errori")
    }

    // MARK: when

    func testItFiresWhenTheSwitchIsOnIOSAllowsItAndTheUserIsNotLooking() {
        XCTAssertNotNil(content())
    }

    func testTheSwitchOffMeansSilence() {
        XCTAssertNil(content(enabled: false))
    }

    func testDeniedMeansSilenceAndNeverAPrompt() {
        XCTAssertNil(content(permission: .denied))
    }

    func testNeverAskedMeansSilenceToo() {
        // the permission is asked when the user STARTS a sync, not at the end of it
        XCTAssertNil(content(permission: .notDetermined))
    }

    func testWhileTheUserIsLookingAtTheAppTheStatusLineSaysIt() {
        XCTAssertNil(content(active: true))
    }

    func testNothingDownloadedAndNothingFailedIsNotWorthAMessage() {
        XCTAssertNil(content(downloaded: 0, failed: 0))
        XCTAssertNil(content(downloaded: 0, failed: 0, preparing: 5))
    }

    func testOnlyErrorsStillSayIt() {
        XCTAssertNotNil(content(downloaded: 0, failed: 1))
    }

    // MARK: asking iOS

    func testItAsksOnceWhenSwitchedOnAndNeverAsked() {
        XCTAssertTrue(SyncNotificationPolicy.shouldRequestPermission(enabled: true, permission: .notDetermined))
        XCTAssertFalse(SyncNotificationPolicy.shouldRequestPermission(enabled: false, permission: .notDetermined), "switched off: never")
        XCTAssertFalse(SyncNotificationPolicy.shouldRequestPermission(enabled: true, permission: .denied), "iOS would not ask again")
        XCTAssertFalse(SyncNotificationPolicy.shouldRequestPermission(enabled: true, permission: .allowed))
    }
}

@MainActor
final class SyncNotifierTests: XCTestCase {
    private func notifier(
        _ center: FakeNotificationCenter?, enabled: Bool = true, active: Bool = false, preparing: Int = 0
    ) -> SyncNotifier {
        SyncNotifier(center: center, isEnabled: { enabled }, isAppActive: { active }, stillPreparing: { preparing })
    }

    private let summary = SyncBatchSummary(downloaded: 3, failed: 1)

    func testItPostsWhenASyncEndsInTheBackground() async {
        let center = FakeNotificationCenter(permission: .allowed)
        await notifier(center).syncFinished(summary)
        XCTAssertEqual(center.posted, [SyncNotificationContent(title: "Sync finito", body: "3 brani scaricati, 1 errore")])
    }

    func testItNeverPostsInTheForeground() async {
        let center = FakeNotificationCenter(permission: .allowed)
        await notifier(center, active: true).syncFinished(summary)
        XCTAssertTrue(center.posted.isEmpty)
    }

    func testTheSwitchOffMeansNothingIsPostedAndNothingIsAsked() async {
        let center = FakeNotificationCenter(permission: .notDetermined)
        let n = notifier(center, enabled: false)
        await n.syncFinished(summary)
        await n.ensurePermission()
        XCTAssertTrue(center.posted.isEmpty)
        XCTAssertEqual(center.requestCount, 0)
    }

    func testTheEndOfASyncNeverRaisesThePermissionPrompt() async {
        let center = FakeNotificationCenter(permission: .notDetermined)
        await notifier(center).syncFinished(summary)
        XCTAssertEqual(center.requestCount, 0, "iOS would not show it from the background anyway")
        XCTAssertTrue(center.posted.isEmpty)
    }

    func testDeniedIsRespectedAndNothingBreaks() async {
        let center = FakeNotificationCenter(permission: .denied)
        let n = notifier(center)
        await n.ensurePermission()
        await n.syncFinished(summary)
        XCTAssertEqual(center.requestCount, 0)
        XCTAssertTrue(center.posted.isEmpty)
    }

    func testStartingASyncAsksOnceAndTheAnswerDecidesLater() async {
        let center = FakeNotificationCenter(permission: .notDetermined, grantOnRequest: true)
        let n = notifier(center)
        await n.ensurePermission()
        await n.ensurePermission()                           // the next Sync: already answered
        XCTAssertEqual(center.requestCount, 1, "asked only the first time it was needed")
        await n.syncFinished(summary)
        XCTAssertEqual(center.posted.count, 1)
    }

    func testAnAnswerOfNoMeansNoNotificationAndTheSyncGoesOn() async {
        let center = FakeNotificationCenter(permission: .notDetermined, grantOnRequest: false)
        let n = notifier(center)
        await n.ensurePermission()
        await n.syncFinished(summary)
        XCTAssertEqual(center.requestCount, 1)
        XCTAssertTrue(center.posted.isEmpty)
    }

    func testWithoutACenterNothingHappens() async {
        let n = notifier(nil)
        await n.ensurePermission()
        await n.syncFinished(summary)                        // extensions and tests have no center: no crash, no post
    }

    func testItMentionsWhatTheServerIsStillPreparing() async {
        let center = FakeNotificationCenter(permission: .allowed)
        await notifier(center, preparing: 2).syncFinished(SyncBatchSummary(downloaded: 1, failed: 0))
        XCTAssertEqual(center.posted.first?.body, "1 brano scaricato, 0 errori · 2 ancora in preparazione sul server")
    }

    func testThePostingRunsInsideTheBackgroundTaskSoItIsNotCutShort() async {
        let center = FakeNotificationCenter(permission: .allowed)
        let n = notifier(center)
        let runner = FakeBackgroundRunner()
        n.backgroundRunner = runner
        await n.syncFinished(summary)
        XCTAssertEqual(runner.names, ["mondrop-sync-notification"])
        XCTAssertEqual(center.posted.count, 1)
    }

    func testNothingToSayMeansNoBackgroundTaskEither() async {
        let center = FakeNotificationCenter(permission: .allowed)
        let n = notifier(center)
        let runner = FakeBackgroundRunner()
        n.backgroundRunner = runner
        await n.syncFinished(SyncBatchSummary(downloaded: 0, failed: 0))
        XCTAssertTrue(runner.names.isEmpty)
    }
}

// MARK: - The engine says when a sync is over

@MainActor
final class SyncEngineBatchTests: XCTestCase {
    private func rig(persistQueue: Bool = false, root: URL? = nil, transport: FakeTransport = FakeTransport()) throws -> EngineRig {
        let dir = try root ?? TestSupport.tempDir("batch")
        let r = try EngineRig(config: .test, persistQueue: persistQueue, root: dir, transport: transport)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return r
    }

    private func tracks(_ keys: [String]) -> [OfflineTrack] { keys.map { TestSupport.track($0) } }

    /// Collects every «sync finished» the engine reports.
    private final class Collector {
        var summaries: [SyncBatchSummary] = []
    }

    private func listen(_ r: EngineRig) -> Collector {
        let collector = Collector()
        r.engine.onBatchFinished = { collector.summaries.append($0) }
        return collector
    }

    func testItReportsOnceWhenTheLastSongOfTheSyncIsInstalled() throws {
        let r = try rig()
        let seen = listen(r)
        r.engine.enqueue(tracks(["a", "b", "c"]), home: false)

        try r.finish(r.transport.started[0].info)           // a
        try r.finish(r.transport.started[1].info)           // b
        XCTAssertTrue(seen.summaries.isEmpty, "c is still downloading")
        try r.finish(r.transport.started[2].info)           // c
        XCTAssertEqual(seen.summaries, [SyncBatchSummary(downloaded: 3, failed: 0)])
    }

    func testFailuresAreCounted() throws {
        let r = try rig()
        let seen = listen(r)
        r.engine.enqueue(tracks(["a", "b", "c"]), home: false)
        try r.finish(r.transport.started[0].info)
        r.fail(r.transport.started[1].info, message: "timeout")
        try r.finish(r.transport.started[2].info)
        XCTAssertEqual(seen.summaries, [SyncBatchSummary(downloaded: 2, failed: 1)])
    }

    func testTheDownloadAFirstPlayStartsIsNotASync() throws {
        let r = try rig()
        let seen = listen(r)
        r.engine.enqueue([TestSupport.track("play-me")], home: false, front: true, origin: .play)
        try r.finish(r.transport.started[0].info)
        XCTAssertTrue(seen.summaries.isEmpty, "a notification at every track change would be noise")
        XCTAssertNotNil(r.store.fileURL(songKey: "play-me"), "…but the song is downloaded all the same")
    }

    func testAFirstPlayDownloadInTheMiddleOfASyncDoesNotCountNorCloseIt() throws {
        let r = try rig()
        let seen = listen(r)
        r.engine.enqueue(tracks(["a", "b"]), home: false)
        r.engine.enqueue([TestSupport.track("play-me")], home: false, front: true, origin: .play)   // queued behind a, b
        try r.finish(r.transport.started[0].info)           // a
        try r.finish(r.transport.started[1].info)           // b → the sync is done, play-me still downloading
        XCTAssertEqual(seen.summaries, [SyncBatchSummary(downloaded: 2, failed: 0)])
        try r.finish(r.transport.started[2].info)           // play-me
        XCTAssertEqual(seen.summaries.count, 1)
    }

    func testAMediaServerFailureThatTheProxyRescuesIsNotAnError() throws {
        let r = try rig()
        let seen = listen(r)
        r.engine.enqueue([TestSupport.track("a", mediaUrl: "http://192.168.178.10:49200/a.mp3")], home: true)
        r.fail(r.transport.started[0].info, message: "server non raggiungibile")
        XCTAssertTrue(seen.summaries.isEmpty, "the fallback is still the same download")
        try r.finish(r.transport.started[1].info)
        XCTAssertEqual(seen.summaries, [SyncBatchSummary(downloaded: 1, failed: 0)])
    }

    func testAWrongSizeIsAnErrorOfTheSync() throws {
        let r = try rig()
        let seen = listen(r)
        r.engine.enqueue([TestSupport.track("a", bytes: 100)], home: false)
        try r.finish(r.transport.started[0].info, bytes: 7)
        XCTAssertEqual(seen.summaries, [SyncBatchSummary(downloaded: 0, failed: 1)])
    }

    func testRetryAfterTheEndStartsANewSync() throws {
        let r = try rig()
        let seen = listen(r)
        r.engine.enqueue(tracks(["a", "b"]), home: false)
        try r.finish(r.transport.started[0].info)
        r.fail(r.transport.started[1].info, message: "timeout")
        XCTAssertEqual(seen.summaries, [SyncBatchSummary(downloaded: 1, failed: 1)])

        r.engine.retry(songKey: "b")
        try r.finish(r.transport.started[2].info)
        XCTAssertEqual(seen.summaries.last, SyncBatchSummary(downloaded: 1, failed: 0))
        XCTAssertEqual(seen.summaries.count, 2)
    }

    func testCancellingEverythingSaysNothing() throws {
        let r = try rig()
        let seen = listen(r)
        r.engine.enqueue(tracks(["a", "b", "c"]), home: false)
        r.engine.cancel(songKey: "c")
        r.engine.cancel(songKey: "a")
        r.fail(r.transport.started[0].info, message: "annullato", cancelled: true)
        r.engine.cancel(songKey: "b")
        XCTAssertTrue(seen.summaries.isEmpty)
    }

    func testCancellingTheLastOneClosesTheSyncOfTheOthers() throws {
        let r = try rig()
        let seen = listen(r)
        r.engine.enqueue(tracks(["a", "b"]), home: false)
        try r.finish(r.transport.started[0].info)
        r.engine.cancel(songKey: "b")
        XCTAssertEqual(seen.summaries, [SyncBatchSummary(downloaded: 1, failed: 0)])
    }

    func testNothingToDownloadIsNoSync() throws {
        let r = try rig()
        let seen = listen(r)
        try r.installLocal("a", version: "100-1")
        r.engine.enqueue([TestSupport.track("a", version: "100-1")], home: false)
        XCTAssertTrue(seen.summaries.isEmpty)
    }

    func testPressingSyncAgainWhileItRunsStillCountsEverythingOnce() throws {
        let r = try rig()
        let seen = listen(r)
        let list = tracks(["a", "b", "c"])
        r.engine.enqueue(list, home: false)
        r.engine.enqueue(list, home: false)
        for index in 0..<3 { try r.finish(r.transport.started[index].info) }
        XCTAssertEqual(seen.summaries, [SyncBatchSummary(downloaded: 3, failed: 0)])
    }

    func testASyncPressedWhileAFirstPlayDownloadRunsAdoptsIt() throws {
        let r = try rig()
        let seen = listen(r)
        r.engine.enqueue([TestSupport.track("a")], home: false, front: true, origin: .play)
        r.engine.enqueue(tracks(["a", "b"]), home: false)    // the user taps Sync: a is already coming
        try r.finish(r.transport.started[0].info)
        try r.finish(r.transport.started[1].info)
        XCTAssertEqual(seen.summaries, [SyncBatchSummary(downloaded: 2, failed: 0)])
    }

    func testASongThatHasNoAddressIsAnErrorOfTheSync() throws {
        let r = try EngineRig(config: EngineConfig(baseURL: " / ", apiKey: "k", user: "mike"))
        let dir = r.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let seen = listen(r)
        r.engine.enqueue([TestSupport.track("a")], home: false)
        XCTAssertEqual(seen.summaries, [SyncBatchSummary(downloaded: 0, failed: 1)])
    }

    // MARK: relaunch

    func testTheSyncIsRememberedAcrossARelaunchSoTheLastDownloadStillClosesIt() async throws {
        let first = try rig(persistQueue: true)
        first.engine.enqueue(tracks(["a", "b", "c"]), home: false)           // a, b live; c queued
        XCTAssertNotNil(first.store.readBatchData(), "the batch is on disk")

        // killed; iOS relaunches the app in the background to deliver the downloads. `a` finished meanwhile, `b` still runs.
        let transport = FakeTransport()
        transport.alive = [first.transport.started[1].info]
        let second = try rig(persistQueue: true, root: first.root, transport: transport)
        let seen = listen(second)
        // …and the finished download can arrive BEFORE the relaunch code (attachExisting) has run
        try second.finish(first.transport.started[0].info)
        XCTAssertTrue(seen.summaries.isEmpty, "b and c are still pending: the sync is not over")
        XCTAssertNotNil(second.store.readQueueData(), "an early event must not wipe the queue that is still to be restored")

        await second.engine.attachExisting()
        XCTAssertEqual(transport.startedKeys, ["c"], "the restored queue goes on")
        XCTAssertTrue(seen.summaries.isEmpty)
        try second.finish(first.transport.started[1].info)                    // b
        XCTAssertTrue(seen.summaries.isEmpty)
        try second.finish(try XCTUnwrap(transport.started.first).info)        // c, started by the restored queue
        XCTAssertEqual(seen.summaries, [SyncBatchSummary(downloaded: 3, failed: 0)])
        XCTAssertNil(second.store.readBatchData(), "a finished sync leaves no file behind")
    }

    func testABatchLeftByAnOldCrashIsForgottenNotAnnounced() async throws {
        let first = try rig(persistQueue: true)
        first.engine.enqueue(tracks(["a", "b"]), home: false)
        try first.finish(first.transport.started[0].info)              // a installed; b was still running when the app died
        XCTAssertNotNil(first.store.readBatchData())
        // …and the app comes back 7 hours later: nobody wants «Sync finito» now
        let late = try EngineRig(
            config: .test, persistQueue: true, root: first.root, transport: FakeTransport(),
            now: { Date().addingTimeInterval(7 * 3600) }
        )
        let seen = listen(late)
        await late.engine.attachExisting()
        XCTAssertTrue(seen.summaries.isEmpty)
        XCTAssertNil(late.store.readBatchData())
    }

    func testSongsThatAreNoLongerComingDoNotKeepASyncOpenForEver() async throws {
        let first = try rig(persistQueue: true)
        first.engine.enqueue(tracks(["a", "b"]), home: false)
        try first.finish(first.transport.started[0].info)                      // a installed; b still live
        // relaunch: b is gone from the background session (finished while we were dead, or cancelled by iOS)
        let second = try rig(persistQueue: true, root: first.root)
        let seen = listen(second)
        await second.engine.attachExisting()
        XCTAssertEqual(seen.summaries, [SyncBatchSummary(downloaded: 1, failed: 0)], "what is known is reported, once")
    }
}

// MARK: - The coordinator

@MainActor
final class SyncStartedHookTests: XCTestCase {
    func testStartingASyncTellsTheHookAndNeverWaitsForIt() async throws {
        let api = FakeAPI()
        let rig = try EngineRig()
        let dir = rig.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        var started = 0
        let activity = SyncActivity()
        let coordinator = PlaylistSyncCoordinator(
            playlist: MondropPlaylist(id: "pl1", name: "Road trip", songCount: 2),
            api: api, engine: rig.engine, net: NetStatus(), clock: FakeClock().clock,
            activity: activity, onSyncStarted: { started += 1 }
        )
        api.scriptPrepare("pl1", [TestSupport.manifest("pl1", [TestSupport.track("a", album: "Thriller", genres: ["Pop"], year: 1982), TestSupport.track("b", state: "preparing")])])
        api.scriptManifests("pl1", [.success(TestSupport.manifest("pl1", [TestSupport.track("a"), TestSupport.track("b")]))])

        await coordinator.sync()

        XCTAssertEqual(started, 1)
        XCTAssertEqual(coordinator.phase, .idle, "the hook did not hold the sync")
        XCTAssertEqual(activity.preparingCount(), 0, "b turned ready on the second reading")
    }

    func testTheManifestsAlbumGenresAndYearAreKeptForThePhoneBrowsingOffline() async throws {
        let api = FakeAPI()
        let rig = try EngineRig()
        let dir = rig.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        try rig.installLocal("a", version: "100-1")
        let coordinator = PlaylistSyncCoordinator(
            playlist: MondropPlaylist(id: "pl1", name: "Road trip", songCount: 1),
            api: api, engine: rig.engine, net: NetStatus(), clock: FakeClock().clock
        )
        api.scriptManifests("pl1", [.success(TestSupport.manifest("pl1", [TestSupport.track("a", album: "Thriller", genres: ["Pop"], year: 1982)]))])

        await coordinator.load()

        let item = try XCTUnwrap(rig.store.item(songKey: "a"))
        XCTAssertEqual(item.album, "Thriller")
        XCTAssertEqual(item.genres, ["Pop"])
        XCTAssertEqual(item.year, 1982)
    }

    func testWhileTheServerPreparesTheActivityCountsIt() async throws {
        let api = FakeAPI()
        let rig = try EngineRig()
        let dir = rig.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let activity = SyncActivity()
        api.scriptManifests("pl1", [.success(TestSupport.manifest("pl1", [
            TestSupport.track("a", state: "preparing"), TestSupport.track("b", state: "preparing"), TestSupport.track("c"),
        ]))])
        // reading only: pollTimeout 0 makes the re-read loop give up at once
        let coordinator = PlaylistSyncCoordinator(
            playlist: MondropPlaylist(id: "pl1", name: "P", songCount: 3),
            api: api, engine: rig.engine, net: NetStatus(), clock: FakeClock().clock, pollTimeout: 0, activity: activity
        )
        await coordinator.load()
        XCTAssertEqual(activity.preparingCount(), 2)
    }
}

#if targetEnvironment(simulator)
final class SyncNotificationSettingTests: XCTestCase {
    private let key = "syncNotificationsEnabled"
    private var saved: Any?

    override func setUp() {
        super.setUp()
        saved = UserDefaults.standard.object(forKey: key)
    }

    override func tearDown() {
        if let saved { UserDefaults.standard.set(saved, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
        super.tearDown()
    }

    func testItIsOnUntilTheUserSwitchesItOff() {
        UserDefaults.standard.removeObject(forKey: key)
        XCTAssertTrue(Settings.shared.syncNotificationsEnabled, "default ON — a missing key must not read as OFF")
        Settings.shared.syncNotificationsEnabled = false
        XCTAssertFalse(Settings.shared.syncNotificationsEnabled)
        Settings.shared.syncNotificationsEnabled = true
        XCTAssertTrue(Settings.shared.syncNotificationsEnabled)
    }
}
#endif
