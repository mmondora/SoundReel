import XCTest
@testable import Mondrop

/// «Deve fare il sync. Se sono molti gb deve avvisare oppure limitare, da internet in Wi-Fi deve solo avvisare dei gb con la possibilità di annullare o
/// limitare - oppure i max gb possono essere una configurazione» (Michele, 10 November; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md
/// U2). The guard before the first download is pure code: bytes and a limit in, a decision out.
final class SyncSizeGuardTests: XCTestCase {
    private let mb = 1_000_000
    private let gb = 1_000_000_000

    private func songs(_ sizes: [Int?]) -> [OfflineTrack] {
        sizes.enumerated().map { TestSupport.track("s\($0.offset)", bytes: $0.element) }
    }

    // MARK: the limit is a configuration

    func testTheOptionsAreOneTwoFiveTenTwentyFiftyGigabytesOrNever() {
        XCTAssertEqual(SyncWarnLimit.allCases.map(\.title), ["1 GB", "2 GB", "5 GB", "10 GB", "20 GB", "50 GB", "Mai"])
        XCTAssertEqual(SyncWarnLimit.allCases.map(\.bytes), [gb, 2 * gb, 5 * gb, 10 * gb, 20 * gb, 50 * gb, nil])
    }

    func testTheStartingLimitIsTwoGigabytes() {
        XCTAssertEqual(SyncWarnLimit.default, .gb2)
    }

    func testAStoredNumberComesBackAsItsOptionAndAnythingElseIsTheDefault() {
        XCTAssertEqual(SyncWarnLimit(stored: 10), .gb10)
        XCTAssertEqual(SyncWarnLimit(stored: 0), .never)
        XCTAssertEqual(SyncWarnLimit(stored: 7), .default, "a value that is not an option (an old or a damaged one) is the starting one")
        XCTAssertEqual(SyncWarnLimit(stored: nil), .default)
        XCTAssertEqual(SyncWarnLimit(stored: -3), .default)
    }

    // MARK: the decision

    func testNothingToDownloadIsNothingToAskAndNothingToDo() {
        XCTAssertEqual(SyncSizeGuard.decide(download: [], limit: .gb2), .nothing)
        XCTAssertEqual(SyncSizeGuard.decide(download: [], limit: .never), .nothing)
    }

    func testUnderTheLimitItJustStarts() {
        XCTAssertEqual(SyncSizeGuard.decide(download: songs([500 * mb, 500 * mb]), limit: .gb2), .proceed)
    }

    func testExactlyTheLimitIsStillUnderIt() {
        XCTAssertEqual(SyncSizeGuard.decide(download: songs([gb, gb]), limit: .gb2), .proceed)
    }

    func testOneByteOverTheLimitAsks() {
        let decision = SyncSizeGuard.decide(download: songs([gb, gb + 1]), limit: .gb2)
        guard case .ask(let question) = decision else { return XCTFail("expected a question, got \(decision)") }
        XCTAssertEqual(question.bytes, 2 * gb + 1)
        XCTAssertEqual(question.songs, 2)
        XCTAssertEqual(question.limitBytes, 2 * gb)
    }

    func testNeverAsksNoMatterHowMuch() {
        XCTAssertEqual(SyncSizeGuard.decide(download: songs([100 * gb]), limit: .never), .proceed)
    }

    func testASongWhoseSizeIsNotKnownWeighsNothingButStillCounts() {
        let decision = SyncSizeGuard.decide(download: songs([2 * gb, nil, nil]), limit: .gb2)
        XCTAssertEqual(decision, .proceed, "2 GB known, the rest unknown: not above the limit")
        guard case .ask(let q) = SyncSizeGuard.decide(download: songs([2 * gb + 1, nil]), limit: .gb2) else { return XCTFail("expected a question") }
        XCTAssertEqual(q.songs, 2, "the unknown one is counted as a song")
        XCTAssertEqual(q.bytes, 2 * gb + 1)
    }

    // MARK: the words of the question

    func testTheQuestionSaysHowMuchAndHowManyAndOffersTheLimit() {
        guard case .ask(let q) = SyncSizeGuard.decide(download: songs(Array(repeating: 10 * mb, count: 300)), limit: .gb2) else { return XCTFail("expected a question") }
        XCTAssertEqual(q.songs, 300)
        XCTAssertEqual(q.title, "Da scaricare \(ByteCountFormatter.string(fromByteCount: Int64(3 * gb), countStyle: .file)) (300 brani)")
        XCTAssertEqual(q.limitButtonTitle, "Limita a 2 GB")
        XCTAssertTrue(q.message.contains("2 GB"), "it says which limit is set")
        XCTAssertTrue(q.message.contains("Impostazioni"), "and where to change it")
    }

    func testOneSongIsOneSong() {
        guard case .ask(let q) = SyncSizeGuard.decide(download: songs([3 * gb]), limit: .gb2) else { return XCTFail("expected a question") }
        XCTAssertTrue(q.title.hasSuffix("(1 brano)"), q.title)
    }

    // MARK: «Limita»: the order of the playlists and of the songs, until the limit

    func testTheLimitedSelectionKeepsTheOrderAndStopsWhereTheNextWouldNotFit() {
        let all = songs([600 * mb, 700 * mb, 500 * mb, 100 * mb])
        // 600 + 700 = 1300; + 500 = 1800 ≤ 2000; + 100 = 1900 ≤ 2000 → all of them fit; so use a tighter limit
        XCTAssertEqual(SyncSizeGuard.limited(all, limitBytes: 1_900 * mb).map(\.songKey), ["s0", "s1", "s2", "s3"], "1900 fits exactly")
        XCTAssertEqual(SyncSizeGuard.limited(all, limitBytes: 1_899 * mb).map(\.songKey), ["s0", "s1", "s2"], "the last one does not fit")
        XCTAssertEqual(SyncSizeGuard.limited(all, limitBytes: 1_300 * mb).map(\.songKey), ["s0", "s1"])
        XCTAssertEqual(SyncSizeGuard.limited(all, limitBytes: 1_299 * mb).map(\.songKey), ["s0"])
    }

    func testTheLimitedSelectionStopsAtTheFirstSongThatDoesNotFitEvenIfLaterOnesWould() {
        // the order is the promise: a small song further down never jumps the queue
        let all = songs([900 * mb, 900 * mb, 10 * mb])
        XCTAssertEqual(SyncSizeGuard.limited(all, limitBytes: 1_000 * mb).map(\.songKey), ["s0"])
    }

    func testAnEmptyOrTooSmallLimitSelectsNothing() {
        XCTAssertEqual(SyncSizeGuard.limited(songs([10 * mb]), limitBytes: 0), [])
        XCTAssertEqual(SyncSizeGuard.limited(songs([10 * mb]), limitBytes: 9 * mb), [])
        XCTAssertEqual(SyncSizeGuard.limited([], limitBytes: gb), [])
    }

    func testASongOfUnknownSizeRidesAlongForFree() {
        XCTAssertEqual(SyncSizeGuard.limited(songs([500 * mb, nil, 500 * mb]), limitBytes: 1_000 * mb).map(\.songKey), ["s0", "s1", "s2"])
    }

    // MARK: the three answers

    func testAllTakesEverything() {
        let all = songs([gb, gb, gb])
        XCTAssertEqual(SyncSizeGuard.apply(.all, to: all, limit: .gb2), all)
    }

    func testLimitTakesTheLimitedSelection() {
        let all = songs([gb, gb, gb])
        XCTAssertEqual(SyncSizeGuard.apply(.limit, to: all, limit: .gb2).map(\.songKey), ["s0", "s1"])
    }

    func testCancelTakesNothing() {
        XCTAssertEqual(SyncSizeGuard.apply(.cancel, to: songs([gb]), limit: .gb2), [])
    }

    func testLimitWithNoLimitSetTakesEverythingThereIsNothingToLimitTo() {
        let all = songs([gb, gb])
        XCTAssertEqual(SyncSizeGuard.apply(.limit, to: all, limit: .never), all)
    }

    // MARK: kept in the Settings

    func testTheLimitAndTheFirstSyncFlagAreKeptInTheSettings() {
        let settings = Settings.shared
        let savedLimit = settings.storage.object(forKey: "syncWarnLimitGB")
        let savedDone = settings.storage.object(forKey: "firstSyncDone")
        defer {
            settings.storage.set(savedLimit, forKey: "syncWarnLimitGB")
            settings.storage.set(savedDone, forKey: "firstSyncDone")
        }
        settings.storage.removeObject(forKey: "syncWarnLimitGB")
        settings.storage.removeObject(forKey: "firstSyncDone")
        XCTAssertEqual(settings.syncWarnLimit, .gb2, "a phone that never chose starts at 2 GB")
        XCTAssertFalse(settings.firstSyncDone)
        settings.syncWarnLimit = .gb20
        settings.firstSyncDone = true
        XCTAssertEqual(settings.syncWarnLimit, .gb20)
        XCTAssertTrue(settings.firstSyncDone)
        settings.syncWarnLimit = .never
        XCTAssertEqual(settings.syncWarnLimit, .never)
        settings.storage.set(7, forKey: "syncWarnLimitGB")
        XCTAssertEqual(settings.syncWarnLimit, .gb2, "a damaged value is the starting one")
    }
}
