import XCTest
@testable import Mondrop

final class SyncPlannerTests: XCTestCase {
    private func plan(_ tracks: [OfflineTrack], local: [String: LocalSnapshot] = [:], inFlight: Set<String> = []) -> SyncPlan {
        SyncPlanner.plan(tracks: tracks, local: { local[$0] }, inFlight: inFlight)
    }

    private func snapshot(version: String?, bytes: Int? = 100, ext: String = "mp3") -> LocalSnapshot {
        LocalSnapshot(version: version, bytes: bytes, fileExtension: ext)
    }

    // MARK: skip-present

    func testReadyAndMissingLocallyIsDownloaded() {
        let p = plan([TestSupport.track("a")])
        XCTAssertEqual(p.download.map(\.songKey), ["a"])
        XCTAssertTrue(p.skipped.isEmpty)
    }

    func testSameVersionIsSkipped() {
        let p = plan([TestSupport.track("a", version: "10-1")], local: ["a": snapshot(version: "10-1")])
        XCTAssertTrue(p.download.isEmpty)
        XCTAssertEqual(p.skipped, ["a"])
    }

    func testNewServerVersionReplacesTheLocalFile() {
        let p = plan([TestSupport.track("a", version: "20-2")], local: ["a": snapshot(version: "10-1")])
        XCTAssertEqual(p.download.map(\.songKey), ["a"])
    }

    func testOldServerWithoutVersionNeverRedownloads() {
        let p = plan([TestSupport.track("a", state: nil, version: nil, status: "ready")], local: ["a": snapshot(version: "10-1")])
        XCTAssertTrue(p.download.isEmpty)
        XCTAssertEqual(p.skipped, ["a"])
    }

    func testLegacyMp3WithTheSameSizeIsAdoptedNotRedownloaded() {
        let p = plan(
            [TestSupport.track("a", version: "7340032-99", bytes: 7_340_032)],
            local: ["a": snapshot(version: nil, bytes: 7_340_032)]
        )
        XCTAssertTrue(p.download.isEmpty)
        XCTAssertEqual(p.adopt, ["a"])
    }

    func testLegacyFileOfAnotherSizeOrFormatIsReplaced() {
        let differentSize = plan([TestSupport.track("a", version: "5-1", bytes: 5)], local: ["a": snapshot(version: nil, bytes: 999)])
        XCTAssertEqual(differentSize.download.map(\.songKey), ["a"])
        let wav = plan([TestSupport.track("a", version: "5-1", bytes: 5)], local: ["a": snapshot(version: nil, bytes: 5, ext: "wav")])
        XCTAssertEqual(wav.download.map(\.songKey), ["a"], "the manifest is MP3-only: an old wav/mp4 gets replaced")
    }

    // MARK: empty / wrong-size local files (the old backend served 200 + Content-Length: 0)

    func testAnEmptyLocalFileIsNeverPresentEvenWithTheSameVersionString() {
        let p = plan([TestSupport.track("a", version: "100-1", bytes: 100)], local: ["a": snapshot(version: "100-1", bytes: 0)])
        XCTAssertEqual(p.download.map(\.songKey), ["a"])
        XCTAssertTrue(p.skipped.isEmpty)
        XCTAssertTrue(p.adopt.isEmpty)
    }

    func testAnEmptyLegacyFileIsNeverAdopted() {
        let p = plan([TestSupport.track("a", version: "0-1", bytes: 0)], local: ["a": snapshot(version: nil, bytes: 0)])
        XCTAssertEqual(p.download.map(\.songKey), ["a"])
        XCTAssertTrue(p.adopt.isEmpty)
    }

    func testTheVersionStringAloneIsNotEnough() {
        let p = plan([TestSupport.track("a", version: "100-1", bytes: 100)], local: ["a": snapshot(version: "100-1", bytes: 40)])
        XCTAssertEqual(p.download.map(\.songKey), ["a"], "same version but a truncated file")
        let same = plan([TestSupport.track("a", version: "100-1", bytes: 100)], local: ["a": snapshot(version: "100-1", bytes: 100)])
        XCTAssertEqual(same.skipped, ["a"])
    }

    func testOldServerWithoutVersionOrSizeKeepsANonEmptyFileButNotAnEmptyOne() {
        let old = TestSupport.track("a", state: nil, version: nil, bytes: nil, status: "ready")
        XCTAssertEqual(plan([old], local: ["a": snapshot(version: nil, bytes: 10)]).skipped, ["a"])
        XCTAssertEqual(plan([old], local: ["a": snapshot(version: nil, bytes: 0)]).download.map(\.songKey), ["a"])
    }

    func testVersionMatchWithUnknownServerSizeIsSkippedWhenNonEmpty() {
        let p = plan([TestSupport.track("a", version: "100-1", bytes: nil)], local: ["a": snapshot(version: "100-1", bytes: 10)])
        XCTAssertEqual(p.skipped, ["a"])
    }

    func testLegacyFileCannotBeAdoptedWhenTheServerSizeIsUnknown() {
        let p = plan([TestSupport.track("a", version: "5-1", bytes: nil)], local: ["a": snapshot(version: nil, bytes: 5)])
        XCTAssertEqual(p.download.map(\.songKey), ["a"], "nothing to compare the old file against")
    }

    func testOneFileServesManyPlaylists() {
        // the same songKey twice in the manifest (or already local from another playlist) → at most once
        let twice = plan([TestSupport.track("a"), TestSupport.track("a")])
        XCTAssertEqual(twice.download.count, 1)
    }

    func testInFlightIsNotQueuedAgain() {
        let p = plan([TestSupport.track("a"), TestSupport.track("b")], inFlight: ["a"])
        XCTAssertEqual(p.download.map(\.songKey), ["b"])
        XCTAssertEqual(p.inFlight, ["a"])
    }

    // MARK: server states

    func testOnlyReadyTracksAreEverDownloaded() {
        let p = plan([
            TestSupport.track("ready"),
            TestSupport.track("prep", state: "preparing"),
            TestSupport.track("fail", state: "failed", error: "x"),
            TestSupport.track("nosrc", state: "no_source"),
            TestSupport.track("miss", state: "missing"),
        ])
        XCTAssertEqual(p.download.map(\.songKey), ["ready"])
        XCTAssertEqual(p.preparing, ["prep"])
        XCTAssertEqual(p.failed, ["fail"])
        XCTAssertEqual(p.noSource, ["nosrc"])
        XCTAssertEqual(p.missing, ["miss"])
    }
}

final class DownloadURLChooserTests: XCTestCase {
    private let base = "https://soundreel.test"
    private let media = "http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/a.mp3"

    func testAtHomeMediaServerComesFirstThenTheProxy() {
        let t = TestSupport.track("a", mediaUrl: media)
        let c = DownloadURLChooser.candidates(for: t, home: true, baseURL: base)
        XCTAssertEqual(c.map(\.kind), [.media, .proxy])
        XCTAssertEqual(c[0].url.absoluteString, media)
        XCTAssertEqual(c[1].url.absoluteString, "https://soundreel.test/api/mondrop/songs/a/file")
    }

    func testAwayFromHomeOnlyTheProxy() {
        let t = TestSupport.track("a", mediaUrl: media)
        let c = DownloadURLChooser.candidates(for: t, home: false, baseURL: base)
        XCTAssertEqual(c.map(\.kind), [.proxy])
    }

    func testNoMediaUrlMeansProxyEvenAtHome() {
        let c = DownloadURLChooser.candidates(for: TestSupport.track("a"), home: true, baseURL: base)
        XCTAssertEqual(c.map(\.kind), [.proxy])
    }

    func testTheApiKeyNeverGoesToTheMediaServer() {
        let c = DownloadURLChooser.candidates(for: TestSupport.track("a", mediaUrl: media), home: true, baseURL: base)
        XCTAssertFalse(c[0].sendsAuth)
        XCTAssertTrue(c[1].sendsAuth)
    }

    func testNonHttpMediaUrlsAreIgnored() {
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "ftp://192.168.178.10/a.mp3", "not a url", "", "http://"] {
            let c = DownloadURLChooser.candidates(for: TestSupport.track("a", mediaUrl: bad), home: true, baseURL: base)
            XCTAssertEqual(c.map(\.kind), [.proxy], "mediaUrl \(bad.debugDescription) must be ignored")
        }
    }

    func testAbsoluteDownloadPathIsNeverFollowedWithTheKey() {
        // A path with a host in it would make the app hand its API key to that host.
        let evil = TestSupport.track("a", downloadPath: "https://evil.example/steal")
        let c = DownloadURLChooser.candidates(for: evil, home: false, baseURL: base)
        XCTAssertEqual(c.count, 1)
        XCTAssertEqual(c[0].url.host, "soundreel.test")
        XCTAssertEqual(c[0].url.path, "/api/mondrop/songs/a/file")
        let protocolRelative = TestSupport.track("a", downloadPath: "//evil.example/x")
        XCTAssertEqual(DownloadURLChooser.candidates(for: protocolRelative, home: false, baseURL: base)[0].url.host, "soundreel.test")
    }

    func testBaseUrlTrailingSlashAndRelativePathAreNormalised() {
        let t = TestSupport.track("a", downloadPath: "api/mondrop/songs/a/file")
        let c = DownloadURLChooser.candidates(for: t, home: false, baseURL: "https://soundreel.test/")
        XCTAssertEqual(c[0].url.absoluteString, "https://soundreel.test/api/mondrop/songs/a/file")
    }

    func testMissingDownloadPathFallsBackToTheCanonicalOne() {
        let t = OfflineTrack(songKey: "bishop briggs::white flag", state: "ready")
        let c = DownloadURLChooser.candidates(for: t, home: false, baseURL: base)
        XCTAssertEqual(c[0].url.absoluteString, "https://soundreel.test/api/mondrop/songs/bishop%20briggs%3A%3Awhite%20flag/file")
    }

    func testNoBaseUrlNoProxy() {
        XCTAssertTrue(DownloadURLChooser.candidates(for: TestSupport.track("a"), home: false, baseURL: " / ").isEmpty)
    }
}

final class TrackRowStatusTests: XCTestCase {
    func testDeviceProgressWinsOverEverything() {
        let t = TestSupport.track("a", state: "preparing")
        XCTAssertEqual(TrackRowStatus.make(track: t, isLocal: true, progress: .downloading(0.4)).label, "scarico 40 %")
        XCTAssertEqual(TrackRowStatus.make(track: t, isLocal: false, progress: .downloading(nil)).label, "scarico…")
        XCTAssertEqual(TrackRowStatus.make(track: t, isLocal: false, progress: .queued).label, "in coda")
        let failed = TrackRowStatus.make(track: t, isLocal: false, progress: .failed("timeout"))
        XCTAssertEqual(failed.label, "errore: timeout")
        XCTAssertTrue(failed.canRetry)
    }

    func testLocalMeansScaricato() {
        let s = TrackRowStatus.make(track: TestSupport.track("a", state: "missing"), isLocal: true, progress: nil)
        XCTAssertEqual(s.kind, .local)
        XCTAssertEqual(s.label, "scaricato")
    }

    func testServerStatesWhenNotLocal() {
        func status(_ state: String, error: String? = nil) -> TrackRowStatus {
            TrackRowStatus.make(track: TestSupport.track("a", state: state, error: error), isLocal: false, progress: nil)
        }
        XCTAssertEqual(status("ready").kind, .readyOnServer)
        XCTAssertEqual(status("preparing").label, "preparo sul server…")
        XCTAssertEqual(status("missing").label, "da preparare")

        let failed = status("failed", error: "HTTP Error 403")
        XCTAssertEqual(failed.label, "errore server: HTTP Error 403")
        XCTAssertTrue(failed.canRetry)
        XCTAssertTrue(failed.canSetSource)

        let none = status("no_source")
        XCTAssertEqual(none.label, "nessuna sorgente trovata")
        XCTAssertTrue(none.canSetSource, "no_source offers the YouTube link")
        XCTAssertTrue(none.canRetry, "…and a plain retry (prepare with retryFailed searches again)")
    }

    func testPlaybackStatusLine() {
        XCTAssertNil(PlaybackStatusText.make(status: .idle, progress: nil))
        XCTAssertEqual(PlaybackStatusText.make(status: .preparing, progress: nil)?.text, "Preparo il brano…")
        XCTAssertEqual(PlaybackStatusText.make(status: .local, progress: nil)?.text, "Dal telefono")
        XCTAssertEqual(PlaybackStatusText.make(status: .streaming, progress: nil)?.text, "In streaming")
        XCTAssertEqual(PlaybackStatusText.make(status: .streaming, progress: .downloading(0.25))?.text, "In streaming · scarico 25 %")
        XCTAssertEqual(PlaybackStatusText.make(status: .streaming, progress: .queued)?.text, "In streaming · download in coda")
        let failed = PlaybackStatusText.make(status: .failed("nessuna sorgente"), progress: nil)
        XCTAssertEqual(failed?.text, "nessuna sorgente")
        XCTAssertEqual(failed?.isError, true)
    }
}
