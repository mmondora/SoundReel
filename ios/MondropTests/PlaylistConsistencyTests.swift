import Combine
import XCTest
@testable import Mondrop

/// «Voglio un check di consistenza con sync sulle impostazioni che verifica tutte le playlist locali o già scaricate se hanno tutti i file e scaricano quelli che
/// mancano» (Michele, 11 November, trying build 16; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U15). The one place where the sync is visible
/// on purpose: the Settings have a button that looks at every playlist the phone holds, asks SoundReel what each one has now, and downloads what the phone is missing.

final class ConsistencyScopeTests: XCTestCase {
    private func record(_ keys: [String]) -> OfflineStore.PlaylistRecord { OfflineStore.PlaylistRecord(songKeys: keys) }

    func testAPlaylistWithEverySongOnThePhoneIsOnIt() {
        XCTAssertTrue(ConsistencyScope.holds(record: record(["a", "b", "c"]), local: ["a", "b", "c", "z"]))
        XCTAssertTrue(ConsistencyScope.holds(record: record(["a"]), local: ["a"]))
    }

    func testAPlaylistWithHalfOrMoreOfItsSongsOnThePhoneIsOnIt() {
        XCTAssertTrue(ConsistencyScope.holds(record: record(["a", "b"]), local: ["a"]), "one of two")
        XCTAssertTrue(ConsistencyScope.holds(record: record(["a", "b", "c"]), local: ["a", "b"]), "two of three")
        XCTAssertTrue(ConsistencyScope.holds(record: record(["a", "b", "c", "d"]), local: ["a", "b"]), "exactly half")
    }

    func testAPlaylistWithLessThanHalfIsNotOnIt() {
        // a dynamic playlist of the genre that shares three songs with the ones played is not «downloaded»: the check would fetch two hundred songs nobody asked for
        XCTAssertFalse(ConsistencyScope.holds(record: record(["a", "b", "c"]), local: ["a"]), "one of three")
        let genre = (0..<200).map { "g\($0)" }
        XCTAssertFalse(ConsistencyScope.holds(record: record(genre), local: ["g1", "g2", "g3"]))
    }

    func testAPlaylistWithNoneOfItsSongsOnThePhoneIsNot() {
        XCTAssertFalse(ConsistencyScope.holds(record: record(["a", "b"]), local: ["z"]))
        XCTAssertFalse(ConsistencyScope.holds(record: record(["a"]), local: []))
    }

    func testAPlaylistThePhoneNeverReadOrThatHasNoSongsIsNot() {
        XCTAssertFalse(ConsistencyScope.holds(record: nil, local: ["a"]))
        XCTAssertFalse(ConsistencyScope.holds(record: record([]), local: ["a"]))
    }
}

final class ConsistencyReportTests: XCTestCase {
    private func report(_ edit: (inout ConsistencyReport) -> Void) -> ConsistencyReport {
        var r = ConsistencyReport()
        edit(&r)
        return r
    }

    func testNothingOnThePhoneSaysSoAndHowToGetSomething() {
        XCTAssertEqual(report { _ in }.lines, ["Sul telefono non c'è ancora nessuna playlist da controllare: suonane una e la scarico da sola."])
    }

    func testEverythingInOrderSaysSo() {
        XCTAssertEqual(report { $0.playlists = 4; $0.complete = 4 }.lines, ["Controllate 4 playlist: tutte hanno già tutti i brani."])
        XCTAssertEqual(report { $0.playlists = 1; $0.complete = 1 }.lines, ["Controllata 1 playlist: ha già tutti i brani."])
    }

    private func size(_ bytes: Int) -> String { ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file) }

    func testWhatIsMissingIsDownloadedAndTheSizeIsSaid() {
        let r = report { $0.playlists = 5; $0.complete = 3; $0.toComplete = 2; $0.songsToDownload = 23; $0.bytesToDownload = 1_200_000_000 }
        XCTAssertEqual(r.lines, ["Controllate 5 playlist: 3 complete, 2 da completare.", "Scarico 23 brani (\(size(1_200_000_000)))."])
    }

    func testOneSongIsOneSongAndAnUnknownSizeIsNotInvented() {
        let r = report { $0.playlists = 2; $0.complete = 1; $0.toComplete = 1; $0.songsToDownload = 1 }
        XCTAssertEqual(r.lines, ["Controllate 2 playlist: 1 completa, 1 da completare.", "Scarico 1 brano."])
    }

    func testTheProblemsAreSaidOneByOne() {
        let r = report {
            $0.playlists = 3; $0.complete = 1; $0.toComplete = 2; $0.songsToDownload = 4; $0.bytesToDownload = 80_000_000
            $0.leftOut = 6; $0.notReadyOnServer = 3; $0.withoutSource = 2; $0.failedOnServer = 1; $0.unreadable = ["Road trip", "Jazz"]
        }
        XCTAssertEqual(r.lines, [
            "Controllate 3 playlist: 1 completa, 2 da completare.",
            "Scarico 4 brani (\(size(80_000_000))).",
            "Lasciati online per il limite: 6.",
            "Non ancora pronti sul server: 3 (li ho chiesti: riprova più tardi).",
            "Senza sorgente: 2.",
            "Con errore sul server: 1.",
            "Non riesco a leggere: «Road trip», «Jazz».",
        ])
    }

    func testACancelledCheckDownloadedNothingAndSaysIt() {
        let r = report { $0.playlists = 3; $0.complete = 1; $0.toComplete = 2; $0.cancelled = true }
        XCTAssertEqual(r.lines, ["Controllate 3 playlist: 1 completa, 2 da completare.", "Annullato: non ho scaricato niente."])
    }

    func testAListThatCouldNotBeReadSaysWhy() {
        XCTAssertEqual(report { $0.listFailure = "HTTP 502" }.lines, ["Non riesco a leggere le playlist: HTTP 502. Riprova."])
    }
}

@MainActor
final class PlaylistConsistencyCheckTests: XCTestCase {
    private let mb = 1_000_000
    private let gb = 1_000_000_000

    private struct Rig {
        let check: PlaylistConsistencyCheck
        let api: FakeAPI
        let engineRig: EngineRig
        let cache: MemoryCache
        let limit: Limit
        var engine: SyncEngine { engineRig.engine }
        var store: OfflineStore { engineRig.store }
    }

    private final class Limit: @unchecked Sendable { var value: SyncWarnLimit = .gb2; var hasKey = true }

    private final class MemoryCache: PlaylistManifestCaching, @unchecked Sendable {
        var lists: [String: OfflineManifest] = [:]
        func load(playlistId: String) -> OfflineManifest? { lists[playlistId] }
        func save(_ manifest: OfflineManifest) { lists[manifest.playlistId] = manifest }
        func prune(keeping ids: Set<String>) { lists = lists.filter { ids.contains($0.key) } }
    }

    private func make(limit: SyncWarnLimit = .gb2) throws -> Rig {
        let engineRig = try EngineRig(maxParallel: 2)
        let api = FakeAPI()
        let cache = MemoryCache()
        let box = Limit()
        box.value = limit
        let check = PlaylistConsistencyCheck(api: api, engine: engineRig.engine, limit: { box.value }, hasKey: { box.hasKey }, cache: cache)
        return Rig(check: check, api: api, engineRig: engineRig, cache: cache, limit: box)
    }

    /// A playlist the phone holds: the server's list of it, what the phone saw of it, and `local` of its songs on the phone (small files: 100 bytes). The songs that are
    /// missing are `size` bytes each according to the server; nothing of that size is ever written.
    private func hold(_ r: Rig, _ id: String, songs: [String], local: [String], missing size: Int = 100, name: String? = nil, state: String = "ready") throws {
        func track(_ key: String, _ state: String = "ready") -> OfflineTrack { TestSupport.track(key, state: state, bytes: local.contains(key) ? 100 : size) }
        r.api.scriptManifests(id, [.success(TestSupport.manifest(id, songs.map { track($0, state) }))])
        r.api.scriptPrepare(id, [TestSupport.manifest(id, songs.map { track($0) })])
        r.store.recordPlaylist(id: id, name: name ?? "Playlist \(id)", songKeys: songs)
        for key in local { try r.engineRig.installLocal(key, version: "100-1", bytes: 100) }
    }

    private func serverHas(_ r: Rig, _ ids: [String]) {
        r.api.setPlaylists(ids.map { MondropPlaylist(id: $0, name: "Playlist \($0)", songCount: 1) })
    }

    private func queued(_ r: Rig) -> Set<String> { Set(r.engine.progress.keys) }

    private func finished(_ r: Rig, file: StaticString = #filePath, line: UInt = #line) throws -> ConsistencyReport {
        guard case .finished(let report) = r.check.phase else {
            XCTFail("the check did not finish: \(r.check.phase)", file: file, line: line)
            throw CancellationError()
        }
        return report
    }

    private func untilAsking(_ check: PlaylistConsistencyCheck) async throws -> SyncSizeQuestion {
        for _ in 0..<1_000 {
            if case .asking(let question) = check.phase { return question }
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        XCTFail("the check never asked")
        throw CancellationError()
    }

    // MARK: what it looks at

    func testItLooksOnlyAtThePlaylistsThePhoneHolds() async throws {
        let r = try make()
        try hold(r, "full", songs: ["a1", "a2"], local: ["a1", "a2"])
        try hold(r, "half", songs: ["b1", "b2"], local: ["b1"])
        try hold(r, "few", songs: ["c1", "c2", "c3"], local: ["c1"])
        try hold(r, "none", songs: ["d1"], local: [])
        serverHas(r, ["full", "half", "few", "none"])
        await r.check.run()
        let reads = r.api.calls.filter { $0.hasPrefix("manifest:") }
        XCTAssertEqual(reads, ["manifest:full", "manifest:half"], "the playlists that are on the phone, in the order of the list; not the others, not one read for nothing")
        XCTAssertEqual(try finished(r).playlists, 2)
    }

    func testAPlaylistDeletedOnTheServerIsNotChecked() async throws {
        let r = try make()
        try hold(r, "alive", songs: ["a1"], local: ["a1"])
        try hold(r, "deleted", songs: ["b1"], local: ["b1"])
        serverHas(r, ["alive"])
        await r.check.run()
        XCTAssertEqual(r.api.calls.filter { $0.hasPrefix("manifest:") }, ["manifest:alive"])
    }

    func testNothingOnThePhoneIsSaidAndNothingIsAsked() async throws {
        let r = try make()
        serverHas(r, ["a", "b"])
        await r.check.run()
        let report = try finished(r)
        XCTAssertEqual(report.playlists, 0)
        XCTAssertEqual(r.api.calls, ["playlists"])
        XCTAssertTrue(queued(r).isEmpty)
    }

    // MARK: what it does

    func testAPlaylistThatHasEverySongIsCompleteAndNothingIsDownloaded() async throws {
        let r = try make()
        try hold(r, "full", songs: ["a1", "a2"], local: ["a1", "a2"])
        serverHas(r, ["full"])
        await r.check.run()
        let report = try finished(r)
        XCTAssertEqual(report.complete, 1)
        XCTAssertEqual(report.toComplete, 0)
        XCTAssertTrue(queued(r).isEmpty)
        XCTAssertEqual(report.lines, ["Controllata 1 playlist: ha già tutti i brani."])
    }

    func testTheMissingSongsOfAPlaylistOnThePhoneAreDownloaded() async throws {
        let r = try make()
        try hold(r, "half", songs: ["b1", "b2", "b3", "b4"], local: ["b1", "b2"])
        serverHas(r, ["half"])
        await r.check.run()
        XCTAssertEqual(queued(r), ["b3", "b4"], "what is on the phone is not downloaded again")
        let report = try finished(r)
        XCTAssertEqual(report.toComplete, 1)
        XCTAssertEqual(report.songsToDownload, 2)
        XCTAssertEqual(report.bytesToDownload, 200)
    }

    func testSongsAddedToAPlaylistOnTheServerSinceTheLastTimeAreFound() async throws {
        // the phone saw the playlist with two songs, both on it; the server has two more now
        let r = try make()
        r.store.recordPlaylist(id: "grown", name: "Grown", songKeys: ["a1", "a2"])
        for key in ["a1", "a2"] { try r.engineRig.installLocal(key, version: "100-1") }
        r.api.scriptManifests("grown", [.success(TestSupport.manifest("grown", ["a1", "a2", "a3", "a4"].map { TestSupport.track($0) }))])
        serverHas(r, ["grown"])
        await r.check.run()
        XCTAssertEqual(queued(r), ["a3", "a4"])
    }

    func testASongThatIsInTwoPlaylistsIsDownloadedOnce() async throws {
        let r = try make()
        try hold(r, "one", songs: ["s1", "shared"], local: ["s1"])
        try hold(r, "two", songs: ["t1", "shared"], local: ["t1"])
        serverHas(r, ["one", "two"])
        await r.check.run()
        XCTAssertEqual(queued(r), ["shared"])
        XCTAssertEqual(try finished(r).songsToDownload, 1)
        XCTAssertEqual(r.engineRig.transport.startedKeys.filter { $0 == "shared" }.count, 1)
    }

    func testAFileOfTheWrongSizeIsDownloadedAgain() async throws {
        // the consistency: a file that is there but is not the one the server has (truncated) is replaced
        let r = try make()
        r.store.recordPlaylist(id: "p", name: "P", songKeys: ["ok", "short"])
        try r.engineRig.installLocal("ok", version: "100-1", bytes: 100)
        try r.engineRig.installLocal("short", version: "100-1", bytes: 60)           // the server says 100
        r.api.scriptManifests("p", [.success(TestSupport.manifest("p", [TestSupport.track("ok", bytes: 100), TestSupport.track("short", bytes: 100)]))])
        serverHas(r, ["p"])
        await r.check.run()
        XCTAssertEqual(queued(r), ["short"])
    }

    func testASongTheUserDeletedFromThePhoneOnPurposeIsNotBroughtBack() async throws {
        let r = try make()
        try hold(r, "p", songs: ["a1", "a2", "gone"], local: ["a1", "a2"])
        r.store.addSkipped(["gone"])
        serverHas(r, ["p"])
        await r.check.run()
        XCTAssertTrue(queued(r).isEmpty, "«Riscarica» is the only way back for a song deleted on purpose")
        XCTAssertEqual(try finished(r).complete, 1, "the playlist has every song the user wants on the phone")
    }

    func testSongsNeverPreparedOnTheServerAreAskedForAndTheOnesThatAreReadyGoDown() async throws {
        let r = try make()
        r.store.recordPlaylist(id: "p", name: "P", songKeys: ["a1", "a2", "new"])
        for key in ["a1", "a2"] { try r.engineRig.installLocal(key, version: "100-1") }
        r.api.scriptManifests("p", [.success(TestSupport.manifest("p", [TestSupport.track("a1"), TestSupport.track("a2"), TestSupport.track("new", state: "missing")]))])
        r.api.scriptPrepare("p", [TestSupport.manifest("p", [TestSupport.track("a1"), TestSupport.track("a2"), TestSupport.track("new")])])     // it was ready after all
        serverHas(r, ["p"])
        await r.check.run()
        XCTAssertEqual(r.api.calls.filter { $0.hasPrefix("prepare:") }, ["prepare:p:retry=false"], "SoundReel is asked to prepare what it has not: the same call the playlist that plays makes")
        XCTAssertEqual(queued(r), ["new"])
    }

    func testSongsTheServerCannotGiveYetAreCountedAndNotDownloaded() async throws {
        let r = try make()
        r.store.recordPlaylist(id: "p", name: "P", songKeys: ["a1", "a2", "a3", "late", "nosrc", "bad"])       // three of six on the phone: it is held
        for key in ["a1", "a2", "a3"] { try r.engineRig.installLocal(key, version: "100-1") }
        let still = TestSupport.manifest("p", [
            TestSupport.track("a1"), TestSupport.track("a2"), TestSupport.track("a3"),
            TestSupport.track("late", state: "preparing"), TestSupport.track("nosrc", state: "no_source"), TestSupport.track("bad", state: "failed", error: "yt-dlp"),
        ])
        r.api.scriptManifests("p", [.success(still)])
        serverHas(r, ["p"])
        await r.check.run()
        let report = try finished(r)
        XCTAssertTrue(queued(r).isEmpty)
        XCTAssertEqual(report.notReadyOnServer, 1)
        XCTAssertEqual(report.withoutSource, 1)
        XCTAssertEqual(report.failedOnServer, 1)
        XCTAssertEqual(report.complete, 0)
        XCTAssertEqual(report.toComplete, 1, "it is not complete: three songs are not on the phone and cannot be, yet")
        XCTAssertEqual(r.api.calls.filter { $0.hasPrefix("prepare:") }, [], "nothing «missing»: nothing to ask for")
    }

    func testAPlaylistThatCannotBeReadIsReportedAndTheOthersAreChecked() async throws {
        let r = try make()
        try hold(r, "bad", songs: ["a1", "a2"], local: ["a1"], name: "Road trip")
        try hold(r, "good", songs: ["b1", "b2"], local: ["b1"])
        r.api.scriptManifests("bad", [.failure(MondropAPIError.http(502, "bad gateway"))])
        serverHas(r, ["bad", "good"])
        await r.check.run()
        let report = try finished(r)
        XCTAssertEqual(report.unreadable, ["Playlist bad"], "named as the server's list names it")
        XCTAssertEqual(queued(r), ["b2"])
        XCTAssertEqual(report.playlists, 2)
    }

    func testWhenThePlaylistsCannotBeReadNothingHappensAndItIsSaid() async throws {
        let r = try make()
        try hold(r, "p", songs: ["a1", "a2"], local: ["a1"])
        final class Failing: MondropAPIProtocol, @unchecked Sendable {
            func listPlaylists() async throws -> [MondropPlaylist] { throw MondropAPIError.http(502, "bad gateway") }
            func offlineManifest(playlistId: String) async throws -> OfflineManifest { throw MondropAPIError.http(502, "no") }
            func prepare(playlistId: String, retryFailed: Bool) async throws -> OfflineManifest { throw MondropAPIError.http(502, "no") }
            func net() async throws -> NetInfo { throw MondropAPIError.http(502, "no") }
            func track(songKey: String) async throws -> OfflineTrack { throw MondropAPIError.http(502, "no") }
            func requestDownload(songKey: String, priority: DownloadPriority) async throws -> DownloadAck { throw MondropAPIError.http(502, "no") }
            func setSource(songKey: String, youtubeUrl: String) async throws { throw MondropAPIError.http(502, "no") }
        }
        let check = PlaylistConsistencyCheck(api: Failing(), engine: r.engine, limit: { .gb2 }, hasKey: { true }, cache: r.cache)
        await check.run()
        guard case .finished(let report) = check.phase else { return XCTFail("\(check.phase)") }
        XCTAssertNotNil(report.listFailure)
        XCTAssertTrue(queued(r).isEmpty)
        XCTAssertTrue(report.lines.first?.hasPrefix("Non riesco a leggere le playlist") == true)
    }

    func testWithNoKeyItSaysSoAndAsksNothing() async throws {
        let r = try make()
        r.limit.hasKey = false
        try hold(r, "p", songs: ["a1", "a2"], local: ["a1"])
        serverHas(r, ["p"])
        await r.check.run()
        XCTAssertTrue(r.api.calls.isEmpty, "no key: not a single request")
        XCTAssertNotNil(try finished(r).listFailure)
    }

    // MARK: the size question

    func testUnderTheLimitNothingIsAsked() async throws {
        let r = try make(limit: .gb2)
        try hold(r, "p", songs: ["a1", "a2", "a3", "a4"], local: ["a1", "a2"], missing: 100 * mb)
        serverHas(r, ["p"])
        await r.check.run()
        XCTAssertEqual(queued(r), ["a3", "a4"], "200 MB: under 2 GB, it starts without a word")
    }

    func testOverTheLimitTheUserIsAskedOnceForEverythingTheCheckWouldDownload() async throws {
        let r = try make(limit: .gb1)
        try hold(r, "one", songs: ["a1", "a2", "a3", "a4"], local: ["a1", "a2"], missing: 400 * mb)       // 800 MB to download
        try hold(r, "two", songs: ["b1", "b2", "b3", "b4"], local: ["b1", "b2"], missing: 400 * mb)       // 800 MB: 1.6 GB in all
        serverHas(r, ["one", "two"])
        let task = Task { await r.check.run() }
        let question = try await untilAsking(r.check)
        XCTAssertEqual(r.check.question, question, "the screen reads the question from the check")
        XCTAssertEqual(question.songs, 4)
        XCTAssertEqual(question.bytes, 1_600 * mb)
        XCTAssertTrue(queued(r).isEmpty, "nothing downloads before the answer")
        r.check.answer(.all)
        await task.value
        XCTAssertNil(r.check.question, "and the question is gone once it is answered")
        XCTAssertEqual(queued(r), ["a3", "a4", "b3", "b4"])
        XCTAssertEqual(r.api.calls.filter { $0.hasPrefix("manifest:") }.count, 2, "one question for the whole check, not one per playlist")
    }

    func testLimitDownloadsTheFirstSongsUpToTheLimitAndSaysWhatStayedOnline() async throws {
        let r = try make(limit: .gb1)
        try hold(r, "one", songs: ["a1", "a2", "a3", "a4"], local: ["a1", "a2"], missing: 600 * mb)       // 1.2 GB to download
        serverHas(r, ["one"])
        let task = Task { await r.check.run() }
        _ = try await untilAsking(r.check)
        r.check.answer(.limit)
        await task.value
        XCTAssertEqual(queued(r), ["a3"], "600 MB fit under 1 GB, the next 600 do not")
        let report = try finished(r)
        XCTAssertEqual(report.songsToDownload, 1)
        XCTAssertEqual(report.leftOut, 1)
    }

    func testLimitKeepsTheSongsAboutToPlayWhenSomethingPlays() async throws {
        // U16, «Sync scarica i brani in ordine di stanno per suonare.»: the queue that plays is on its way to a4
        let r = try make(limit: .gb1)
        try hold(r, "one", songs: ["a1", "a2", "a3", "a4"], local: ["a1", "a2"], missing: 600 * mb)       // a3 and a4 to download: 1.2 GB
        serverHas(r, ["one"])
        r.engine.setUpcoming(["a4", "a1", "a2", "a3"])
        let task = Task { await r.check.run() }
        _ = try await untilAsking(r.check)
        r.check.answer(.limit)
        await task.value
        XCTAssertEqual(queued(r), ["a4"], "600 MB fit under 1 GB: the song about to play, not the first one that is missing")
    }

    func testWhatTheCheckDownloadsStartsWithTheSongsAboutToPlay() async throws {
        let r = try make()
        try hold(r, "one", songs: ["a1", "a2", "a3", "a4"], local: ["a1", "a2"])
        try hold(r, "two", songs: ["b1", "b2", "b3", "b4"], local: ["b1", "b2"])
        serverHas(r, ["one", "two"])
        r.engine.setUpcoming(["b4", "a3"])
        await r.check.run()
        XCTAssertEqual(queued(r), ["a3", "a4", "b3", "b4"])
        XCTAssertEqual(r.engineRig.transport.startedKeys, ["b4", "a3"], "the two that come down first are the ones about to play, whatever the playlist")
    }

    func testCancelDownloadsNothing() async throws {
        let r = try make(limit: .gb1)
        try hold(r, "one", songs: ["a1", "a2", "a3", "a4"], local: ["a1", "a2"], missing: 600 * mb)
        serverHas(r, ["one"])
        let task = Task { await r.check.run() }
        _ = try await untilAsking(r.check)
        r.check.answer(.cancel)
        await task.value
        XCTAssertTrue(queued(r).isEmpty)
        XCTAssertTrue(try finished(r).cancelled)
    }

    func testLeavingWithoutAnAnswerIsACancel() async throws {
        let r = try make(limit: .gb1)
        try hold(r, "one", songs: ["a1", "a2", "a3", "a4"], local: ["a1", "a2"], missing: 600 * mb)
        serverHas(r, ["one"])
        let task = Task { await r.check.run() }
        _ = try await untilAsking(r.check)
        r.check.cancel()
        await task.value
        XCTAssertTrue(queued(r).isEmpty)
        XCTAssertTrue(try finished(r).cancelled)
    }

    func testAnAnswerThatArrivesWhenNothingIsAskedIsIgnored() async throws {
        let r = try make()
        r.check.answer(.all)
        XCTAssertEqual(r.check.phase, .idle)
    }

    // MARK: how it runs

    func testItNeverRunsTwiceAtOnce() async throws {
        let r = try make(limit: .gb1)
        try hold(r, "one", songs: ["a1", "a2", "a3", "a4"], local: ["a1", "a2"], missing: 600 * mb)
        serverHas(r, ["one"])
        let first = Task { await r.check.run() }
        _ = try await untilAsking(r.check)
        XCTAssertTrue(r.check.isBusy)
        await r.check.run()                                            // a second press while the question is up
        XCTAssertEqual(r.api.calls.filter { $0 == "playlists" }.count, 1, "the second one did nothing")
        r.check.answer(.cancel)
        await first.value
        XCTAssertFalse(r.check.isBusy)
    }

    func testItReportsItsProgressPlaylistByPlaylist() async throws {
        let r = try make()
        try hold(r, "one", songs: ["a1", "a2"], local: ["a1", "a2"])
        try hold(r, "two", songs: ["b1", "b2"], local: ["b1", "b2"])
        serverHas(r, ["one", "two"])
        var seen: [PlaylistConsistencyCheck.Phase] = []
        let sink = r.check.$phase.sink { seen.append($0) }
        await r.check.run()
        sink.cancel()
        XCTAssertTrue(seen.contains(.checking(done: 0, total: 2)))
        XCTAssertTrue(seen.contains(.checking(done: 1, total: 2)))
        XCTAssertTrue(seen.contains(.checking(done: 2, total: 2)))
        XCTAssertEqual(seen.first, .idle)
    }

    func testTheDownloadsItStartsAreAnnouncedWhenTheyEnd() async throws {
        // the one sync the user asked for: when it ends and the app is not open, «Sync finito» (SyncNotifier)
        let r = try make()
        try hold(r, "p", songs: ["a1", "a2", "a3", "a4"], local: ["a1", "a2"])
        serverHas(r, ["p"])
        var announced: [SyncBatchSummary] = []
        r.engine.onBatchFinished = { announced.append($0) }
        await r.check.run()
        for job in r.engineRig.transport.started { try r.engineRig.finish(job.info) }
        XCTAssertEqual(announced, [SyncBatchSummary(downloaded: 2, failed: 0)])
    }

    func testThePhoneLearnsWhatThePlaylistsHoldNow() async throws {
        let r = try make()
        r.store.recordPlaylist(id: "grown", name: "Grown", songKeys: ["a1", "a2"])
        for key in ["a1", "a2"] { try r.engineRig.installLocal(key, version: "100-1") }
        r.api.scriptManifests("grown", [.success(TestSupport.manifest("grown", ["a1", "a2", "a3"].map { TestSupport.track($0) }))])
        serverHas(r, ["grown"])
        await r.check.run()
        XCTAssertEqual(r.store.playlistRecords()["grown"]?.songKeys, ["a1", "a2", "a3"], "the marks of the lists read it")
        XCTAssertEqual(r.cache.lists["grown"]?.tracks.map(\.songKey), ["a1", "a2", "a3"], "and so does the page of the playlist")
    }

    func testStartingItFromAButtonRunsTheSameWork() async throws {
        let r = try make()
        try hold(r, "p", songs: ["a1", "a2"], local: ["a1"])
        serverHas(r, ["p"])
        r.check.start()
        for _ in 0..<1_000 where !queued(r).contains("a2") { try await Task.sleep(nanoseconds: 2_000_000) }
        XCTAssertEqual(queued(r), ["a2"])
    }
}
