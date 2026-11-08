import XCTest
@testable import Mondrop

/// «Scarica tutti» after a search (Michele, 8 November: «In mondrop voglio anche poter scaricare tutto dopo una ricerca. E il play non
/// deve essere automatico»; spec 2026-11-08-mondrop-bulk-download-design.md): what there is to do is worked out and SHOWN first,
/// the ready songs go to the engine, the others are asked of the server, and the player is never touched.
final class BulkDownloadTests: XCTestCase {
    private func ready(_ key: String, bytes: Int? = 4_000_000) -> OfflineTrack { TestSupport.track(key, bytes: bytes) }
    private func missing(_ key: String) -> OfflineTrack { TestSupport.track(key, state: "missing", version: nil, bytes: nil) }
    private func failed(_ key: String) -> OfflineTrack { TestSupport.track(key, state: "failed", version: nil, bytes: nil) }
    private func preparing(_ key: String) -> OfflineTrack { TestSupport.track(key, state: "preparing", version: nil, bytes: nil) }
    private func noSource(_ key: String) -> OfflineTrack { TestSupport.track(key, state: "no_source", version: nil, bytes: nil) }

    /// What the engine would plan for these tracks on a phone that has `onPhone` (and the user removed `removed`).
    private func plan(_ tracks: [OfflineTrack], found: Int? = nil, onPhone: Set<String> = [], removed: Set<String> = [], inFlight: Set<String> = []) -> BulkDownload.Plan {
        let sync = SyncPlanner.plan(
            tracks: tracks,
            local: { onPhone.contains($0) ? LocalSnapshot(version: "100-1", bytes: 4_000_000, fileExtension: "mp3") : nil },
            inFlight: inFlight,
            skipped: removed
        )
        return BulkDownload.Plan(tracks: tracks, found: found ?? tracks.count, sync: sync)
    }

    // MARK: what there is to do

    func testTheSongsAreSortedByWhatHasToHappenToEachOne() {
        let p = plan(
            [ready("a::1"), ready("a::2"), missing("a::3"), failed("a::4"), preparing("a::5"), noSource("a::6"), ready("a::7"), ready("a::8")],
            onPhone: ["a::2"], removed: ["a::7"], inFlight: ["a::8"]
        )
        XCTAssertEqual(p.ready.map(\.songKey), ["a::1"], "ready on the server and not on the phone: downloaded now")
        XCTAssertEqual(p.toPrepare, ["a::3", "a::4"], "the server must get them first (a failed one is tried again)")
        XCTAssertEqual(p.preparing, 1, "the server is already on it")
        XCTAssertEqual(p.alreadyThere, 1)
        XCTAssertEqual(p.removedByUser, 1, "deleted on purpose: a bulk download does not undo it")
        XCTAssertEqual(p.onTheWay, 1)
        XCTAssertEqual(p.cannot, 1)
        XCTAssertEqual(p.coming, 4, "1 ready + 2 to prepare + 1 preparing")
        XCTAssertTrue(p.worthAsking)
    }

    func testTheSizeIsTheSumOfTheOnesThatSayIt() {
        let p = plan([ready("a::1", bytes: 3_000_000), ready("a::2", bytes: 5_000_000), ready("a::3", bytes: nil)])
        XCTAssertEqual(p.bytes, 8_000_000)
    }

    func testASongTwiceIsOne() {
        XCTAssertEqual(plan([ready("a::1"), ready("a::1")]).ready.count, 1)
    }

    func testMoreResultsThanOnePressTakesAreSaidAndCut() {
        let p = plan([ready("a::1"), ready("a::2")], found: 450)
        XCTAssertEqual(p.cut, 448)
        XCTAssertTrue(p.details.contains("La ricerca ne ha trovati 450: scarico i primi 2"))
        XCTAssertEqual(BulkDownload.maxTracks, 200, "a page of the server's answer, about a gigabyte")
    }

    // MARK: what the user is asked

    func testTheQuestionSaysHowManyAndTheDetailsSayWhere() {
        let p = plan([ready("a::1"), ready("a::2"), missing("a::3")], onPhone: [], removed: [])
        XCTAssertEqual(p.question, "Scaricare 3 brani sul telefono?")
        XCTAssertTrue(p.details.contains("2 pronti sul server (circa"))
        XCTAssertTrue(p.details.contains("1 da preparare sul server: arriva da solo"))
        XCTAssertEqual(plan([ready("a::1")]).question, "Scaricare 1 brano sul telefono?")
    }

    func testTheDetailsSayWhatStaysOut() {
        let p = plan([ready("a::1"), ready("a::2"), ready("a::3"), noSource("a::4")], onPhone: ["a::2"], removed: ["a::3"])
        XCTAssertTrue(p.details.contains("1 già sul telefono"))
        XCTAssertTrue(p.details.contains("1 li hai tolti dal telefono: restano fuori"))
        XCTAssertTrue(p.details.contains("1 senza sorgente"))
    }

    func testWithNothingToDoItIsNotAsked() {
        let all = plan([ready("a::1"), ready("a::2")], onPhone: ["a::1", "a::2"])
        XCTAssertFalse(all.worthAsking)
        XCTAssertEqual(all.nothingMessage, "Sono già tutti sul telefono")
        XCTAssertEqual(plan([ready("a::1")], onPhone: ["a::1"]).nothingMessage, "È già sul telefono")
        XCTAssertEqual(plan([]).nothingMessage, "Nessun brano da scaricare")
        let rest = plan([ready("a::1"), noSource("a::2")], onPhone: ["a::1"])
        XCTAssertFalse(rest.worthAsking)
        XCTAssertTrue(rest.nothingMessage.hasPrefix("Niente da scaricare: "))
    }

    // MARK: what happens when the user says yes

    @MainActor
    func testTheReadyOnesGoToTheEngineAndTheOthersAreAskedOfTheServer() async {
        let p = plan([ready("a::1"), ready("a::2"), missing("a::3"), failed("a::4"), preparing("a::5")], onPhone: ["a::2"])
        var queued: [String] = []
        let asked = Asked()
        let outcome = await BulkDownload.run(p, enqueue: { queued = $0.map(\.songKey) }, prepare: { key in await asked.add(key) })
        XCTAssertEqual(queued, ["a::1"])
        let keys = await asked.keys.sorted()
        XCTAssertEqual(keys, ["a::3", "a::4"], "only what the server does not have: not the ready ones, not the one it is already preparing")
        XCTAssertEqual(outcome, BulkDownload.Outcome(queued: 1, asked: 2, askFailed: 0))
        XCTAssertEqual(outcome.message, "Scarico 1 brano sul telefono. 2 in preparazione sul server: arrivano da soli")
    }

    @MainActor
    func testAFailedRequestIsCountedAndTheOthersGoOn() async {
        struct Down: Error {}
        let p = plan((1...10).map { missing("a::\($0)") })
        let outcome = await BulkDownload.run(p, enqueue: { _ in XCTFail("nothing is ready") }, prepare: { key in
            if key == "a::4" || key == "a::9" { throw Down() }
        })
        XCTAssertEqual(outcome, BulkDownload.Outcome(queued: 0, asked: 8, askFailed: 2))
        XCTAssertEqual(outcome.message, "8 in preparazione sul server: arrivano da soli. 2 non richiesti (errore)")
    }

    @MainActor
    func testManySongsAreAskedAFewAtATime() async {
        let p = plan((1...30).map { missing("a::\($0)") })
        let gauge = Gauge()
        _ = await BulkDownload.run(p, enqueue: { _ in }, prepare: { _ in
            await gauge.enter()
            try? await Task.sleep(for: .milliseconds(5))
            await gauge.leave()
        })
        let most = await gauge.most
        XCTAssertLessThanOrEqual(most, BulkDownload.parallelRequests, "each request is small, but 200 at once would still be a burst")
        XCTAssertGreaterThan(most, 1, "and they are not one by one")
        let total = await gauge.total
        XCTAssertEqual(total, 30)
    }

    @MainActor
    func testNothingIsAskedWhenNothingIsMissing() async {
        let p = plan([ready("a::1"), ready("a::2")])
        let asked = Asked()
        let outcome = await BulkDownload.run(p, enqueue: { _ in }, prepare: { key in await asked.add(key) })
        let keys = await asked.keys
        XCTAssertTrue(keys.isEmpty)
        XCTAssertEqual(outcome, BulkDownload.Outcome(queued: 2, asked: 0, askFailed: 0))
        XCTAssertEqual(outcome.message, "Scarico 2 brani sul telefono")
    }

    // MARK: a download is not a play

    func testTheDownloadNeverStartsThePlayer() throws {
        let kit = try String(contentsOf: iosRoot.appendingPathComponent("MondropKit/BulkDownload.swift"), encoding: .utf8)
        let app = try String(contentsOf: iosRoot.appendingPathComponent("Mondrop/SearchActions.swift"), encoding: .utf8)
        let downloader = try XCTUnwrap(app.range(of: "final class BulkDownloader")).lowerBound
        let downloaderCode = String(app[downloader...].prefix(2500))
        for code in [kit, downloaderCode] {
            for banned in ["LocalAudioPlayer", ".setQueue(", ".play(at", "playOnly", ".toggle()"] {
                XCTAssertFalse(code.contains(banned), "«\(banned)»: «Scarica tutti» only downloads")
            }
        }
    }

    private var iosRoot: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent() }

    private actor Asked {
        var keys: [String] = []
        func add(_ key: String) { keys.append(key) }
    }

    private actor Gauge {
        private var now = 0
        private(set) var most = 0
        private(set) var total = 0
        func enter() { now += 1; total += 1; most = max(most, now) }
        func leave() { now -= 1 }
    }
}
