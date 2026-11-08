import XCTest
@testable import Mondrop

@MainActor
final class SyncEngineTests: XCTestCase {
    private let media = "http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/"

    private func rig(config: EngineConfig = .test, persistQueue: Bool = false, root: URL? = nil, transport: FakeTransport = FakeTransport()) throws -> EngineRig {
        let r = try EngineRig(config: config, persistQueue: persistQueue, root: root, transport: transport)
        let dir = r.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return r
    }

    private func tracks(_ keys: [String]) -> [OfflineTrack] { keys.map { TestSupport.track($0) } }

    // MARK: parallelism

    func testNeverMoreThanTwoDownloadsAtOnce() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a", "b", "c", "d", "e"]), home: false)

        XCTAssertEqual(r.transport.startedKeys, ["a", "b"])
        XCTAssertEqual(r.engine.activeCount, 2)
        XCTAssertEqual(r.engine.queuedCount, 3)
        XCTAssertEqual(r.engine.progress["a"], .downloading(nil))
        XCTAssertEqual(r.engine.progress["c"], .queued)

        try r.finish(r.transport.started[0].info)             // a done → c starts
        XCTAssertEqual(r.transport.startedKeys, ["a", "b", "c"])
        XCTAssertEqual(r.engine.activeCount, 2)
        try r.finish(r.transport.started[1].info)             // b done → d starts
        try r.finish(r.transport.started[2].info)             // c done → e starts
        XCTAssertEqual(r.transport.startedKeys, ["a", "b", "c", "d", "e"])
        XCTAssertLessThanOrEqual(r.engine.activeCount, 2)

        for job in r.transport.started[3...] { try r.finish(job.info) }
        XCTAssertEqual(r.engine.activeCount, 0)
        XCTAssertEqual(r.engine.queuedCount, 0)
        XCTAssertEqual(Set(r.store.loadIndex().map(\.songKey)), ["a", "b", "c", "d", "e"])
        XCTAssertTrue(r.engine.progress.isEmpty, "finished tracks leave no progress behind: the store says scaricato")
    }

    // MARK: skip-present / idempotence

    func testSyncTwiceDoesNotDownloadAnythingTwice() throws {
        let r = try rig()
        let list = tracks(["a", "b", "c"])
        r.engine.enqueue(list, home: false)
        let plan = r.engine.enqueue(list, home: false)          // user taps Sync again mid-flight

        XCTAssertTrue(plan.download.isEmpty)
        XCTAssertEqual(r.transport.started.count, 2, "no duplicate task for a/b")
        XCTAssertEqual(r.engine.queuedCount, 1, "c is queued once")
        XCTAssertEqual(Set(plan.inFlight), ["a", "b", "c"])
    }

    func testPresentWithSameVersionIsSkippedAndNeverTouched() throws {
        let r = try rig()
        try r.installLocal("a", version: "100-1")
        let plan = r.engine.enqueue([TestSupport.track("a", version: "100-1"), TestSupport.track("b")], home: false)

        XCTAssertEqual(r.transport.startedKeys, ["b"])
        XCTAssertEqual(plan.skipped, ["a"])
        XCTAssertNil(r.engine.progress["a"])
    }

    func testNewServerVersionIsDownloadedAgain() throws {
        let r = try rig()
        try r.installLocal("a", version: "100-1")
        r.engine.enqueue([TestSupport.track("a", version: "200-2")], home: false)
        XCTAssertEqual(r.transport.startedKeys, ["a"])
    }

    func testLegacyFileWithTheSameSizeIsAdoptedWithoutDownloading() throws {
        let r = try rig()
        try r.installLocal("a", version: nil, bytes: 700)
        r.engine.enqueue([TestSupport.track("a", version: "700-9", bytes: 700)], home: false)

        XCTAssertTrue(r.transport.started.isEmpty)
        XCTAssertEqual(r.store.snapshot(songKey: "a")?.version, "700-9", "the version is remembered for next time")
    }

    // MARK: URL choice + auth

    func testAtHomeTheMediaServerIsUsedWithoutAnyAuthHeader() throws {
        let r = try rig()
        r.engine.enqueue([TestSupport.track("a", mediaUrl: media + "a.mp3")], home: true)

        let job = try XCTUnwrap(r.transport.started.first)
        XCTAssertEqual(job.request.url?.absoluteString, media + "a.mp3")
        XCTAssertEqual(job.info.kind, "media")
        XCTAssertNil(job.request.value(forHTTPHeaderField: "X-SoundReel-Key"), "never send the API key to the media server")
        XCTAssertNil(job.request.value(forHTTPHeaderField: "X-SoundReel-User"))
        XCTAssertEqual(job.info.proxyPath, "/api/mondrop/songs/a/file", "kept for the fallback")
    }

    func testAwayFromHomeTheProxyIsUsedWithAuth() throws {
        let r = try rig()
        r.engine.enqueue([TestSupport.track("a", mediaUrl: media + "a.mp3")], home: false)

        let job = try XCTUnwrap(r.transport.started.first)
        XCTAssertEqual(job.request.url?.absoluteString, "https://soundreel.test/api/mondrop/songs/a/file")
        XCTAssertEqual(job.info.kind, "proxy")
        XCTAssertEqual(job.request.value(forHTTPHeaderField: "X-SoundReel-Key"), "sr_test_key_0123456789abcdef")
        XCTAssertEqual(job.request.value(forHTTPHeaderField: "X-SoundReel-User"), "mike")
    }

    func testMediaServerFailureFallsBackToTheProxyExactlyOnce() throws {
        let r = try rig()
        r.engine.enqueue([TestSupport.track("a", mediaUrl: media + "a.mp3")], home: true)
        let media1 = r.transport.started[0].info

        r.fail(media1, message: "server non raggiungibile", requestURL: URL(string: media + "a.mp3"))   // e.g. Local Network denied

        XCTAssertEqual(r.transport.started.count, 2)
        let retry = r.transport.started[1]
        XCTAssertEqual(retry.info.kind, "proxy")
        XCTAssertEqual(retry.request.url?.absoluteString, "https://soundreel.test/api/mondrop/songs/a/file")
        XCTAssertEqual(retry.request.value(forHTTPHeaderField: "X-SoundReel-Key"), "sr_test_key_0123456789abcdef")
        XCTAssertEqual(r.engine.activeCount, 1, "the fallback keeps the same slot")
        XCTAssertEqual(r.engine.progress["a"], .downloading(nil))

        r.fail(retry.info, message: "timeout")                  // the proxy fails too → real failure, no third try
        XCTAssertEqual(r.transport.started.count, 2)
        XCTAssertEqual(r.engine.progress["a"], .failed("timeout"))
        XCTAssertEqual(r.engine.activeCount, 0)
    }

    func testANon2xxFromTheMediaServerAlsoFallsBack() throws {
        let r = try rig()
        r.engine.enqueue([TestSupport.track("a", mediaUrl: media + "a.mp3")], home: true)
        try r.finish(r.transport.started[0].info, status: 404)

        XCTAssertEqual(r.transport.started.count, 2)
        XCTAssertEqual(r.transport.started[1].info.kind, "proxy")
        XCTAssertTrue(r.store.loadIndex().isEmpty, "an error page must never be installed as a song")
    }

    func testProxyHttpErrorsGetFriendlyMessages() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a", "b", "c"]), home: false)
        try r.finish(r.transport.started[0].info, status: 401)
        try r.finish(r.transport.started[1].info, status: 404)
        try r.finish(r.transport.started[2].info, status: 502)
        XCTAssertEqual(r.engine.progress["a"], .failed("API key non valida: rinnovala in Impostazioni"))
        XCTAssertEqual(r.engine.progress["b"], .failed("file non trovato sul server"))
        XCTAssertEqual(r.engine.progress["c"], .failed("server: HTTP 502"))
    }

    // MARK: Wi-Fi only

    func testWifiOnlyByDefaultAndCellularOnlyWhenTheUserOptsIn() throws {
        let wifi = try rig()
        wifi.engine.enqueue(tracks(["a"]), home: false)
        let request = try XCTUnwrap(wifi.transport.started.first).request
        XCTAssertFalse(request.allowsCellularAccess)
        XCTAssertFalse(request.allowsExpensiveNetworkAccess)

        var cellular = EngineConfig.test
        cellular.allowCellular = true
        let both = try rig(config: cellular)
        both.engine.enqueue(tracks(["a"]), home: false)
        let allowed = try XCTUnwrap(both.transport.started.first).request
        XCTAssertTrue(allowed.allowsCellularAccess)
        XCTAssertTrue(allowed.allowsExpensiveNetworkAccess)
    }

    // MARK: install / failure / resume

    func testFinishedDownloadIsInstalledWithItsMetadata() throws {
        let r = try rig()
        let t = TestSupport.track("bishop briggs::white flag", version: "4096-8", bytes: 4096, title: "White Flag")
        r.engine.enqueue([t], home: false)
        let revision = r.engine.revision

        try r.finish(r.transport.started[0].info, bytes: 4096)

        let item = try XCTUnwrap(r.store.item(songKey: t.songKey))
        XCTAssertEqual(item.title, "White Flag")
        XCTAssertEqual(item.version, "4096-8")
        XCTAssertEqual(item.bytes, 4096)
        XCTAssertEqual(item.coverURL, "https://img.test/bishop briggs::white flag.jpg")
        XCTAssertNotNil(r.store.fileURL(for: item))
        XCTAssertNil(r.engine.progress[t.songKey])
        XCTAssertEqual(r.engine.revision, revision + 1)
        // a second Sync now has nothing to do
        XCTAssertTrue(r.engine.enqueue([t], home: false).download.isEmpty)
    }

    // MARK: empty / wrong-size files (the backend before Phase 1 served 200 + Content-Length: 0)

    func testAnEmptyLocalFileFromTheOldAppIsNotPresentAndGetsReplaced() throws {
        let r = try rig()
        let item = try r.installLocal("a", version: "100-1")             // same version string as the server…
        let file = try XCTUnwrap(r.store.fileURL(for: item))
        try Data().write(to: file)                                       // …but 0 bytes on disk, like the old app left them
        XCTAssertNil(r.store.snapshot(songKey: "a"))

        let plan = r.engine.enqueue([TestSupport.track("a", version: "100-1", bytes: 100)], home: false)

        XCTAssertEqual(plan.download.map(\.songKey), ["a"], "the version string alone is not enough")
        XCTAssertTrue(plan.skipped.isEmpty)
        XCTAssertEqual(r.transport.startedKeys, ["a"])
        try r.finish(r.transport.started[0].info)
        XCTAssertEqual(r.store.snapshot(songKey: "a")?.bytes, 100, "the empty file was replaced by the real one")
    }

    func testALocalFileOfTheWrongSizeIsReplacedEvenWithTheSameVersion() throws {
        let r = try rig()
        try r.installLocal("a", version: "100-1", bytes: 40)             // truncated copy
        let plan = r.engine.enqueue([TestSupport.track("a", version: "100-1", bytes: 100)], home: false)
        XCTAssertEqual(plan.download.map(\.songKey), ["a"])
    }

    func testADownloadOfTheWrongSizeIsNeverRecorded() throws {
        let r = try rig()
        r.engine.enqueue([TestSupport.track("a", bytes: 100)], home: false)
        try r.finish(r.transport.started[0].info, bytes: 50)

        XCTAssertEqual(r.engine.progress["a"], .failed("dimensione diversa dal server (50 invece di 100 byte)"))
        XCTAssertTrue(r.store.loadIndex().isEmpty)
        XCTAssertNil(r.store.fileURL(songKey: "a"))
    }

    func testAMediaServerFileOfTheWrongSizeFallsBackToDownloadPath() throws {
        let r = try rig()
        r.engine.enqueue([TestSupport.track("a", bytes: 100, mediaUrl: media + "a.mp3")], home: true)
        try r.finish(r.transport.started[0].info, bytes: 7)               // stale / partial replica on the media server

        XCTAssertTrue(r.store.loadIndex().isEmpty, "the bad replica is not installed")
        XCTAssertEqual(r.transport.started.count, 2)
        XCTAssertEqual(r.transport.started[1].info.kind, "proxy", "retried via downloadPath")
        XCTAssertNotNil(r.transport.started[1].request.value(forHTTPHeaderField: "X-SoundReel-Key"))

        try r.finish(r.transport.started[1].info)                         // the proxy delivers the right 100 bytes
        XCTAssertEqual(r.store.snapshot(songKey: "a")?.bytes, 100)
        XCTAssertNil(r.engine.progress["a"])
    }

    func testAnUnknownServerSizeStillRequiresANonEmptyFile() throws {
        let r = try rig()
        r.engine.enqueue([TestSupport.track("a", version: nil, bytes: nil)], home: false)
        try r.finish(r.transport.started[0].info, bytes: 321)
        XCTAssertEqual(r.store.snapshot(songKey: "a")?.bytes, 321, "no promised size: any non-empty file is accepted")
    }

    func testEmptyFileIsAFailureNotASong() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a"]), home: false)
        try r.finish(r.transport.started[0].info, bytes: 0)
        XCTAssertEqual(r.engine.progress["a"], .failed("file vuoto"))
        XCTAssertTrue(r.store.loadIndex().isEmpty)
    }

    func testFailureKeepsResumeDataAndRetryUsesIt() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a"]), home: false)
        let first = r.transport.started[0]
        let url = try XCTUnwrap(first.request.url)

        r.fail(first.info, message: "rete non disponibile", resumeData: Data("RESUME".utf8), requestURL: url)
        XCTAssertEqual(r.engine.progress["a"], .failed("rete non disponibile"))
        XCTAssertEqual(r.store.resumeData(songKey: "a", url: url.absoluteString), Data("RESUME".utf8))

        r.engine.retry(songKey: "a")
        XCTAssertEqual(r.transport.started.count, 2)
        XCTAssertEqual(r.transport.started[1].resumeData, Data("RESUME".utf8), "the download continues where it stopped")
        XCTAssertEqual(r.engine.progress["a"], .downloading(nil))

        try r.finish(r.transport.started[1].info)
        XCTAssertNil(r.store.resumeData(songKey: "a", url: url.absoluteString), "resume data is dropped once the file is in")
    }

    func testSyncAgainRetriesAFailedTrack() throws {
        let r = try rig()
        let t = TestSupport.track("a")
        r.engine.enqueue([t], home: false)
        r.fail(r.transport.started[0].info, message: "timeout")
        XCTAssertEqual(r.engine.progress["a"], .failed("timeout"))

        r.engine.enqueue([t], home: false)                      // Sync button again
        XCTAssertEqual(r.transport.started.count, 2)
        XCTAssertEqual(r.engine.progress["a"], .downloading(nil))
    }

    func testProgressIsPublishedPerPercentOnly() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a"]), home: false)
        r.engine.handleProgress(songKey: "a", fraction: 0.404)
        XCTAssertEqual(r.engine.progress["a"], .downloading(0.404))
        r.engine.handleProgress(songKey: "a", fraction: 0.4049)   // same percent → no new value
        XCTAssertEqual(r.engine.progress["a"], .downloading(0.404))
        r.engine.handleProgress(songKey: "a", fraction: 0.41)
        XCTAssertEqual(r.engine.progress["a"], .downloading(0.41))
        r.engine.handleProgress(songKey: "ghost", fraction: 0.5)  // not ours: ignored
        XCTAssertNil(r.engine.progress["ghost"])
    }

    // MARK: cancel + priority

    func testCancelRemovesQueuedAndStopsActiveDownloads() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a", "b", "c"]), home: false)

        r.engine.cancel(songKey: "c")                           // queued
        XCTAssertEqual(r.engine.queuedCount, 0)
        r.engine.cancel(songKey: "a")                           // active
        XCTAssertEqual(r.transport.cancelled, ["a"])
        XCTAssertNil(r.engine.progress["a"])
        r.fail(r.transport.started[0].info, message: "annullato", cancelled: true)   // the transport reports it

        XCTAssertNil(r.engine.progress["a"], "a user cancel is not an error")
        XCTAssertEqual(r.engine.progress["b"], .downloading(nil))
    }

    func testFirstPlayDownloadJumpsTheQueue() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a", "b", "c", "d"]), home: false)       // a, b running; c, d queued
        r.engine.enqueue([TestSupport.track("play-me")], home: false, front: true)

        try r.finish(r.transport.started[0].info)                          // a done → the freed slot goes to play-me, not c
        XCTAssertEqual(r.transport.startedKeys.last, "play-me")
    }

    // MARK: relaunch

    func testQueueAndLiveDownloadsSurviveARelaunch() async throws {
        let first = try rig(persistQueue: true)
        first.engine.enqueue(tracks(["a", "b", "c", "d"]), home: false)    // a, b live; c, d queued
        XCTAssertNotNil(first.store.readQueueData())

        // The app is killed. The background session still holds a and b; the queue is on disk.
        let transport = FakeTransport()
        transport.alive = first.transport.started.map(\.info)
        let second = try rig(persistQueue: true, root: first.root, transport: transport)
        await second.engine.attachExisting()

        XCTAssertEqual(second.engine.activeCount, 2)
        XCTAssertEqual(second.engine.progress["a"], .downloading(nil))
        XCTAssertEqual(second.engine.progress["c"], .queued)
        XCTAssertTrue(transport.started.isEmpty, "a and b keep running in the background session: not restarted")

        // a finishes while the app was away: the file is installed from its JobInfo alone, then c starts.
        try second.finish(first.transport.started[0].info)
        XCTAssertNotNil(second.store.fileURL(songKey: "a"))
        XCTAssertEqual(transport.startedKeys, ["c"])
    }

    func testRestoredQueueSkipsWhatArrivedMeanwhile() async throws {
        let first = try rig(persistQueue: true)
        first.engine.enqueue(tracks(["a", "b", "c"]), home: false)           // c queued
        try first.installLocal("c", version: "100-1")                        // it arrived by another path

        let second = try rig(persistQueue: true, root: first.root)
        await second.engine.attachExisting()
        XCTAssertEqual(second.engine.queuedCount, 0)
    }

    // MARK: callbacks arrive from the transport's queue

    func testTransportCallbacksHopToTheMainActor() async throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a"]), home: false)
        let info = r.transport.started[0].info
        let staged = r.store.stagingURL()
        try Data(repeating: 5, count: 100).write(to: staged)   // the size the manifest promised

        nonisolated(unsafe) let handler = try XCTUnwrap(r.transport.handler)   // called from the transport's own queue, as in the app
        DispatchQueue.global().async {
            handler.transportProgress(songKey: "a", fraction: 0.5)
            handler.transportFinished(info: info, stagedFile: staged, httpStatus: 200)
        }
        for _ in 0..<200 where r.store.fileURL(songKey: "a") == nil {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertNotNil(r.store.fileURL(songKey: "a"))
        XCTAssertNil(r.engine.progress["a"])
    }

    func testNoAddressMeansAFailedRowNotACrash() throws {
        var noBase = EngineConfig.test
        noBase.baseURL = ""
        let r = try rig(config: noBase)
        r.engine.enqueue(tracks(["a"]), home: false)
        XCTAssertTrue(r.transport.started.isEmpty)
        XCTAssertEqual(r.engine.progress["a"], .failed("nessun indirizzo di download"))
    }

    // MARK: transport helpers

    func testJobInfoSurvivesTheTaskDescriptionRoundTrip() {
        let info = JobInfo(songKey: "a::b", title: "T", artist: "A", coverUrl: "https://c", lyrics: "l", version: "1-2", bytes: 3, kind: "media", proxyPath: "/p")
        let task = URLSession(configuration: .ephemeral).downloadTask(with: URL(string: "https://soundreel.test/x")!)
        task.taskDescription = BackgroundDownloadTransport.encode(info)
        XCTAssertEqual(BackgroundDownloadTransport.info(of: task), info)
        task.cancel()
    }

    func testFriendlyNetworkMessages() {
        func message(_ code: Int) -> String {
            BackgroundDownloadTransport.friendlyMessage(for: NSError(domain: NSURLErrorDomain, code: code))
        }
        XCTAssertEqual(message(NSURLErrorNotConnectedToInternet), "rete non disponibile")
        XCTAssertEqual(message(NSURLErrorTimedOut), "timeout")
        XCTAssertEqual(message(NSURLErrorCannotConnectToHost), "server non raggiungibile")
        XCTAssertTrue(message(NSURLErrorDataNotAllowed).contains("Wi-Fi"))
    }
}
