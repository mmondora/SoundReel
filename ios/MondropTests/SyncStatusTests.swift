import XCTest
@testable import Mondrop

/// «Quando avviene il download voglio vedere lo spinner sulla singola canzone in download e comunque vanno notificati
/// gli stati e che cosa sta succedendo.» — what a row shows, and the line at the top.
final class TrackRowPresentationTests: XCTestCase {
    private func row(_ state: String? = "ready", isLocal: Bool = false, progress: TrackProgress? = nil, skipped: Bool = false, error: String? = nil) -> TrackRowStatus {
        TrackRowStatus.make(track: TestSupport.track("a", state: state, error: error), isLocal: isLocal, progress: progress, isSkipListed: skipped)
    }

    // MARK: the spinner

    func testASongTheServerIsPreparingHasASpinnerAndNoPercent() {
        let s = row("preparing")
        XCTAssertEqual(s.accessory, .spinner)
        XCTAssertTrue(s.isBusy)
        XCTAssertNil(s.percent)
        XCTAssertEqual(s.rowText, "preparo sul server…")
    }

    func testASongThePhoneIsDownloadingHasASpinnerAndThePercent() {
        let s = row(progress: .downloading(0.42))
        XCTAssertEqual(s.accessory, .spinner)
        XCTAssertTrue(s.isBusy)
        XCTAssertEqual(s.percent, 42)
        XCTAssertEqual(s.rowText, "scarico 42 %")
    }

    func testTheSpinnerWithoutASizeYetHasNoPercent() {
        let s = row(progress: .downloading(nil))
        XCTAssertEqual(s.accessory, .spinner)
        XCTAssertNil(s.percent)
        XCTAssertEqual(s.rowText, "scarico…")
    }

    func testThePercentIsRoundedAndKeptInsideZeroToOneHundred() {
        XCTAssertEqual(row(progress: .downloading(0.005)).percent, 1)
        XCTAssertEqual(row(progress: .downloading(0.994)).percent, 99)
        XCTAssertEqual(row(progress: .downloading(1.0)).percent, 100)
        XCTAssertEqual(row(progress: .downloading(1.7)).percent, 100)
        XCTAssertEqual(row(progress: .downloading(-0.2)).percent, 0)
        XCTAssertEqual(row(progress: .downloading(0)).percent, 0)
    }

    func testOnlyTheTwoWorkingStatesTurnTheSpinner() {
        let states: [(TrackRowStatus, TrackRowStatus.Accessory)] = [
            (row("preparing"), .spinner),
            (row(progress: .downloading(0.1)), .spinner),
            (row(progress: .queued), .queued),
            (row(isLocal: true), .done),
            (row("ready"), .cloud),
            (row("missing"), .pending),
            (row("no_source"), .search),
            (row("failed", error: "x"), .error),
            (row(progress: .failed("timeout")), .error),
            (row("ready", skipped: true), .removed),
        ]
        for (status, accessory) in states {
            XCTAssertEqual(status.accessory, accessory, status.label)
            XCTAssertEqual(status.isBusy, accessory == .spinner, status.label)
        }
    }

    // MARK: a ready mark, and the words for the rest

    func testWhenItIsOnThePhoneTheReadyMark() {
        let s = row("missing", isLocal: true)
        XCTAssertEqual(s.accessory, .done)
        XCTAssertEqual(s.rowText, "scaricato")
        XCTAssertNil(s.percent)
    }

    func testWhenDoneTheSpinnerGivesWayToTheMark() {
        // the engine drops its progress entry the moment the file is installed
        XCTAssertEqual(row(progress: .downloading(0.99)).accessory, .spinner)
        XCTAssertEqual(row(isLocal: true, progress: nil).accessory, .done)
    }

    func testInCoda() {
        let s = row(progress: .queued)
        XCTAssertEqual(s.accessory, .queued)
        XCTAssertEqual(s.rowText, "in coda")
    }

    func testDaCercareIsTheWordForNoSourceAndItExplainsWhy() {
        let s = row("no_source")
        XCTAssertEqual(s.accessory, .search)
        XCTAssertTrue(s.rowText.hasPrefix("da cercare"), s.rowText)
        XCTAssertEqual(s.rowText, "da cercare · nessuna sorgente trovata")
        XCTAssertTrue(s.canRetry && s.canSetSource, "…and it can be asked again or given a YouTube link")
    }

    func testAnErrorSaysWhy() {
        XCTAssertEqual(row("failed", error: "HTTP Error 403").rowText, "errore server: HTTP Error 403")
        XCTAssertEqual(row(progress: .failed("timeout")).rowText, "errore: timeout")
        XCTAssertEqual(row(progress: .failed("timeout")).accessory, .error)
    }

    func testTheOtherWordsAreUnchanged() {
        XCTAssertEqual(row("ready").rowText, "pronto da scaricare")
        XCTAssertEqual(row("missing").rowText, "da preparare")
        XCTAssertEqual(row("ready", skipped: true).rowText, "rimossa dal telefono")
    }

    func testTheDeviceDownloadWinsOverWhatTheServerSays() {
        // a stale `preparing` manifest while the file is already coming down
        XCTAssertEqual(row("preparing", progress: .downloading(0.5)).percent, 50)
    }

    /// A queue item that exists only on the phone (no server track) is a song that is simply there.
    func testALocalOnlySongIsReadyToo() {
        let placeholder = OfflineTrack(songKey: "k", title: "T", artist: "A")
        let s = TrackRowStatus.make(track: placeholder, isLocal: true, progress: nil)
        XCTAssertEqual(s.accessory, .done)
    }
}

final class SyncStatusLineTests: XCTestCase {
    func testNothingGoingOnMeansNoLine() {
        XCTAssertNil(SyncStatusLine.make(SyncStatusCounts()))
    }

    func testTheExampleOfTheSpec() {
        XCTAssertEqual(
            SyncStatusLine.make(SyncStatusCounts(preparingOnServer: 3, downloading: 1)),
            "Preparo 3 brani sul server · 1 in download dal telefono"
        )
    }

    func testSingularAndPlural() {
        XCTAssertEqual(SyncStatusLine.make(SyncStatusCounts(preparingOnServer: 1)), "Preparo 1 brano sul server")
        XCTAssertEqual(SyncStatusLine.make(SyncStatusCounts(preparingOnServer: 2)), "Preparo 2 brani sul server")
        XCTAssertEqual(SyncStatusLine.make(SyncStatusCounts(failed: 1)), "1 errore")
        XCTAssertEqual(SyncStatusLine.make(SyncStatusCounts(failed: 4)), "4 errori")
    }

    func testEachPartAlone() {
        XCTAssertEqual(SyncStatusLine.make(SyncStatusCounts(downloading: 2)), "2 in download dal telefono")
        XCTAssertEqual(SyncStatusLine.make(SyncStatusCounts(queued: 5)), "5 in coda")
    }

    func testEverythingAtOnceInAFixedOrder() {
        XCTAssertEqual(
            SyncStatusLine.make(SyncStatusCounts(preparingOnServer: 3, downloading: 2, queued: 7, failed: 1)),
            "Preparo 3 brani sul server · 2 in download dal telefono · 7 in coda · 1 errore"
        )
    }

    func testWaitingForWifiIsSaidFirstAndOnlyWhenSomethingWaits() {
        XCTAssertEqual(
            SyncStatusLine.make(SyncStatusCounts(downloading: 2, queued: 1, waitingForWifi: true)),
            "In attesa del Wi-Fi · 2 in download dal telefono · 1 in coda"
        )
        XCTAssertNil(SyncStatusLine.make(SyncStatusCounts(waitingForWifi: true)), "no download, nothing to wait for")
        XCTAssertEqual(
            SyncStatusLine.make(SyncStatusCounts(preparingOnServer: 1, waitingForWifi: true)),
            "Preparo 1 brano sul server", "the server prepares whatever the network"
        )
    }

    func testOnlyRealWorkTurnsTheSpinner() {
        XCTAssertTrue(SyncStatusCounts(preparingOnServer: 1).isWorking)
        XCTAssertTrue(SyncStatusCounts(downloading: 1).isWorking)
        XCTAssertFalse(SyncStatusCounts(queued: 4).isWorking, "waiting is not working")
        XCTAssertFalse(SyncStatusCounts(failed: 2).isWorking, "an error is not progress")
        XCTAssertFalse(SyncStatusCounts().isWorking)
    }

    func testCountsComeFromTheEngineProgress() {
        let progress: [String: TrackProgress] = [
            "a": .downloading(0.3), "b": .downloading(nil), "c": .queued, "d": .queued, "e": .queued, "f": .failed("timeout"),
        ]
        let counts = SyncStatusCounts(progress: progress, preparingOnServer: 3)
        XCTAssertEqual(counts, SyncStatusCounts(preparingOnServer: 3, downloading: 2, queued: 3, failed: 1))
        XCTAssertEqual(
            SyncStatusLine.make(counts),
            "Preparo 3 brani sul server · 2 in download dal telefono · 3 in coda · 1 errore"
        )
    }
}

@MainActor
final class SyncActivityTests: XCTestCase {
    private final class Time: @unchecked Sendable {
        var now = Date(timeIntervalSince1970: 1_000_000)
    }

    private func activity(_ time: Time, maxAge: TimeInterval = 120) -> SyncActivity {
        SyncActivity(now: { time.now }, maxAge: maxAge)
    }

    func testItNotesWhatTheServerIsPreparingAndForgetsWhatIsNot() {
        let time = Time()
        let a = activity(time)
        a.observe([TestSupport.track("x", state: "preparing"), TestSupport.track("y", state: "preparing"), TestSupport.track("z")])
        XCTAssertEqual(a.preparingCount(), 2)
        a.observe([TestSupport.track("x"), TestSupport.track("y", state: "preparing")])
        XCTAssertEqual(a.preparingCount(), 1, "x turned ready")
        a.observe([TestSupport.track("y", state: "failed")])
        XCTAssertEqual(a.preparingCount(), 0)
    }

    func testASongNoLongerWatchedStopsCounting() {
        let time = Time()
        let a = activity(time, maxAge: 120)
        a.observe([TestSupport.track("x", state: "preparing")])
        time.now.addTimeInterval(119)
        XCTAssertEqual(a.preparingCount(), 1)
        time.now.addTimeInterval(2)
        XCTAssertEqual(a.preparingCount(), 0, "a sighting older than the limit is not shown as «Preparo»")
    }

    func testLookingAgainRenewsTheSighting() {
        let time = Time()
        let a = activity(time, maxAge: 120)
        a.observe([TestSupport.track("x", state: "preparing")])
        time.now.addTimeInterval(100)
        a.observe([TestSupport.track("x", state: "preparing")])
        time.now.addTimeInterval(100)
        XCTAssertEqual(a.preparingCount(), 1)
    }

    func testTheSongTheUserWaitsForCounts() {
        let time = Time()
        let a = activity(time)
        a.markPreparing("first-play")
        XCTAssertEqual(a.preparingCount(), 1)
        a.clear("first-play")
        XCTAssertEqual(a.preparingCount(), 0)
        a.clear("never-there")
        XCTAssertEqual(a.preparingCount(), 0)
    }

    func testResetForgetsEverything() {
        let a = activity(Time())
        a.observe([TestSupport.track("x", state: "preparing")])
        a.reset()
        XCTAssertEqual(a.preparingCount(), 0)
    }
}
