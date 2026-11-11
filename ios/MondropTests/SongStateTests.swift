import XCTest
@testable import Mondrop

/// «Dentro ogni playlist le canzoni devono avere uno stato ( online, errore, locale )» and «Anche la playlist deve avere un
/// simbolo/icona che dice online/errore/locale» (Michele, 10 November; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md
/// U3, U4, U9). The marks are chosen by pure code: these tables are the rule.
final class SongStateTests: XCTestCase {
    private func status(_ state: String? = "ready", isLocal: Bool = false, progress: TrackProgress? = nil, skipped: Bool = false, error: String? = nil) -> TrackRowStatus {
        TrackRowStatus.make(track: TestSupport.track("a", state: state, error: error), isLocal: isLocal, progress: progress, isSkipListed: skipped)
    }

    // MARK: one song: every state of today lands in exactly one of the three

    func testOnlyASongOnThePhoneIsLocal() {
        XCTAssertEqual(SongState(status(isLocal: true)), .local)
    }

    func testEveryStateThatIsNotLocalAndNotAFailureIsOnline() {
        // «Un brano che il server non ha ancora o un nome che non si risolve è online» (U4): a missing, unprepared or unresolved source is never an error by itself.
        let online: [(String, TrackRowStatus)] = [
            ("ready on the server", status("ready")),
            ("being prepared", status("preparing")),
            ("never asked for", status("missing")),
            ("no source found", status("no_source")),
            ("deleted from this phone", status("ready", skipped: true)),
            ("waiting its turn", status(progress: .queued)),
        ]
        for (name, s) in online {
            XCTAssertEqual(SongState(s), .online(percent: nil), name)
        }
    }

    func testADownloadInProgressIsOnlineAndShowsThePercent() {
        XCTAssertEqual(SongState(status(progress: .downloading(0.42))), .online(percent: 42))
        XCTAssertEqual(SongState(status(progress: .downloading(nil))), .online(percent: nil))
        XCTAssertEqual(SongState(status(progress: .downloading(1.7))), .online(percent: 100))
    }

    func testOnlyARealFailureIsAnError() {
        XCTAssertEqual(SongState(status(progress: .failed("timeout"))), .error("errore: timeout"))
        XCTAssertEqual(SongState(status("failed", error: "yt-dlp")), .error("errore server: yt-dlp"))
        XCTAssertEqual(SongState(status("failed")), .error("errore server"))
    }

    func testAFailureOfTheDownloadBeatsAFileThatIsAlreadyThere() {
        // the engine reports the failure first: the status keeps that order, and so does the state
        XCTAssertEqual(SongState(status(isLocal: true, progress: .failed("boom"))), .error("errore: boom"))
    }

    func testTheThreeStatesHaveTheirWordsForVoiceOverAndTheRow() {
        XCTAssertEqual(SongState.local.accessibilityLabel, "Sul telefono")
        XCTAssertEqual(SongState.online(percent: nil).accessibilityLabel, "Online")
        XCTAssertEqual(SongState.online(percent: 42).accessibilityLabel, "Online, scarico 42 %")
        XCTAssertEqual(SongState.error("errore: x").accessibilityLabel, "Errore")
        XCTAssertEqual(SongState.local.rowText, "sul telefono")
        XCTAssertEqual(SongState.online(percent: nil).rowText, "online")
        XCTAssertEqual(SongState.online(percent: 42).rowText, "online · scarico 42 %")
        XCTAssertEqual(SongState.error("errore: x").rowText, "errore: x")
    }

    func testTheFlagsAgreeWithTheCase() {
        XCTAssertTrue(SongState.local.isLocal)
        XCTAssertFalse(SongState.local.isError)
        XCTAssertFalse(SongState.online(percent: 3).isLocal)
        XCTAssertFalse(SongState.online(percent: 3).isError)
        XCTAssertTrue(SongState.error("x").isError)
        XCTAssertFalse(SongState.error("x").isLocal)
    }

    // MARK: a playlist: one mark, from its songs

    private let local = SongState.local
    private let online = SongState.online(percent: nil)
    private let broken = SongState.error("errore")

    func testAPlaylistWithNoSongsHasNoMark() {
        XCTAssertNil(PlaylistState.make(songs: []))
    }

    func testAPlaylistIsLocalOnlyWhenEverySongIsOnThePhone() {
        XCTAssertEqual(PlaylistState.make(songs: [local]), .local)
        XCTAssertEqual(PlaylistState.make(songs: [local, local, local]), .local)
    }

    func testAPlaylistIsOnlineWhenAnySongIsNotOnThePhoneYetEvenIfSomeAre() {
        XCTAssertEqual(PlaylistState.make(songs: [online]), .online)
        XCTAssertEqual(PlaylistState.make(songs: [local, online]), .online)
        XCTAssertEqual(PlaylistState.make(songs: [online, local, local]), .online)
        XCTAssertEqual(PlaylistState.make(songs: [.online(percent: 40), local]), .online)
    }

    func testOneSongInErrorIsEnoughForTheWholePlaylist() {
        XCTAssertEqual(PlaylistState.make(songs: [broken]), .error)
        XCTAssertEqual(PlaylistState.make(songs: [local, local, broken]), .error)
        XCTAssertEqual(PlaylistState.make(songs: [online, broken, local]), .error)
    }

    func testTheSummarySaysHowManyAreOnThePhone() {
        let summary = PlaylistStateSummary(songs: [local, online, local, broken])
        XCTAssertEqual(summary.state, .error)
        XCTAssertEqual(summary.localCount, 2)
        XCTAssertEqual(summary.total, 4)
        XCTAssertEqual(summary.headerText, "2 di 4 sul telefono")
        XCTAssertEqual(PlaylistStateSummary(songs: [local, local]).headerText, "2 di 2 sul telefono")
        XCTAssertEqual(PlaylistStateSummary(songs: [online]).headerText, "0 di 1 sul telefono")
        XCTAssertNil(PlaylistStateSummary(songs: []).headerText, "an empty playlist says nothing")
        XCTAssertNil(PlaylistStateSummary(songs: []).state)
    }

    // MARK: a playlist the app only knows by its keys (the cards and the rows of the list)

    private func record(_ keys: [String], failed: [String] = []) -> OfflineStore.PlaylistRecord {
        OfflineStore.PlaylistRecord(songKeys: keys, failedKeys: Set(failed))
    }

    func testAPlaylistTheAppHasNotReadYetIsOnlineIfItHasSongsAndNothingIfItHasNone() {
        XCTAssertEqual(PlaylistState.make(songCount: 12, record: nil, local: [], failedOnPhone: []), .online)
        XCTAssertNil(PlaylistState.make(songCount: 0, record: nil, local: [], failedOnPhone: []))
    }

    func testTheKeysAndTheLocalFilesDecideTheMark() {
        let r = record(["a", "b", "c"])
        XCTAssertEqual(PlaylistState.make(songCount: 3, record: r, local: ["a", "b", "c", "z"], failedOnPhone: []), .local)
        XCTAssertEqual(PlaylistState.make(songCount: 3, record: r, local: ["a", "b"], failedOnPhone: []), .online)
        XCTAssertEqual(PlaylistState.make(songCount: 3, record: r, local: [], failedOnPhone: []), .online)
    }

    func testAFailureTheServerReportedOrTheDownloadHadMakesTheMarkAnError() {
        let r = record(["a", "b", "c"], failed: ["b"])
        XCTAssertEqual(PlaylistState.make(songCount: 3, record: r, local: ["a", "c"], failedOnPhone: []), .error, "the server said it failed")
        XCTAssertEqual(PlaylistState.make(songCount: 3, record: record(["a", "b"]), local: ["a"], failedOnPhone: ["b"]), .error, "the download on the phone failed")
        XCTAssertEqual(PlaylistState.make(songCount: 3, record: record(["a", "b"]), local: ["a", "b"], failedOnPhone: ["zzz"]), .local, "a failure of a song that is not in the playlist is not its business")
    }

    func testARecordWithNoKeysIsAnEmptyPlaylistNoMatterWhatTheListSaid() {
        XCTAssertNil(PlaylistState.make(songCount: 5, record: record([]), local: [], failedOnPhone: []))
    }

    func testTheMarksHaveTheSameWordsAsTheSongs() {
        XCTAssertEqual(PlaylistState.local.accessibilityLabel, "Sul telefono")
        XCTAssertEqual(PlaylistState.online.accessibilityLabel, "Online")
        XCTAssertEqual(PlaylistState.error.accessibilityLabel, "Errore")
    }

    // MARK: the marks of a whole list, read once

    @MainActor
    func testTheMarksOfAListComeFromTheRecordsTheFilesAndTheFailedDownloads() throws {
        let rig = try EngineRig()
        rig.store.recordPlaylist(id: "all", name: "All", songKeys: ["a", "b"])
        rig.store.recordPlaylist(id: "some", name: "Some", songKeys: ["a", "c"])
        rig.store.recordPlaylist(id: "bad", name: "Bad", songKeys: ["a", "d"], failedKeys: ["d"])
        rig.store.recordPlaylist(id: "broke", name: "Broke", songKeys: ["a", "e"])
        try rig.installLocal("a", version: "1")
        try rig.installLocal("b", version: "1")
        let marks = PlaylistMarks.current(store: rig.store, progress: ["e": .failed("boom"), "c": .downloading(0.5), "q": .queued])
        XCTAssertEqual(marks.state(id: "all", songCount: 2), .local)
        XCTAssertEqual(marks.state(id: "some", songCount: 2), .online, "«c» is only downloading")
        XCTAssertEqual(marks.state(id: "bad", songCount: 2), .error, "the server failed «d»")
        XCTAssertEqual(marks.state(id: "broke", songCount: 2), .error, "the download of «e» failed on the phone")
        XCTAssertEqual(marks.state(id: "unread", songCount: 9), .online)
        XCTAssertNil(marks.state(id: "unread", songCount: 0))
    }

    @MainActor
    func testAScreenThatAlreadyKeepsTheFilesOnThePhoneGivesThemInsteadOfLookingAtEveryFileAgain() throws {
        let rig = try EngineRig()
        rig.store.recordPlaylist(id: "p", name: "P", songKeys: ["a", "b"])
        let given = PlaylistMarks.current(store: rig.store, local: ["a", "b"], progress: [:])
        XCTAssertEqual(given.local, ["a", "b"])
        XCTAssertEqual(given.state(id: "p", songCount: 2), .local, "the keys it was given, not the (empty) folder")
        XCTAssertEqual(PlaylistMarks.current(store: rig.store, progress: [:]).state(id: "p", songCount: 2), .online, "the other form reads the folder: no file on the phone")
        let failed = PlaylistMarks.current(store: rig.store, local: ["a", "b"], progress: ["b": .failed("boom")])
        XCTAssertEqual(failed.state(id: "p", songCount: 2), .error, "a failed download counts with the given keys too")
    }
}
