import XCTest
@testable import Mondrop

@MainActor
final class SyncEngineTests: XCTestCase {
    private func rig(config: EngineConfig = .test, persistQueue: Bool = false, root: URL? = nil, transport: FakeTransport = FakeTransport()) throws -> EngineRig {
        let r = try EngineRig(maxParallel: 2, config: config, persistQueue: persistQueue, root: root, transport: transport)
        let dir = r.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return r
    }

    private func tracks(_ keys: [String]) -> [OfflineTrack] { keys.map { TestSupport.track($0) } }

    // MARK: parallelism

    func testNeverMoreThanTwoDownloadsAtOnce() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a", "b", "c", "d", "e"]))

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
        r.engine.enqueue(list)
        let plan = r.engine.enqueue(list)          // user taps Sync again mid-flight

        XCTAssertTrue(plan.download.isEmpty)
        XCTAssertEqual(r.transport.started.count, 2, "no duplicate task for a/b")
        XCTAssertEqual(r.engine.queuedCount, 1, "c is queued once")
        XCTAssertEqual(Set(plan.inFlight), ["a", "b", "c"])
    }

    func testPresentWithSameVersionIsSkippedAndNeverTouched() throws {
        let r = try rig()
        try r.installLocal("a", version: "100-1")
        let plan = r.engine.enqueue([TestSupport.track("a", version: "100-1"), TestSupport.track("b")])

        XCTAssertEqual(r.transport.startedKeys, ["b"])
        XCTAssertEqual(plan.skipped, ["a"])
        XCTAssertNil(r.engine.progress["a"])
    }

    func testNewServerVersionIsDownloadedAgain() throws {
        let r = try rig()
        try r.installLocal("a", version: "100-1")
        r.engine.enqueue([TestSupport.track("a", version: "200-2")])
        XCTAssertEqual(r.transport.startedKeys, ["a"])
    }

    func testLegacyFileWithTheSameSizeIsAdoptedWithoutDownloading() throws {
        let r = try rig()
        try r.installLocal("a", version: nil, bytes: 700)
        r.engine.enqueue([TestSupport.track("a", version: "700-9", bytes: 700)])

        XCTAssertTrue(r.transport.started.isEmpty)
        XCTAssertEqual(r.store.snapshot(songKey: "a")?.version, "700-9", "the version is remembered for next time")
    }

    // MARK: URL + auth: SoundReel only (rule P, ADR-0018)

    func testEveryDownloadGoesToSoundReelWithTheKey() throws {
        let r = try rig()
        r.engine.enqueue([TestSupport.track("a")])

        let job = try XCTUnwrap(r.transport.started.first)
        XCTAssertEqual(job.request.url?.absoluteString, "https://soundreel.test/api/mondrop/songs/a/file")
        XCTAssertEqual(job.request.value(forHTTPHeaderField: "X-SoundReel-Key"), "sr_test_key_0123456789abcdef")
        XCTAssertEqual(job.request.value(forHTTPHeaderField: "X-SoundReel-User"), "mike")
    }

    /// A server older than 2.13.0 still sends the address of a media-server file in the manifest. The engine never reads it.
    func testTheAddressOfAStoreFileInTheManifestIsNeverDownloadedFrom() throws {
        let r = try rig()
        r.engine.enqueue([try TestSupport.trackFromAnOlderServer("a")])

        XCTAssertEqual(r.transport.started.count, 1)
        let job = try XCTUnwrap(r.transport.started.first)
        XCTAssertEqual(job.request.url?.absoluteString, "https://soundreel.test/api/mondrop/songs/a/file")
        XCTAssertNotNil(job.request.value(forHTTPHeaderField: "X-SoundReel-Key"))
        XCTAssertFalse(job.request.url?.absoluteString.contains("192.168.") ?? true)
    }

    func testTheKeyNeverGoesToAnotherHostEvenIfDownloadPathNamesOne() throws {
        let r = try rig()
        r.engine.enqueue([TestSupport.track("a", downloadPath: TestSupport.storeAddress), TestSupport.track("b", downloadPath: "https://evil.example/steal")])

        XCTAssertEqual(r.transport.started.count, 2)
        for job in r.transport.started { XCTAssertEqual(job.request.url?.host, "soundreel.test") }
    }

    func testAFailedDownloadIsAFailureWithNoSecondAddress() throws {
        let r = try rig()
        r.engine.enqueue([try TestSupport.trackFromAnOlderServer("a")])
        r.fail(r.transport.started[0].info, message: "server non raggiungibile")   // e.g. the Local Network permission denied

        XCTAssertEqual(r.transport.started.count, 1, "there is nothing else to try")
        XCTAssertEqual(r.engine.progress["a"], .failed("server non raggiungibile"))
        XCTAssertEqual(r.engine.activeCount, 0)
    }

    func testANon2xxIsAFailureAndNeverInstalledAsASong() throws {
        let r = try rig()
        r.engine.enqueue([try TestSupport.trackFromAnOlderServer("a")])
        try r.finish(r.transport.started[0].info, status: 404)

        XCTAssertEqual(r.transport.started.count, 1)
        XCTAssertEqual(r.engine.progress["a"], .failed("file non trovato sul server"))
        XCTAssertTrue(r.store.loadIndex().isEmpty, "an error page must never be installed as a song")
    }

    // MARK: what the previous build (1.6.0) left on the phone

    private func oldQueuedJob(_ key: String) -> String {
        #"{"home":true,"track":{"songKey":"\#(key)","title":"\#(key)","artist":"X","state":"ready","downloadPath":"/api/mondrop/songs/\#(key)/file","mediaUrl":"http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/\#(key).mp3","version":"100-1","bytes":100}}"#
    }

    /// 1.6.0 wrote one flag per queued job (where the phone was) and the media-server address inside each track.
    func testAQueueWrittenByTheOldAppStillLoadsAndRunsFromSoundReel() async throws {
        let r = try rig(persistQueue: true)
        r.store.writeQueueData(Data(("[" + ["a", "b", "c"].map(oldQueuedJob).joined(separator: ",") + "]").utf8))

        await r.engine.attachExisting()

        XCTAssertEqual(r.transport.startedKeys, ["a", "b"], "the queue loads: two run, one waits")
        XCTAssertEqual(r.engine.queuedCount, 1)
        for job in r.transport.started {
            XCTAssertEqual(job.request.url?.host, "soundreel.test", "every job runs from SoundReel")
            XCTAssertTrue(job.request.url?.path.hasSuffix("/file") ?? false)
            XCTAssertNotNil(job.request.value(forHTTPHeaderField: "X-SoundReel-Key"))
        }
        // what it writes back for the one still waiting is the new shape: no flag, no address
        let written = String(decoding: try XCTUnwrap(r.store.readQueueData()), as: UTF8.self)
        XCTAssertTrue(written.contains("\"c\""))
        XCTAssertFalse(written.contains("home"))
        XCTAssertFalse(written.contains("mediaUrl"))
        XCTAssertFalse(written.contains("192.168."))
    }

    /// A background download 1.6.0 started at a media-server address is still alive after the upgrade; if it fails it is a plain
    /// failure (its description says `kind: media` and has a `proxyPath`, both ignored): no second attempt at any other address.
    func testAnOldDownloadStillRunningThatFailsIsAPlainFailure() async throws {
        let oldDescription = #"{"songKey":"a","title":"A","artist":"X","kind":"media","proxyPath":"/api/mondrop/songs/a/file","bytes":100}"#
        let info = try JSONDecoder().decode(JobInfo.self, from: Data(oldDescription.utf8))
        let transport = FakeTransport()
        transport.alive = [info]
        let r = try rig(transport: transport)
        await r.engine.attachExisting()
        XCTAssertEqual(r.engine.progress["a"], .downloading(nil))

        r.fail(info, message: "server non raggiungibile")

        XCTAssertTrue(transport.started.isEmpty, "no second attempt: the row says why and «Riprova» starts again from SoundReel")
        XCTAssertEqual(r.engine.progress["a"], .failed("server non raggiungibile"))
    }

    func testProxyHttpErrorsGetFriendlyMessages() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a", "b", "c"]))
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
        wifi.engine.enqueue(tracks(["a"]))
        let request = try XCTUnwrap(wifi.transport.started.first).request
        XCTAssertFalse(request.allowsCellularAccess)
        XCTAssertFalse(request.allowsExpensiveNetworkAccess)

        var cellular = EngineConfig.test
        cellular.allowCellular = true
        let both = try rig(config: cellular)
        both.engine.enqueue(tracks(["a"]))
        let allowed = try XCTUnwrap(both.transport.started.first).request
        XCTAssertTrue(allowed.allowsCellularAccess)
        XCTAssertTrue(allowed.allowsExpensiveNetworkAccess)
    }

    // MARK: install / failure / resume

    func testFinishedDownloadIsInstalledWithItsMetadata() throws {
        let r = try rig()
        let t = TestSupport.track("bishop briggs::white flag", version: "4096-8", bytes: 4096, title: "White Flag")
        r.engine.enqueue([t])
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
        XCTAssertTrue(r.engine.enqueue([t]).download.isEmpty)
    }

    // MARK: empty / wrong-size files (the backend before Phase 1 served 200 + Content-Length: 0)

    func testAnEmptyLocalFileFromTheOldAppIsNotPresentAndGetsReplaced() throws {
        let r = try rig()
        let item = try r.installLocal("a", version: "100-1")             // same version string as the server…
        let file = try XCTUnwrap(r.store.fileURL(for: item))
        try Data().write(to: file)                                       // …but 0 bytes on disk, like the old app left them
        XCTAssertNil(r.store.snapshot(songKey: "a"))

        let plan = r.engine.enqueue([TestSupport.track("a", version: "100-1", bytes: 100)])

        XCTAssertEqual(plan.download.map(\.songKey), ["a"], "the version string alone is not enough")
        XCTAssertTrue(plan.skipped.isEmpty)
        XCTAssertEqual(r.transport.startedKeys, ["a"])
        try r.finish(r.transport.started[0].info)
        XCTAssertEqual(r.store.snapshot(songKey: "a")?.bytes, 100, "the empty file was replaced by the real one")
    }

    func testALocalFileOfTheWrongSizeIsReplacedEvenWithTheSameVersion() throws {
        let r = try rig()
        try r.installLocal("a", version: "100-1", bytes: 40)             // truncated copy
        let plan = r.engine.enqueue([TestSupport.track("a", version: "100-1", bytes: 100)])
        XCTAssertEqual(plan.download.map(\.songKey), ["a"])
    }

    func testADownloadOfTheWrongSizeIsNeverRecorded() throws {
        let r = try rig()
        r.engine.enqueue([TestSupport.track("a", bytes: 100)])
        try r.finish(r.transport.started[0].info, bytes: 50)

        XCTAssertEqual(r.engine.progress["a"], .failed("dimensione diversa dal server (50 invece di 100 byte)"))
        XCTAssertTrue(r.store.loadIndex().isEmpty)
        XCTAssertNil(r.store.fileURL(songKey: "a"))
    }

    func testAnUnknownServerSizeStillRequiresANonEmptyFile() throws {
        let r = try rig()
        r.engine.enqueue([TestSupport.track("a", version: nil, bytes: nil)])
        try r.finish(r.transport.started[0].info, bytes: 321)
        XCTAssertEqual(r.store.snapshot(songKey: "a")?.bytes, 321, "no promised size: any non-empty file is accepted")
    }

    func testEmptyFileIsAFailureNotASong() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a"]))
        try r.finish(r.transport.started[0].info, bytes: 0)
        XCTAssertEqual(r.engine.progress["a"], .failed("file vuoto"))
        XCTAssertTrue(r.store.loadIndex().isEmpty)
    }

    func testFailureKeepsResumeDataAndRetryUsesIt() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a"]))
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
        r.engine.enqueue([t])
        r.fail(r.transport.started[0].info, message: "timeout")
        XCTAssertEqual(r.engine.progress["a"], .failed("timeout"))

        r.engine.enqueue([t])                      // Sync button again
        XCTAssertEqual(r.transport.started.count, 2)
        XCTAssertEqual(r.engine.progress["a"], .downloading(nil))
    }

    func testProgressIsPublishedPerPercentOnly() throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a"]))
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
        r.engine.enqueue(tracks(["a", "b", "c"]))

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
        r.engine.enqueue(tracks(["a", "b", "c", "d"]))       // a, b running; c, d queued
        r.engine.enqueue([TestSupport.track("play-me")], front: true)

        try r.finish(r.transport.started[0].info)                          // a done → the freed slot goes to play-me, not c
        XCTAssertEqual(r.transport.startedKeys.last, "play-me")
    }

    // MARK: relaunch

    func testQueueAndLiveDownloadsSurviveARelaunch() async throws {
        let first = try rig(persistQueue: true)
        first.engine.enqueue(tracks(["a", "b", "c", "d"]))    // a, b live; c, d queued
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
        first.engine.enqueue(tracks(["a", "b", "c"]))           // c queued
        try first.installLocal("c", version: "100-1")                        // it arrived by another path

        let second = try rig(persistQueue: true, root: first.root)
        await second.engine.attachExisting()
        XCTAssertEqual(second.engine.queuedCount, 0)
    }

    // MARK: callbacks arrive from the transport's queue

    func testTransportCallbacksHopToTheMainActor() async throws {
        let r = try rig()
        r.engine.enqueue(tracks(["a"]))
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
        r.engine.enqueue(tracks(["a"]))
        XCTAssertTrue(r.transport.started.isEmpty)
        XCTAssertEqual(r.engine.progress["a"], .failed("nessun indirizzo di download"))
    }

    // MARK: transport helpers

    func testJobInfoSurvivesTheTaskDescriptionRoundTrip() {
        let info = JobInfo(songKey: "a::b", title: "T", artist: "A", coverUrl: "https://c", lyrics: "l", version: "1-2", bytes: 3)
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
