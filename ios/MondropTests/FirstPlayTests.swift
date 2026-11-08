import XCTest
@testable import Mondrop

/// First-play rule: on the device → local file; otherwise stream NOW and download in parallel.
final class FirstPlayDecisionTests: XCTestCase {
    private let cfg = MondropAPIConfig.test
    private let media = "http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/a.mp3"
    private let file = URL(fileURLWithPath: "/var/mobile/Application Support/Mondrop/Offline/a.mp3")

    private func decide(_ track: OfflineTrack?, local: URL? = nil, home: Bool = false) -> FirstPlayDecision {
        FirstPlay.decide(songKey: "a", track: track, local: local, home: home, config: cfg)
    }

    func testAlreadyOnTheDevicePlaysTheLocalFileWhateverTheServerSays() {
        for state in ["ready", "preparing", "failed", "no_source", "missing"] {
            XCTAssertEqual(decide(TestSupport.track("a", state: state), local: file), .local(file), "state \(state)")
        }
        XCTAssertEqual(decide(nil, local: file), .local(file), "a local-only item (Library tab, migrated file)")
    }

    func testReadyOnTheServerStreamsAndDownloadsInParallel() {
        let t = TestSupport.track("a")
        guard case .stream(let sources, let download) = decide(t) else { return XCTFail("expected stream") }
        XCTAssertEqual(download, t, "the same track is what gets downloaded for next time")
        XCTAssertEqual(sources.count, 1)
        XCTAssertEqual(sources[0].kind, .proxy)
        XCTAssertEqual(sources[0].url.absoluteString, "https://soundreel.test/api/mondrop/songs/a/file")
        XCTAssertEqual(sources[0].headers["X-SoundReel-Key"], "sr_test_key_0123456789abcdef")
        XCTAssertEqual(sources[0].headers["X-SoundReel-User"], "mike")
        XCTAssertFalse(sources[0].isLocal)
    }

    func testAtHomeItStreamsFromTheMediaServerWithoutHeadersThenFallsBackToTheProxy() {
        let t = TestSupport.track("a", mediaUrl: media)
        guard case .stream(let sources, _) = decide(t, home: true) else { return XCTFail("expected stream") }
        XCTAssertEqual(sources.map(\.kind), [.media, .proxy])
        XCTAssertEqual(sources[0].url.absoluteString, media)
        XCTAssertTrue(sources[0].headers.isEmpty, "the media server never sees the API key")
        XCTAssertFalse(sources[1].headers.isEmpty)
    }

    func testAwayFromHomeTheMediaServerIsNotEvenTried() {
        guard case .stream(let sources, _) = decide(TestSupport.track("a", mediaUrl: media), home: false) else { return XCTFail("expected stream") }
        XCTAssertEqual(sources.map(\.kind), [.proxy])
    }

    func testNotPreparedYetAsksTheServerWithPriority() {
        for state in ["preparing", "missing", "failed"] {
            let t = TestSupport.track("a", state: state)
            XCTAssertEqual(decide(t), .prepare(t), "state \(state): wait for the server (a failed track is retried on explicit play)")
        }
    }

    func testNoSourceIsUnavailableWithAHint() {
        guard case .unavailable(let message) = decide(TestSupport.track("a", state: "no_source")) else { return XCTFail("expected unavailable") }
        XCTAssertTrue(message.contains("YouTube"))
    }

    func testNothingKnownAndNothingLocalIsUnavailable() {
        guard case .unavailable = decide(nil) else { return XCTFail("expected unavailable") }
    }

    func testReadyWithoutAnyUsableAddressIsUnavailable() {
        let noBase = MondropAPIConfig(baseURL: "", apiKey: "k", user: "u")
        let d = FirstPlay.decide(songKey: "a", track: TestSupport.track("a"), local: nil, home: false, config: noBase)
        guard case .unavailable = d else { return XCTFail("expected unavailable") }
    }

    func testOldServerTrackWithoutStateStillStreams() {
        let old = TestSupport.track("a", state: nil, version: nil, status: "ready")
        guard case .stream = decide(old) else { return XCTFail("legacy status=ready must stream") }
    }
}

/// "Preparo il brano…": priority request, then poll until the server has it.
final class PlaybackPreparationTests: XCTestCase {
    private func track(_ state: String, error: String? = nil) -> OfflineTrack {
        TestSupport.track("a", state: state, error: error)
    }

    func testRequestsWithPlayPriorityThenPollsUntilReady() async throws {
        let api = FakeAPI()
        api.setAck(DownloadAck(ok: true, state: "preparing", track: track("preparing")))
        api.scriptTrack("a", [.success(track("preparing")), .success(track("preparing")), .success(track("ready"))])
        let clock = FakeClock()

        let ready = try await PlaybackPreparation.awaitReady(track("missing"), api: api, clock: clock.clock)

        XCTAssertEqual(ready.resolvedState, .ready)
        XCTAssertEqual(api.calls.first, "download:a:play", "the user is waiting: priority play, not sync")
        XCTAssertEqual(api.calls.filter { $0 == "track:a" }.count, 3)
        XCTAssertEqual(clock.sleeps, [2, 2, 2], "polls every ~2 s")
    }

    func testAlreadyReadyInTheAckDoesNotPoll() async throws {
        let api = FakeAPI()
        api.setAck(DownloadAck(ok: true, state: "ready", track: track("ready")))
        let clock = FakeClock()
        let ready = try await PlaybackPreparation.awaitReady(track("missing"), api: api, clock: clock.clock)
        XCTAssertEqual(ready.resolvedState, .ready)
        XCTAssertEqual(api.calls, ["download:a:play"])
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    func testAckWithoutATrackFetchesIt() async throws {
        let api = FakeAPI()
        api.setAck(DownloadAck(ok: true, state: "ready", track: nil))
        api.scriptTrack("a", [.success(track("ready"))])
        let ready = try await PlaybackPreparation.awaitReady(track("missing"), api: api, clock: FakeClock().clock)
        XCTAssertEqual(ready.resolvedState, .ready)
        XCTAssertEqual(api.calls, ["download:a:play", "track:a"])
    }

    func testServerFailureEndsTheWaitWithItsReason() async {
        let api = FakeAPI()
        api.setAck(DownloadAck(ok: true, state: "preparing", track: track("preparing")))
        api.scriptTrack("a", [.success(track("failed", error: "HTTP Error 403"))])
        do {
            _ = try await PlaybackPreparation.awaitReady(track("missing"), api: api, clock: FakeClock().clock)
            XCTFail("should have thrown")
        } catch {
            XCTAssertEqual(error as? PlaybackPreparationError, .unavailable("HTTP Error 403"))
        }
    }

    func testNoSourceEndsTheWait() async {
        let api = FakeAPI()
        api.setAck(DownloadAck(ok: true, state: "no_source", track: track("no_source", error: "nessun risultato")))
        do {
            _ = try await PlaybackPreparation.awaitReady(track("missing"), api: api, clock: FakeClock().clock)
            XCTFail("should have thrown")
        } catch {
            XCTAssertEqual(error as? PlaybackPreparationError, .unavailable("nessun risultato"))
        }
    }

    func testGivesUpAfterTheTimeout() async {
        let api = FakeAPI()
        api.setAck(DownloadAck(ok: true, state: "preparing", track: track("preparing")))
        api.scriptTrack("a", [.success(track("preparing"))])
        let clock = FakeClock()
        do {
            _ = try await PlaybackPreparation.awaitReady(track("missing"), api: api, clock: clock.clock, pollInterval: 2, timeout: 10)
            XCTFail("should have thrown")
        } catch {
            XCTAssertEqual(error as? PlaybackPreparationError, .timedOut)
            XCTAssertEqual(clock.sleeps.count, 5, "10 s / 2 s")
        }
    }

    func testCancellingStopsTheLoopWithoutAnError() async {
        let api = FakeAPI()
        api.setAck(DownloadAck(ok: true, state: "preparing", track: track("preparing")))
        api.scriptTrack("a", [.success(track("preparing"))])
        // real clock with a long interval: only cancellation can end this quickly
        let task = Task {
            try await PlaybackPreparation.awaitReady(track("missing"), api: api, clock: .real, pollInterval: 30, timeout: 600)
        }
        try? await Task.sleep(nanoseconds: 50_000_000)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("should have thrown")
        } catch {
            XCTAssertTrue(error is CancellationError, "the user skipped: \(error)")
        }
    }

    func testASingleNetworkBlipDoesNotKillTheWait() async throws {
        let api = FakeAPI()
        api.setAck(DownloadAck(ok: true, state: "preparing", track: track("preparing")))
        api.scriptTrack("a", [
            .failure(MondropAPIError.transport("offline")),
            .failure(MondropAPIError.transport("offline")),
            .success(track("ready")),
        ])
        let ready = try await PlaybackPreparation.awaitReady(track("missing"), api: api, clock: FakeClock().clock)
        XCTAssertEqual(ready.resolvedState, .ready)
    }

    func testThreeFailuresInARowGiveUp() async {
        let api = FakeAPI()
        api.setAck(DownloadAck(ok: true, state: "preparing", track: track("preparing")))
        api.scriptTrack("a", [.failure(MondropAPIError.transport("offline"))])
        do {
            _ = try await PlaybackPreparation.awaitReady(track("missing"), api: api, clock: FakeClock().clock)
            XCTFail("should have thrown")
        } catch {
            XCTAssertEqual(error as? MondropAPIError, .transport("offline"))
        }
    }

    func testTheDownloadRequestItselfFailingPropagates() async {
        final class Failing: MondropAPIProtocol, @unchecked Sendable {
            func listPlaylists() async throws -> [MondropPlaylist] { [] }
            func offlineManifest(playlistId: String) async throws -> OfflineManifest { throw MondropAPIError.http(500, nil) }
            func prepare(playlistId: String, retryFailed: Bool) async throws -> OfflineManifest { throw MondropAPIError.http(500, nil) }
            func net() async throws -> NetInfo { throw MondropAPIError.http(500, nil) }
            func track(songKey: String) async throws -> OfflineTrack { throw MondropAPIError.http(404, nil) }
            func requestDownload(songKey: String, priority: DownloadPriority) async throws -> DownloadAck { throw MondropAPIError.http(404, "song_not_found") }
            func setSource(songKey: String, youtubeUrl: String) async throws {}
        }
        do {
            _ = try await PlaybackPreparation.awaitReady(track("missing"), api: Failing(), clock: FakeClock().clock)
            XCTFail("should have thrown")
        } catch {
            XCTAssertEqual(error as? MondropAPIError, .http(404, "song_not_found"))
        }
    }
}
