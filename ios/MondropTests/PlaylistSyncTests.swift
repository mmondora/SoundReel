import XCTest
@testable import Mondrop

@MainActor
final class PlaylistSyncCoordinatorTests: XCTestCase {
    private let playlist = MondropPlaylist(id: "pl1", name: "Road trip", songCount: 3)

    @MainActor
    private struct Rig {
        let api: FakeAPI
        let engineRig: EngineRig
        let clock: FakeClock
        let coordinator: PlaylistSyncCoordinator
        var transport: FakeTransport { engineRig.transport }
        var engine: SyncEngine { engineRig.engine }
        var store: OfflineStore { engineRig.store }
    }

    private func rig(playlistId: String = "pl1", pollTimeout: TimeInterval = 600) throws -> Rig {
        let api = FakeAPI()
        let engineRig = try EngineRig(maxParallel: 2)
        let dir = engineRig.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let clock = FakeClock()
        let coordinator = PlaylistSyncCoordinator(
            playlist: MondropPlaylist(id: playlistId, name: "Road trip", songCount: 3),
            api: api,
            engine: engineRig.engine,
            clock: clock.clock,
            pollInterval: 5,
            pollTimeout: pollTimeout
        )
        return Rig(api: api, engineRig: engineRig, clock: clock, coordinator: coordinator)
    }

    private func m(_ tracks: [OfflineTrack]) -> OfflineManifest { TestSupport.manifest("pl1", tracks) }
    private func preparing(_ key: String) -> OfflineTrack { TestSupport.track(key, state: "preparing") }

    // MARK: sync

    func testSyncPreparesThenDownloadsReadyTracksAndSkipsTheRest() async throws {
        let r = try rig()
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a"), TestSupport.track("b", state: "failed", error: "x"), TestSupport.track("c", state: "no_source")])])

        await r.coordinator.sync()

        // Rule P (ADR-0018): a sync never asks where the phone is; it prepares, then downloads from SoundReel.
        XCTAssertEqual(r.api.calls.first, "prepare:pl1:retry=false")
        XCTAssertFalse(r.api.calls.contains("net"), "the network the phone is on decides nothing")
        XCTAssertEqual(r.transport.startedKeys, ["a"], "only ready tracks are downloaded")
        XCTAssertEqual(r.coordinator.phase, .idle)
        XCTAssertNil(r.coordinator.errorText)
        XCTAssertEqual(r.coordinator.manifest?.tracks.count, 3)
        XCTAssertTrue(r.clock.sleeps.isEmpty, "nothing is preparing → no polling")
    }

    func testWhileTracksArePreparingItRereadsEvery5sAndDownloadsEachAsSoonAsItIsReady() async throws {
        let r = try rig()
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a"), preparing("b"), preparing("c")])])
        r.api.scriptManifests("pl1", [
            .success(m([TestSupport.track("a"), preparing("b"), preparing("c")])),                      // poll 1: nothing new
            .success(m([TestSupport.track("a"), TestSupport.track("b"), preparing("c")])),              // poll 2: b ready
            .success(m([TestSupport.track("a"), TestSupport.track("b"), TestSupport.track("c")])),      // poll 3: c ready
        ])

        await r.coordinator.sync()

        XCTAssertEqual(r.clock.sleeps, [5, 5, 5], "one manifest re-read every ~5 s")
        XCTAssertEqual(r.api.calls.filter { $0 == "manifest:pl1" }.count, 3)
        XCTAssertEqual(r.transport.startedKeys, ["a", "b"], "b started as soon as it turned ready (c waits for a free slot)")
        XCTAssertEqual(r.engine.queuedCount, 1)
        XCTAssertEqual(r.coordinator.phase, .idle, "polling stops once nothing is preparing")
        XCTAssertEqual(r.coordinator.manifest?.preparingCount, 0)

        // slot frees up → c goes
        try r.engineRig.finish(r.transport.started[0].info)
        XCTAssertEqual(r.transport.startedKeys, ["a", "b", "c"])
    }

    func testPollingGivesUpAfterTenMinutes() async throws {
        let r = try rig(pollTimeout: 600)
        r.api.scriptPrepare("pl1", [m([preparing("b")])])
        r.api.scriptManifests("pl1", [.success(m([preparing("b")]))])

        await r.coordinator.sync()

        XCTAssertEqual(r.clock.sleeps.count, 120, "600 s / 5 s")
        XCTAssertEqual(r.coordinator.phase, .idle)
        XCTAssertTrue(r.coordinator.message.contains("ancora"), "tell the user to retry later: \(r.coordinator.message)")
        XCTAssertTrue(r.transport.started.isEmpty)
    }

    func testSyncIsIdempotent() async throws {
        let r = try rig()
        let list = m([TestSupport.track("a"), TestSupport.track("b"), TestSupport.track("c")])
        r.api.scriptPrepare("pl1", [list])

        await r.coordinator.sync()
        await r.coordinator.sync()                               // the user taps Sync again

        XCTAssertEqual(r.transport.started.count, 2, "a and b started once")
        XCTAssertEqual(r.engine.queuedCount, 1, "c queued once")
    }

    func testAlreadyDownloadedTracksAreReportedNotRedownloaded() async throws {
        let r = try rig()
        try r.engineRig.installLocal("a", version: "100-1")
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a", version: "100-1"), TestSupport.track("b")])])
        await r.coordinator.sync()
        XCTAssertEqual(r.transport.startedKeys, ["b"])
        XCTAssertTrue(r.coordinator.message.contains("già sul telefono"), r.coordinator.message)
    }

    func testRetryFailedIsSentToTheServer() async throws {
        let r = try rig()
        r.api.scriptPrepare("pl1", [m([TestSupport.track("b", state: "failed", error: "x")])])
        await r.coordinator.sync(retryFailed: true)
        XCTAssertTrue(r.api.calls.contains("prepare:pl1:retry=true"))
    }

    func testRowRetryDependsOnWhereItFailed() async throws {
        let r = try rig()
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a"), TestSupport.track("b", state: "failed", error: "x")])])
        await r.coordinator.sync()
        r.engineRig.fail(r.transport.started[0].info, message: "timeout")                   // a failed ON THE DEVICE

        await r.coordinator.retry(songKey: "a")
        XCTAssertEqual(r.transport.started.count, 2, "device failure → local retry, no server call")
        XCTAssertEqual(r.api.calls.filter { $0.hasPrefix("prepare") }.count, 1)

        await r.coordinator.retry(songKey: "b")                                             // b failed ON THE SERVER
        XCTAssertEqual(r.api.calls.filter { $0 == "prepare:pl1:retry=true" }.count, 1)
    }

    func testRetryOnANoSourceRowAsksTheServerToSearchAgain() async throws {
        let r = try rig()
        r.api.scriptPrepare("pl1", [m([TestSupport.track("c", state: "no_source")])])
        await r.coordinator.sync()
        await r.coordinator.retry(songKey: "c")
        XCTAssertTrue(r.api.calls.contains("prepare:pl1:retry=true"))
        XCTAssertTrue(r.transport.started.isEmpty)
    }

    func testAnOldBackendWithoutPrepareGetsAClearMessageNotAnHttp404() async throws {
        let r = try rig()   // nothing scripted for prepare: the fake answers 404, like a backend that predates the sync contract
        await r.coordinator.sync()
        XCTAssertEqual(r.coordinator.errorText, "Il server non supporta ancora il nuovo Sync (backend da aggiornare): niente da scaricare.")
        XCTAssertTrue(r.transport.started.isEmpty)
    }

    func testErrorsAreShownAndTheScreenStaysUsable() async throws {
        let r = try rig()
        r.api.failPrepare(MondropAPIError.http(500, "boom"))
        await r.coordinator.sync()
        XCTAssertEqual(r.coordinator.errorText, "HTTP 500: boom")
        XCTAssertEqual(r.coordinator.phase, .idle)
        r.api.failPrepare(nil)
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a")])])
        await r.coordinator.sync()
        XCTAssertNil(r.coordinator.errorText, "a later success clears it")
        XCTAssertEqual(r.transport.startedKeys, ["a"])
    }

    // MARK: a sync with a gate (the playlist that plays) and the one without

    /// A gate that admits what the test says, keeps what it was asked and can hold the answer back.
    @MainActor
    private final class FakeGate: DownloadGate {
        var admit: ([OfflineTrack]) -> [OfflineTrack] = { $0 }
        var closesAfterTheFirstAnswer = false
        var holdsTheAnswer = false
        private(set) var wanted: [[String]] = []
        private(set) var isClosed = false
        private var held: CheckedContinuation<Void, Never>?
        var isHolding: Bool { held != nil }

        func admit(_ wanted: [OfflineTrack], in manifest: OfflineManifest) async -> [OfflineTrack] {
            self.wanted.append(wanted.map(\.songKey))
            if holdsTheAnswer { await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in held = continuation } }
            if closesAfterTheFirstAnswer { isClosed = true }
            return admit(wanted)
        }

        func release() {
            held?.resume()
            held = nil
        }
    }

    private func gatedRig(_ gate: DownloadGate, playlistId: String = "pl1") throws -> Rig {
        let api = FakeAPI()
        let engineRig = try EngineRig(maxParallel: 2)
        let dir = engineRig.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let clock = FakeClock()
        let coordinator = PlaylistSyncCoordinator(
            playlist: MondropPlaylist(id: playlistId, name: "Road trip", songCount: 3),
            api: api, engine: engineRig.engine, clock: clock.clock, pollInterval: 5, pollTimeout: 600, gate: gate
        )
        return Rig(api: api, engineRig: engineRig, clock: clock, coordinator: coordinator)
    }

    func testAGatedSyncDownloadsOnlyWhatTheGateAdmitsAndTheGateSeesWhatTheSyncWanted() async throws {
        let gate = FakeGate()
        gate.admit = { $0.filter { $0.songKey != "b" } }
        let r = try gatedRig(gate)
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a"), TestSupport.track("b"), TestSupport.track("c"), TestSupport.track("p", state: "preparing")])])
        r.api.scriptManifests("pl1", [.success(m([TestSupport.track("a"), TestSupport.track("b"), TestSupport.track("c"), TestSupport.track("p")]))])
        await r.coordinator.sync()
        XCTAssertEqual(gate.wanted.first, ["a", "b", "c"], "ready on the server and missing from the phone, in the order of the playlist")
        XCTAssertEqual(Set(r.engine.progress.keys), ["a", "c", "p"], "«b» was not admitted; «p» was, when it turned ready")
        XCTAssertEqual(gate.wanted.last, ["b", "p"], "the next reading asks again for what is still missing, «b» included: the gate decides, not the sync")
    }

    func testAGatedSyncStillAdoptsAFileThePhoneAlreadyHasEvenWhenNothingIsAdmitted() async throws {
        let gate = FakeGate()
        gate.admit = { _ in [] }
        let r = try gatedRig(gate)
        r.api.scriptPrepare("pl1", [m([TestSupport.track("old", version: "100-7", bytes: 100)])])
        try r.engineRig.installLocal("old", version: nil, bytes: 100)
        await r.coordinator.sync()
        XCTAssertEqual(r.store.snapshot(songKey: "old")?.version, "100-7", "bookkeeping, not a download: the next sync skips it")
        XCTAssertTrue(r.engine.progress.isEmpty)
    }

    func testAGateThatClosesStopsTheReadingsOfAPlaylistThatIsStillBeingPrepared() async throws {
        let gate = FakeGate()
        gate.closesAfterTheFirstAnswer = true
        let r = try gatedRig(gate)
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a"), preparing("b")])])
        r.api.scriptManifests("pl1", [.success(m([TestSupport.track("a"), TestSupport.track("b")]))])
        await r.coordinator.sync()
        XCTAssertTrue(r.clock.sleeps.isEmpty, "no waiting for songs that nobody will download")
        XCTAssertFalse(r.api.calls.contains("manifest:pl1"))
        XCTAssertEqual(Set(r.engine.progress.keys), ["a"])
        XCTAssertEqual(r.coordinator.phase, .idle)
    }

    func testAGatedSyncThatIsCancelledWhileTheGateThinksQueuesNothing() async throws {
        let gate = FakeGate()
        gate.holdsTheAnswer = true
        let r = try gatedRig(gate)
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a"), TestSupport.track("b")])])
        let task = Task { await r.coordinator.sync() }
        for _ in 0..<500 where !gate.isHolding { try await Task.sleep(nanoseconds: 2_000_000) }
        XCTAssertTrue(gate.isHolding, "the sync is waiting for the gate")
        XCTAssertTrue(r.engine.progress.isEmpty, "nothing is queued before the gate answers")
        task.cancel()
        gate.release()
        await task.value
        XCTAssertTrue(r.engine.progress.isEmpty, "the playlist stopped playing while the question was open: nothing goes")
        XCTAssertEqual(r.coordinator.phase, .idle)
    }

    func testAGatedSyncDoesNotMakeALaterVisitToThePageDownloadWhatTheUserDidNotAllow() async throws {
        let id = "gated-only-\(UUID().uuidString)"
        let gate = FakeGate()
        gate.admit = { _ in [] }
        gate.closesAfterTheFirstAnswer = true
        let r = try gatedRig(gate, playlistId: id)
        r.api.scriptPrepare(id, [TestSupport.manifest(id, [TestSupport.track("a"), TestSupport.track("p", state: "preparing")])])
        await r.coordinator.sync()
        XCTAssertTrue(r.engine.progress.isEmpty)

        // the page of the playlist is opened while the server is still preparing «p»: reading the list is all it does
        let visit = PlaylistSyncCoordinator(
            playlist: MondropPlaylist(id: id, name: "Road trip", songCount: 2),
            api: r.api, engine: r.engine, clock: r.clock.clock, pollInterval: 5, pollTimeout: 600
        )
        r.api.scriptManifests(id, [
            .success(TestSupport.manifest(id, [TestSupport.track("a"), TestSupport.track("p", state: "preparing")])),     // what the page reads
            .success(TestSupport.manifest(id, [TestSupport.track("a"), TestSupport.track("p")])),                          // and then «p» is ready
        ])
        await visit.load()
        XCTAssertTrue(r.api.calls.contains("manifest:\(id)"))
        XCTAssertTrue(r.engine.progress.isEmpty, "only a «Sync» the user pressed makes a visit to the page download as songs turn ready")
    }

    func testTheSyncInsideAPlaylistHasNoQuestionWhateverTheSize() async throws {
        let r = try rig()
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a", bytes: 40_000_000_000), TestSupport.track("b", bytes: 40_000_000_000)])])
        await r.coordinator.sync()
        XCTAssertEqual(Set(r.engine.progress.keys), ["a", "b"], "the manual «Sync» is as it was: it takes everything")
    }

    // MARK: load + membership

    func testLoadShowsTheManifestWithoutDownloadingAnything() async throws {
        let r = try rig()
        r.api.scriptManifests("pl1", [.success(m([TestSupport.track("a"), TestSupport.track("b")]))])
        await r.coordinator.load()
        XCTAssertEqual(r.coordinator.manifest?.tracks.count, 2)
        XCTAssertTrue(r.transport.started.isEmpty, "opening a playlist never starts downloads: Sync does")
        XCTAssertFalse(r.api.calls.contains { $0.hasPrefix("prepare") })
    }

    func testEveryManifestSeenRecordsThePlaylistMembership() async throws {
        let r = try rig()
        try r.engineRig.installLocal("a", version: "1-1")
        try r.engineRig.installLocal("old", version: "1-1")
        r.api.scriptManifests("pl1", [.success(m([TestSupport.track("a")]))])
        await r.coordinator.load()
        XCTAssertEqual(r.store.knownPlaylistIds, ["pl1"])
        XCTAssertEqual(r.store.orphans().map(\.songKey), ["old"], "a is protected by the playlist, old is not")
    }

    func testLoadOfAPlaylistTheServerIsStillPreparingJustRefreshesTheList() async throws {
        let r = try rig(playlistId: "never-synced")
        r.api.scriptManifests("never-synced", [
            .success(TestSupport.manifest("never-synced", [preparing("b")])),
            .success(TestSupport.manifest("never-synced", [TestSupport.track("b")])),
        ])
        await r.coordinator.load()
        XCTAssertEqual(r.coordinator.manifest?.preparingCount, 0, "the view followed the server")
        XCTAssertTrue(r.transport.started.isEmpty, "…but did not download: the user never pressed Sync here")
    }

    // MARK: YouTube override

    func testYouTubeOverrideRejectsOtherLinksWithoutCallingTheServer() async throws {
        let r = try rig()
        for bad in ["https://vimeo.com/1", "https://evil.example/watch?v=1", "not a link", "", "ftp://youtube.com/watch?v=1", "https://youtube.com.evil.example/x"] {
            let ok = await r.coordinator.setYouTubeSource(songKey: "a", urlText: bad)
            XCTAssertFalse(ok, bad)
        }
        XCTAssertTrue(r.api.calls.isEmpty)
        XCTAssertEqual(r.coordinator.errorText, "Link YouTube non valido")
    }

    func testYouTubeOverrideSetsTheSourceThenPreparesAndDownloads() async throws {
        let r = try rig()
        r.api.scriptPrepare("pl1", [m([TestSupport.track("a")])])
        let ok = await r.coordinator.setYouTubeSource(songKey: "a", urlText: "  https://www.youtube.com/watch?v=abc123  ")
        XCTAssertTrue(ok)
        XCTAssertEqual(r.api.calls.first(where: { $0.hasPrefix("source:") }), "source:a:https://www.youtube.com/watch?v=abc123")
        XCTAssertTrue(r.api.calls.contains("prepare:pl1:retry=false"))
        XCTAssertEqual(r.transport.startedKeys, ["a"])
    }

    func testYouTubeLinkNormalisation() {
        for good in ["https://www.youtube.com/watch?v=abc", "https://youtu.be/abc", "https://music.youtube.com/watch?v=abc", "http://m.youtube.com/watch?v=abc"] {
            XCTAssertNotNil(PlaylistSyncCoordinator.normalizedYouTubeURL(good), good)
        }
        for bad in ["https://notyoutube.com/x", "https://youtube.com.evil.example/x", "javascript:alert(1)"] {
            XCTAssertNil(PlaylistSyncCoordinator.normalizedYouTubeURL(bad), bad)
        }
    }
}

@MainActor
final class LibraryCleanerTests: XCTestCase {
    private func store(_ keys: [String]) throws -> OfflineStore {
        let rig = try EngineRig(maxParallel: 2)
        let dir = rig.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        for k in keys { try rig.installLocal(k, version: "1-1", bytes: 1000) }
        return rig.store
    }

    func testRefreshesEveryPlaylistThenOffersExactlyTheOrphans() async throws {
        let store = try store(["a", "b", "c"])
        let api = FakeAPI()
        api.setPlaylists([MondropPlaylist(id: "p1", name: "Uno", songCount: 1), MondropPlaylist(id: "p2", name: "Due", songCount: 1)])
        api.scriptManifests("p1", [.success(TestSupport.manifest("p1", [TestSupport.track("a")]))])
        api.scriptManifests("p2", [.success(TestSupport.manifest("p2", [TestSupport.track("b"), TestSupport.track("not-downloaded")]))])
        let cleaner = LibraryCleaner()

        await cleaner.check(api: api, store: store)

        XCTAssertEqual(cleaner.phase, .ready(count: 1, bytes: 1000))
        XCTAssertEqual(api.calls, ["playlists", "manifest:p1", "manifest:p2"])
        XCTAssertEqual(store.loadIndex().count, 3, "checking deletes nothing")

        cleaner.confirmRemoval(store: store)
        XCTAssertEqual(cleaner.phase, .done(count: 1, bytes: 1000))
        XCTAssertEqual(Set(store.loadIndex().map(\.songKey)), ["a", "b"])
    }

    func testAPlaylistDeletedOnTheServerStopsProtectingItsSongs() async throws {
        let store = try store(["a", "c"])
        store.recordPlaylist(id: "deleted", name: "Vecchia", songKeys: ["c"])
        let api = FakeAPI()
        api.setPlaylists([MondropPlaylist(id: "p1", name: "Uno", songCount: 1)])
        api.scriptManifests("p1", [.success(TestSupport.manifest("p1", [TestSupport.track("a")]))])
        let cleaner = LibraryCleaner()
        await cleaner.check(api: api, store: store)
        XCTAssertEqual(cleaner.phase, .ready(count: 1, bytes: 1000))
        XCTAssertEqual(store.orphans().map(\.songKey), ["c"])
    }

    func testIfAnyPlaylistCannotBeReadNothingIsOfferedOrDeleted() async throws {
        let store = try store(["a", "b"])
        let api = FakeAPI()
        api.setPlaylists([MondropPlaylist(id: "p1", name: "Uno", songCount: 1), MondropPlaylist(id: "p2", name: "Due", songCount: 1)])
        api.scriptManifests("p1", [.success(TestSupport.manifest("p1", [TestSupport.track("a")]))])
        api.scriptManifests("p2", [.failure(MondropAPIError.http(500, nil))])
        let cleaner = LibraryCleaner()

        await cleaner.check(api: api, store: store)
        guard case .failed(let message) = cleaner.phase else { return XCTFail("expected failure, got \(cleaner.phase)") }
        XCTAssertTrue(message.contains("non cancello niente"))

        cleaner.confirmRemoval(store: store)                     // even a stray confirmation removes nothing
        XCTAssertEqual(Set(store.loadIndex().map(\.songKey)), ["a", "b"])
    }

    func testNothingToFree() async throws {
        let store = try store(["a"])
        let api = FakeAPI()
        api.setPlaylists([MondropPlaylist(id: "p1", name: "Uno", songCount: 1)])
        api.scriptManifests("p1", [.success(TestSupport.manifest("p1", [TestSupport.track("a")]))])
        let cleaner = LibraryCleaner()
        await cleaner.check(api: api, store: store)
        XCTAssertEqual(cleaner.phase, .ready(count: 0, bytes: 0))
    }
}

@MainActor
final class NetStatusTests: XCTestCase {
    private final class Clock: @unchecked Sendable {
        var now = Date(timeIntervalSince1970: 5_000_000)
    }

    func testLabelFollowsTheServerAnswer() async {
        let api = FakeAPI()
        let net = NetStatus()
        XCTAssertEqual(net.label, "sconosciuta")
        api.setNet(.success(NetInfo(viaCloudflare: false, home: true)))
        await net.refresh(api: api)
        XCTAssertEqual(net.label, "casa")
        api.setNet(.success(NetInfo(viaCloudflare: true, home: false)))
        await net.refresh(api: api)
        XCTAssertEqual(net.label, "internet")
        api.setNet(.failure(MondropAPIError.transport("offline")))
        await net.refresh(api: api)
        XCTAssertEqual(net.label, "sconosciuta")
        XCTAssertNotNil(net.lastError)
    }

    func testTheNetworkChangingForgetsWhenItWasLastChecked() async {
        let api = FakeAPI()
        let clock = Clock()
        let net = NetStatus(now: { clock.now })
        await net.refresh(api: api)
        XCTAssertNotNil(net.checkedAt)
        net.invalidate()                                           // Wi-Fi ↔ cellular
        XCTAssertNil(net.checkedAt)
        XCTAssertEqual(net.label, "casa", "the last answer stays on screen until the next check")
    }

    func testWaitingForWifiHint() {
        XCTAssertTrue(WifiHint.isWaitingForWifi(onExpensivePath: true, allowCellular: false, activeDownloads: 2))
        XCTAssertFalse(WifiHint.isWaitingForWifi(onExpensivePath: false, allowCellular: false, activeDownloads: 2), "on Wi-Fi nothing waits")
        XCTAssertFalse(WifiHint.isWaitingForWifi(onExpensivePath: true, allowCellular: true, activeDownloads: 2), "the user allowed cellular")
        XCTAssertFalse(WifiHint.isWaitingForWifi(onExpensivePath: true, allowCellular: false, activeDownloads: 0), "nothing to wait for")
    }
}
