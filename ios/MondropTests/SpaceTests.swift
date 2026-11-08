import XCTest
@testable import Mondrop

// MARK: - Ordering (D9)

final class SpaceRankingTests: XCTestCase {
    private func keys(_ rows: [SpaceRow]) -> [String] { rows.map(\.songKey) }
    private let d = TestSupport.day
    private func row(_ k: String, plays: Int = 0, last: Date? = nil, added: Date? = nil, bytes: Int = 5_000_000, title: String? = nil, artist: String = "Artist") -> SpaceRow {
        TestSupport.spaceRow(k, plays: plays, last: last, added: added, bytes: bytes, title: title, artist: artist)
    }

    func testLeastPlayedFirstThenOldestLastPlayAndNeverPlayedBeforeEverything() {
        let rows = [
            row("often", plays: 12, last: d(30)),
            row("twice-recent", plays: 2, last: d(29)),
            row("never", plays: 0, last: nil),
            row("twice-old", plays: 2, last: d(3)),
            row("once", plays: 1, last: d(20)),
        ]
        XCTAssertEqual(keys(SpaceRanking.sorted(rows, by: .leastPlayed)), ["never", "once", "twice-old", "twice-recent", "often"])
    }

    func testTiesOnPlaysAreBrokenByTheOldestLastPlay() {
        let rows = [row("b", plays: 3, last: d(10)), row("a", plays: 3, last: d(2)), row("c", plays: 3, last: d(6))]
        XCTAssertEqual(keys(SpaceRanking.sorted(rows, by: .leastPlayed)), ["a", "c", "b"])
    }

    func testWhenCountsTieAnUnknownLastPlayCountsAsTheOldest() {
        let rows = [row("dated", plays: 1, last: d(5)), row("undated", plays: 1, last: nil), row("older-dated", plays: 1, last: d(1))]
        XCTAssertEqual(keys(SpaceRanking.sorted(rows, by: .leastPlayed)), ["undated", "older-dated", "dated"])
    }

    func testNeverPlayedSongsAreOrderedByHowLongTheyHaveBeenOnThePhone() {
        let rows = [
            row("new", added: d(20)),
            row("old", added: d(1)),
            row("legacy-no-date", added: nil),          // downloaded before the app recorded dates: the oldest of all
            row("mid", added: d(10)),
        ]
        XCTAssertEqual(keys(SpaceRanking.sorted(rows, by: .leastPlayed)), ["legacy-no-date", "old", "mid", "new"])
    }

    func testTotalTiesFallBackToTheKeySoTheOrderNeverFlickers() {
        let rows = [row("z"), row("m"), row("a")]
        XCTAssertEqual(keys(SpaceRanking.sorted(rows, by: .leastPlayed)), ["a", "m", "z"])
        XCTAssertEqual(keys(SpaceRanking.sorted(rows.reversed(), by: .leastPlayed)), ["a", "m", "z"])
    }

    func testAPlayedSongBeatsNothingAndNeverPlayedWithAnOldDateStillWins() {
        // "never played" = 0 counted plays; it goes before a song with ANY counted play, even a very old one.
        let rows = [row("old-but-played", plays: 1, last: d(0)), row("never", plays: 0, last: nil, added: d(50))]
        XCTAssertEqual(keys(SpaceRanking.sorted(rows, by: .leastPlayed)), ["never", "old-but-played"])
    }

    func testOtherOrderings() {
        let rows = [
            row("b", plays: 1, added: d(5), bytes: 3_000_000, title: "Beta"),
            row("a", plays: 9, added: d(9), bytes: 9_000_000, title: "alfa"),
            row("c", plays: 0, added: d(1), bytes: 6_000_000, title: "Charlie"),
        ]
        XCTAssertEqual(keys(SpaceRanking.sorted(rows, by: .largest)), ["a", "c", "b"])
        XCTAssertEqual(keys(SpaceRanking.sorted(rows, by: .oldest)), ["c", "b", "a"])
        XCTAssertEqual(keys(SpaceRanking.sorted(rows, by: .name)), ["a", "b", "c"], "case-insensitive: alfa, Beta, Charlie")
    }

    func testLargestBreaksTiesByName() {
        let rows = [row("x", bytes: 5, title: "Zeta"), row("y", bytes: 5, title: "Alfa")]
        XCTAssertEqual(keys(SpaceRanking.sorted(rows, by: .largest)), ["y", "x"])
    }

    // MARK: shortcuts

    func testLeastPlayedCountTakesTheFirstN() {
        let rows = (1...10).map { row("s\($0)", plays: 10 - $0, last: d($0)) }     // s10 has 0 plays … s1 has 9
        XCTAssertEqual(keys(SpaceRanking.leastPlayed(rows, count: 3)), ["s10", "s9", "s8"])
        XCTAssertEqual(SpaceRanking.leastPlayed(rows, count: 99).count, 10, "asking for more than there is takes everything")
        XCTAssertTrue(SpaceRanking.leastPlayed(rows, count: 0).isEmpty)
        XCTAssertTrue(SpaceRanking.leastPlayed(rows, count: -4).isEmpty)
    }

    func testFreeSpaceTakesLeastPlayedUntilTheTargetIsReachedCrossingSongIncluded() {
        let rows = [
            row("a", plays: 0, bytes: 40_000_000),
            row("b", plays: 1, bytes: 40_000_000),
            row("c", plays: 2, bytes: 40_000_000),
            row("d", plays: 3, bytes: 40_000_000),
        ]
        XCTAssertEqual(keys(SpaceRanking.toFree(rows, bytes: 100_000_000)), ["a", "b", "c"], "40+40 < 100, +40 crosses it")
        XCTAssertEqual(keys(SpaceRanking.toFree(rows, bytes: 80_000_000)), ["a", "b"], "exactly 80 MB is enough")
        XCTAssertEqual(keys(SpaceRanking.toFree(rows, bytes: 1)), ["a"])
    }

    func testFreeSpaceWithAnUnreachableTargetTakesEverythingAndZeroTakesNothing() {
        let rows = [row("a", bytes: 10_000_000), row("b", bytes: 10_000_000)]
        XCTAssertEqual(SpaceRanking.toFree(rows, bytes: 1_000_000_000).count, 2)
        XCTAssertTrue(SpaceRanking.toFree(rows, bytes: 0).isEmpty)
        XCTAssertTrue(SpaceRanking.toFree(rows, bytes: -5).isEmpty)
    }

    func testMegabytesAreDecimalLikeTheByteFormatter() {
        XCTAssertEqual(SpaceRanking.bytes(forMB: 100), 100_000_000)
        XCTAssertEqual(SpaceRanking.bytes(forMB: 1000), 1_000_000_000)
    }
}

// MARK: - Plans, double confirmation (D7), dialogs

final class DeletionConfirmationTests: XCTestCase {
    private func plan(_ n: Int, reason: DeletionPlan.Reason = .manual) -> DeletionPlan {
        let rows = (1...max(1, n)).map { TestSupport.spaceRow("s\($0)", title: "Song \($0)") }
        switch reason {
        case .manual: return .manual(Array(rows.prefix(n)))
        case .leastPlayed: return .leastPlayed(from: rows, count: n)
        case .freeSpace: return .freeSpace(from: rows, mb: 10)
        }
    }

    func testOneSongNeedsOneConfirmationAnyBlockNeedsTwo() {
        XCTAssertEqual(plan(1).requiredConfirmations, 1)
        XCTAssertEqual(plan(2).requiredConfirmations, 2)
        XCTAssertEqual(plan(25, reason: .leastPlayed).requiredConfirmations, 2)
        XCTAssertEqual(plan(5, reason: .freeSpace).requiredConfirmations, 2, "however the block was chosen")
        XCTAssertEqual(plan(1, reason: .leastPlayed).requiredConfirmations, 1, "a 'block' of one song is one song")
    }

    func testASingleSongGoesThroughOneDialog() {
        var flow = DeletionConfirmation()
        flow.begin(plan(1))
        XCTAssertTrue(flow.isAskingFirst)
        flow.accept()
        guard case .confirmed(let p, let confirmations) = flow.stage else { return XCTFail("\(flow.stage)") }
        XCTAssertEqual(confirmations, 1)
        XCTAssertEqual(p.count, 1)
    }

    func testABlockGoesThroughTwoDialogsInOrder() {
        var flow = DeletionConfirmation()
        flow.begin(plan(3))
        XCTAssertTrue(flow.isAskingFirst)
        flow.accept()
        XCTAssertTrue(flow.isAskingSecond, "the first OK is not enough for a block")
        guard case .second = flow.stage else { return XCTFail() }
        flow.accept()
        guard case .confirmed(let p, let confirmations) = flow.stage else { return XCTFail("\(flow.stage)") }
        XCTAssertEqual(confirmations, 2)
        XCTAssertEqual(p.count, 3)
    }

    func testCancelAtTheFirstStepDeletesNothing() {
        var flow = DeletionConfirmation()
        flow.begin(plan(3))
        flow.cancel()
        XCTAssertEqual(flow.stage, .cancelled)
        flow.accept()                                              // a stray accept after cancelling
        XCTAssertEqual(flow.stage, .cancelled, "nothing can resurrect a cancelled request")
    }

    func testCancelAtTheSecondStepDeletesNothing() {
        var flow = DeletionConfirmation()
        flow.begin(plan(3))
        flow.accept()
        XCTAssertTrue(flow.isAskingSecond)
        flow.cancel()
        XCTAssertEqual(flow.stage, .cancelled)
        flow.accept()
        XCTAssertEqual(flow.stage, .cancelled)
    }

    func testNoWayToConfirmWithoutTheDialogs() {
        var flow = DeletionConfirmation()
        flow.accept()                                              // nothing open
        XCTAssertEqual(flow.stage, .idle)
        flow.begin(plan(3))
        guard case .confirmed = flow.stage else { return }          // must not be confirmed yet
        XCTFail("begin must only OPEN the first dialog")
    }

    func testBeginIsIgnoredWhileADialogIsOpen() {
        var flow = DeletionConfirmation()
        flow.begin(plan(3))
        flow.begin(plan(1))                                        // another request sneaks in
        guard case .first(let p) = flow.stage else { return XCTFail() }
        XCTAssertEqual(p.count, 3, "the plan the user is looking at is the plan he confirms")
        flow.accept()
        flow.begin(plan(1))
        guard case .second(let q) = flow.stage else { return XCTFail() }
        XCTAssertEqual(q.count, 3)
    }

    func testAnEmptyPlanOpensNothing() {
        var flow = DeletionConfirmation()
        flow.begin(.manual([]))
        XCTAssertEqual(flow.stage, .idle)
    }

    func testAfterCancelOrConfirmAFreshRequestCanStart() {
        var flow = DeletionConfirmation()
        flow.begin(plan(2))
        flow.cancel()
        flow.begin(plan(4))
        guard case .first(let p) = flow.stage else { return XCTFail() }
        XCTAssertEqual(p.count, 4)
        flow.accept()
        flow.accept()
        flow.reset()
        XCTAssertEqual(flow.stage, .idle)
    }

    // MARK: wording

    func testFirstDialogOfABlockShowsCountSizeAndTheFirstTitles() {
        let rows = (1...25).map { TestSupport.spaceRow("s\($0)", plays: $0, bytes: 12_000_000, title: "Song \($0)") }   // Song 1 = least played
        let text = DeletionDialogs.first(.leastPlayed(from: rows, count: 25))
        XCTAssertEqual(text.title, "Eliminare 25 brani?")
        XCTAssertTrue(text.message.contains("25 brani"))
        XCTAssertTrue(text.message.contains(DeletionDialogs.megabytes(25 * 12_000_000)), "the MB are shown")
        XCTAssertTrue(text.message.contains("«Song 1», «Song 2», «Song 3»"))
        XCTAssertFalse(text.message.contains("«Song 4»"), "only the first few titles")
        XCTAssertTrue(text.message.contains("e altri 22"))
    }

    func testFirstDialogOfAFewSongsListsThemAll() {
        let rows = [TestSupport.spaceRow("a", title: "Alfa"), TestSupport.spaceRow("b", title: "Beta")]
        let text = DeletionDialogs.first(.manual(rows))
        XCTAssertTrue(text.message.contains("«Alfa», «Beta»"))
        XCTAssertFalse(text.message.contains("altri"))
    }

    func testSecondDialogIsTheSeiSicuroOne() {
        let rows = (1...4).map { TestSupport.spaceRow("s\($0)", bytes: 1_000_000) }
        let text = DeletionDialogs.second(.manual(rows))
        XCTAssertEqual(text.title, "Sei sicuro?")
        XCTAssertTrue(text.message.contains("Non si può annullare"))
        XCTAssertEqual(text.confirmTitle, "Elimina 4 brani", "the destructive button says how many")
        XCTAssertEqual(DeletionDialogs.cancelTitle, "Annulla")
    }

    func testSingleSongDialogNamesTheSongAndExplainsRiscarica() {
        let text = DeletionDialogs.first(.manual([TestSupport.spaceRow("a", title: "White Flag")]))
        XCTAssertEqual(text.title, "Eliminare «White Flag»?")
        XCTAssertTrue(text.message.contains("Riscarica"))
        XCTAssertEqual(text.confirmTitle, "Elimina")
    }

    // MARK: criteria

    func testTheCriteriaFollowHowTheBlockWasChosen() {
        XCTAssertEqual(plan(5, reason: .leastPlayed).criteria, .init(count: 5, olderThanDays: nil, freeMB: nil))
        XCTAssertEqual(plan(3, reason: .freeSpace).criteria, .init(count: nil, olderThanDays: nil, freeMB: 10))
        XCTAssertEqual(plan(2).criteria, .init(count: nil, olderThanDays: nil, freeMB: nil))
    }

    func testLeastPlayedRemembersTheRequestedNEvenWhenThereAreFewerSongs() {
        let rows = (1...3).map { TestSupport.spaceRow("s\($0)") }
        let p = DeletionPlan.leastPlayed(from: rows, count: 20)
        XCTAssertEqual(p.count, 3)
        XCTAssertEqual(p.criteria.count, 20, "criteria.count is what was asked, count is what was deleted")
    }
}

// MARK: - The audit payload (docs/mondrop-stats.md §2)

final class DeleteSongsPayloadTests: XCTestCase {
    func testLeastPlayedBlockMatchesTheContractExample() throws {
        let rows = [
            TestSupport.spaceRow("song-a", plays: 0, last: nil, bytes: 6_291_456, title: "Song A", artist: "Artist A"),
            TestSupport.spaceRow("song-b", plays: 3, last: try XCTUnwrap(ISO.parse("2026-11-05T21:03:11Z")), bytes: 4_000_000, title: "Song B", artist: "Artist B"),
        ]
        let details = DeleteSongsDetails.make(plan: .leastPlayed(from: rows, count: 25), confirmations: 2)
        let event = DeviceEvent(id: "9A7B", at: try XCTUnwrap(ISO.parse("2026-11-08T09:40:00Z")), details: details)
        let json = try TestSupport.jsonObject(try EventCoding.encoder().encode(event))

        let expected: NSDictionary = [
            "id": "9A7B",
            "type": "delete_songs",
            "at": "2026-11-08T09:40:00Z",
            "details": [
                "reason": "least_played",
                "criteria": ["count": 25, "olderThanDays": NSNull()],
                "confirmations": 2,
                "count": 2,
                "bytes": 10_291_456,
                "songs": [
                    ["songKey": "song-a", "title": "Song A", "artist": "Artist A", "bytes": 6_291_456, "plays": 0, "lastPlayedAt": NSNull()],
                    ["songKey": "song-b", "title": "Song B", "artist": "Artist B", "bytes": 4_000_000, "plays": 3, "lastPlayedAt": "2026-11-05T21:03:11Z"],
                ],
            ],
        ]
        XCTAssertEqual(json, expected)
    }

    func testASingleManualDeletionIsRegisteredToo() {
        let details = DeleteSongsDetails.make(plan: .manual([TestSupport.spaceRow("k", bytes: 1234)]), confirmations: 1)
        XCTAssertEqual(details.reason, "manual")
        XCTAssertEqual(details.confirmations, 1)
        XCTAssertEqual(details.count, 1)
        XCTAssertEqual(details.bytes, 1234)
        XCTAssertEqual(details.songs.count, 1)
        XCTAssertNil(details.criteria.count)
    }

    func testFreeSpaceCarriesTheTargetAndEverySongOnce() throws {
        let rows = (1...4).map { TestSupport.spaceRow("s\($0)", plays: $0, bytes: 40_000_000) }
        let details = DeleteSongsDetails.make(plan: .freeSpace(from: rows, mb: 100), confirmations: 2)
        XCTAssertEqual(details.reason, "free_space")
        XCTAssertEqual(details.criteria.freeMB, 100)
        XCTAssertNil(details.criteria.count)
        XCTAssertEqual(details.songs.map(\.songKey), ["s1", "s2", "s3"], "one entry per song, least played first")
        XCTAssertEqual(details.count, details.songs.count)
        XCTAssertEqual(details.bytes, details.songs.reduce(0) { $0 + $1.bytes })
        let json = try TestSupport.jsonObject(try EventCoding.encoder().encode(details))
        XCTAssertEqual((json["criteria"] as? NSDictionary)?["freeMB"] as? Int, 100)
    }

    func testThePayloadRoundTrips() throws {
        let event = TestSupport.deviceEvent("e1", songs: ["a", "b"])
        let data = try EventCoding.encoder().encode(event)
        XCTAssertEqual(try EventCoding.decoder().decode(DeviceEvent.self, from: data), event)
    }
}

// MARK: - Deleting (event first, then files)

@MainActor
final class SongDeleterTests: XCTestCase {
    private struct Rig {
        let store: OfflineStore
        let queue: EventQueue
        let deleter: SongDeleter
        let dir: URL
    }

    private func rig(songs: [String] = ["a", "b", "c"], ids: [String] = []) throws -> Rig {
        let dir = try TestSupport.tempDir("deleter")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let store = OfflineStore(root: dir.appendingPathComponent("store"))
        let queue = EventQueue(directory: dir.appendingPathComponent("queue"))
        var queued = ids
        let deleter = SongDeleter(
            store: store, queue: queue, uploader: nil,
            now: { Date(timeIntervalSince1970: 1_794_000_000) },
            makeId: { queued.isEmpty ? UUID().uuidString : queued.removeFirst() }
        )
        for key in songs {
            let staged = store.stagingURL()
            try Data(repeating: 1, count: 1000).write(to: staged)
            try store.install(stagedFile: staged, songKey: key, metadata: InstallMetadata(title: "T \(key)", artist: "A", version: "1-1"))
        }
        return Rig(store: store, queue: queue, deleter: deleter, dir: dir)
    }

    private func plan(_ r: Rig, _ keys: [String], reason: DeletionPlan.Reason = .manual) -> DeletionPlan {
        let rows = r.store.spaceRows().filter { keys.contains($0.songKey) }
        return reason == .leastPlayed ? .leastPlayed(from: rows, count: keys.count) : .manual(rows)
    }

    func testABlockWithASingleConfirmationIsRefusedAndNothingHappens() throws {
        let r = try rig()
        XCTAssertThrowsError(try r.deleter.execute(plan(r, ["a", "b"]), confirmations: 1)) {
            XCTAssertEqual($0 as? SongDeleter.DeleteError, .insufficientConfirmations)
        }
        XCTAssertEqual(r.store.loadIndex().count, 3, "files untouched")
        XCTAssertEqual(r.queue.count, 0, "no event either: nothing happened")
        XCTAssertTrue(r.store.skippedKeys.isEmpty)
    }

    func testIfTheEventCannotBeWrittenNothingIsDeleted() throws {
        let r = try rig()
        // The queue file path is occupied by a directory: the event cannot be made durable.
        try FileManager.default.createDirectory(at: r.dir.appendingPathComponent("queue/event-queue.jsonl"), withIntermediateDirectories: true)

        XCTAssertThrowsError(try r.deleter.execute(plan(r, ["a", "b"]), confirmations: 2)) {
            XCTAssertEqual($0 as? SongDeleter.DeleteError, .eventNotDurable)
        }
        XCTAssertEqual(Set(r.store.loadIndex().map(\.songKey)), ["a", "b", "c"], "no durable event → no deletion: the log can never miss one")
        XCTAssertNotNil(r.store.fileURL(songKey: "a"))
        XCTAssertTrue(r.store.skippedKeys.isEmpty)
    }

    func testABlockIsDeletedWithItsAuditEventAndSkipListed() throws {
        let r = try rig(ids: ["event-1"])
        r.store.recordServerNumbers(songKey: "b", plays: 4, lastPlayedAt: try XCTUnwrap(ISO.parse("2026-11-05T21:03:11Z")))

        let result = try r.deleter.execute(plan(r, ["a", "b"]), confirmations: 2)

        XCTAssertEqual(result, SongDeleter.Result(count: 2, bytes: 2000))
        XCTAssertEqual(r.store.loadIndex().map(\.songKey), ["c"], "files and index entries are gone")
        XCTAssertNil(r.store.fileURL(songKey: "a"))
        XCTAssertEqual(r.store.skippedKeys, ["a", "b"], "Sync will not bring them back until Riscarica")

        let events = r.queue.pendingDeviceEvents(limit: 10)
        XCTAssertEqual(events.map(\.id), ["event-1"])
        let e = try XCTUnwrap(events.first)
        XCTAssertEqual(e.type, "delete_songs")
        XCTAssertEqual(e.details.confirmations, 2)
        XCTAssertEqual(e.details.reason, "manual")
        XCTAssertEqual(e.details.count, 2)
        XCTAssertEqual(e.details.bytes, 2000)
        let b = try XCTUnwrap(e.details.songs.first { $0.songKey == "b" })
        XCTAssertEqual(b.plays, 4, "the numbers at the moment of the deletion")
        XCTAssertEqual(b.lastPlayedAt, ISO.parse("2026-11-05T21:03:11Z"))
        XCTAssertEqual(b.title, "T b")
    }

    func testASingleSongNeedsOnlyOneConfirmationAndIsRegistered() throws {
        let r = try rig()
        let result = try r.deleter.execute(plan(r, ["c"]), confirmations: 1)
        XCTAssertEqual(result.count, 1)
        let e = try XCTUnwrap(r.queue.pendingDeviceEvents(limit: 1).first)
        XCTAssertEqual(e.details.count, 1)
        XCTAssertEqual(e.details.confirmations, 1)
        XCTAssertEqual(r.store.skippedKeys, ["c"])
    }

    func testTheEventSurvivesARelaunchBeforeAnyUpload() throws {
        let r = try rig()
        try r.deleter.execute(plan(r, ["a", "b"]), confirmations: 2)
        let relaunched = EventQueue(directory: r.dir.appendingPathComponent("queue"))
        XCTAssertEqual(relaunched.deviceCount, 1, "durable: it is in the file, not only in memory")
    }

    func testAnEmptyPlanDoesNothing() throws {
        let r = try rig()
        let result = try r.deleter.execute(.manual([]), confirmations: 0)
        XCTAssertEqual(result, SongDeleter.Result(count: 0, bytes: 0))
        XCTAssertEqual(r.queue.count, 0)
    }
}

// MARK: - The screen's model

@MainActor
final class SpaceModelTests: XCTestCase {
    private struct Rig {
        let model: SpaceModel
        let store: OfflineStore
        let queue: EventQueue
        let api: FakeAPI
    }

    /// Songs s1…sN: s1 has the most plays, sN the fewest (so "meno ascoltate" = sN first).
    private func rig(songs n: Int = 6) throws -> Rig {
        let dir = try TestSupport.tempDir("space-model")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let store = OfflineStore(root: dir.appendingPathComponent("store"))
        let queue = EventQueue(directory: dir.appendingPathComponent("queue"))
        let api = FakeAPI()
        for i in 1...n {
            let staged = store.stagingURL()
            try Data(repeating: 1, count: 10_000_000).write(to: staged)
            try store.install(
                stagedFile: staged, songKey: "s\(i)",
                metadata: InstallMetadata(title: "Song \(i)", artist: "A", version: "1-1", plays: n - i, lastPlayedAt: TestSupport.day(i))
            )
        }
        let model = SpaceModel(store: store, queue: queue, uploader: nil, api: api)
        return Rig(model: model, store: store, queue: queue, api: api)
    }

    func testTheScreenShowsUsedSpaceAndTheLeastPlayedFirst() throws {
        let r = try rig()
        XCTAssertEqual(r.model.songCount, 6)
        XCTAssertEqual(r.model.usedBytes, 60_000_000)
        XCTAssertEqual(r.model.sort, .leastPlayed, "default sort (D9)")
        XCTAssertEqual(r.model.rows.map(\.songKey), ["s6", "s5", "s4", "s3", "s2", "s1"])
        r.model.sort = .name
        XCTAssertEqual(r.model.rows.first?.songKey, "s1")
        r.model.sort = .largest
        XCTAssertEqual(r.model.rows.count, 6)
    }

    func testTheNShortcutOpensTheFirstDialogAndDeletesNothingYet() throws {
        let r = try rig()
        r.model.leastPlayedCount = 3
        r.model.requestDeleteLeastPlayed()

        guard case .first(let plan) = r.model.confirmation.stage else { return XCTFail("\(r.model.confirmation.stage)") }
        XCTAssertEqual(plan.songs.map(\.songKey), ["s6", "s5", "s4"])
        XCTAssertEqual(plan.reason, .leastPlayed)
        XCTAssertEqual(r.model.selection, ["s6", "s5", "s4"], "the rows to be deleted are highlighted")
        XCTAssertEqual(r.store.loadIndex().count, 6, "a dialog is open, nothing is deleted")
        XCTAssertEqual(r.queue.count, 0)
    }

    func testABlockIsDeletedOnlyAfterBothConfirmations() throws {
        let r = try rig()
        r.model.leastPlayedCount = 3
        r.model.requestDeleteLeastPlayed()

        r.model.accept()                                           // first dialog
        XCTAssertTrue(r.model.confirmation.isAskingSecond)
        XCTAssertEqual(r.store.loadIndex().count, 6, "still nothing deleted after the first OK")
        XCTAssertEqual(r.queue.count, 0)

        r.model.accept()                                           // "Sei sicuro?"
        XCTAssertEqual(Set(r.store.loadIndex().map(\.songKey)), ["s1", "s2", "s3"])
        XCTAssertEqual(r.model.songCount, 3)
        XCTAssertEqual(r.model.confirmation.stage, .idle)
        XCTAssertTrue(r.model.message?.contains("Eliminati 3 brani") == true, r.model.message ?? "nil")
        XCTAssertEqual(r.store.skippedKeys, ["s4", "s5", "s6"])

        let e = try XCTUnwrap(r.queue.pendingDeviceEvents(limit: 1).first)
        XCTAssertEqual(e.details.reason, "least_played")
        XCTAssertEqual(e.details.criteria.count, 3)
        XCTAssertEqual(e.details.confirmations, 2)
        XCTAssertEqual(e.details.songs.map(\.songKey), ["s6", "s5", "s4"])
    }

    func testCancelAtEitherStepDeletesNothing() throws {
        let r = try rig()
        r.model.leastPlayedCount = 2
        r.model.requestDeleteLeastPlayed()
        r.model.cancel()                                           // at the first dialog
        XCTAssertEqual(r.model.confirmation.stage, .idle)
        XCTAssertTrue(r.model.selection.isEmpty)

        r.model.requestDeleteLeastPlayed()
        r.model.accept()
        r.model.cancel()                                           // at "Sei sicuro?"
        XCTAssertEqual(r.model.confirmation.stage, .idle)
        XCTAssertEqual(r.store.loadIndex().count, 6)
        XCTAssertEqual(r.queue.count, 0, "no event: nothing happened")
        XCTAssertTrue(r.store.skippedKeys.isEmpty)
    }

    func testASwipeOnOneSongAsksOnceAndDeletesIt() throws {
        let r = try rig()
        r.model.requestDelete(songKey: "s2")
        guard case .first(let plan) = r.model.confirmation.stage else { return XCTFail() }
        XCTAssertEqual(plan.requiredConfirmations, 1)
        r.model.accept()
        XCTAssertEqual(r.model.confirmation.stage, .idle)
        XCTAssertNil(r.store.fileURL(songKey: "s2"))
        XCTAssertEqual(r.store.loadIndex().count, 5)
        let e = try XCTUnwrap(r.queue.pendingDeviceEvents(limit: 1).first)
        XCTAssertEqual(e.details.confirmations, 1)
        XCTAssertEqual(e.details.reason, "manual")
    }

    func testTickedRowsAreABlockWhenMoreThanOne() throws {
        let r = try rig()
        r.model.toggle("s1")
        r.model.requestDeleteSelection()
        guard case .first(let one) = r.model.confirmation.stage else { return XCTFail() }
        XCTAssertEqual(one.requiredConfirmations, 1, "one ticked row = one song")
        r.model.cancel()                                           // cancelling also clears the ticks

        r.model.toggle("s1")
        r.model.toggle("s3")
        r.model.requestDeleteSelection()
        guard case .first(let two) = r.model.confirmation.stage else { return XCTFail() }
        XCTAssertEqual(two.requiredConfirmations, 2)
        XCTAssertEqual(Set(two.songs.map(\.songKey)), ["s1", "s3"])
    }

    func testFreeSpaceShortcutBuildsABlockByMegabytes() throws {
        let r = try rig()                                          // 10 MB per song
        r.model.requestFree(mb: 25)
        guard case .first(let plan) = r.model.confirmation.stage else { return XCTFail() }
        XCTAssertEqual(plan.songs.map(\.songKey), ["s6", "s5", "s4"], "10 + 10 < 25, + 10 crosses it")
        XCTAssertEqual(plan.reason, .freeSpace)
        XCTAssertEqual(plan.freeMB, 25)
        r.model.accept()
        r.model.accept()
        XCTAssertEqual(try XCTUnwrap(r.queue.pendingDeviceEvents(limit: 1).first).details.criteria.freeMB, 25)
    }

    func testNothingToDeleteSaysSoWithoutOpeningADialog() throws {
        let r = try rig(songs: 2)
        r.model.requestFree(mb: 0)
        XCTAssertEqual(r.model.confirmation.stage, .idle)
        XCTAssertEqual(r.model.message, "Nessun brano da eliminare.")
    }

    func testTheStepperStaysInsideTheLibrary() throws {
        let r = try rig(songs: 4)
        XCTAssertEqual(r.model.leastPlayedCount, 4, "default 20, but there are only 4 songs")
        r.model.leastPlayedCount = 1
        r.model.reload()
        XCTAssertEqual(r.model.leastPlayedCount, 1)
    }

    // MARK: songs that left every playlist

    func testTheOrphanShortcutReadsEveryPlaylistFirst() async throws {
        let r = try rig(songs: 3)
        r.api.setPlaylists([MondropPlaylist(id: "p1", name: "Uno", songCount: 2)])
        r.api.scriptManifests("p1", [.success(TestSupport.manifest("p1", [TestSupport.track("s1"), TestSupport.track("s2")]))])

        await r.model.requestDeleteOrphans()

        XCTAssertEqual(r.api.calls, ["playlists", "manifest:p1"], "memberships are refreshed before proposing anything")
        guard case .first(let plan) = r.model.confirmation.stage else { return XCTFail("\(r.model.confirmation.stage)") }
        XCTAssertEqual(plan.songs.map(\.songKey), ["s3"])
        XCTAssertEqual(r.store.loadIndex().count, 3, "only proposed, not deleted")
    }

    func testIfAPlaylistCannotBeReadNothingIsProposed() async throws {
        let r = try rig(songs: 3)
        r.api.setPlaylists([MondropPlaylist(id: "p1", name: "Uno", songCount: 1)])
        r.api.scriptManifests("p1", [.failure(MondropAPIError.http(500, nil))])
        await r.model.requestDeleteOrphans()
        XCTAssertEqual(r.model.confirmation.stage, .idle)
        XCTAssertTrue(r.model.message?.contains("non propongo niente") == true)
        XCTAssertEqual(r.store.loadIndex().count, 3)
    }

    func testEverySongInAPlaylistMeansNothingToDelete() async throws {
        let r = try rig(songs: 2)
        r.api.setPlaylists([MondropPlaylist(id: "p1", name: "Uno", songCount: 2)])
        r.api.scriptManifests("p1", [.success(TestSupport.manifest("p1", [TestSupport.track("s1"), TestSupport.track("s2")]))])
        await r.model.requestDeleteOrphans()
        XCTAssertEqual(r.model.confirmation.stage, .idle)
        XCTAssertEqual(r.model.message, "Ogni brano scaricato è ancora in una playlist.")
    }

    // MARK: numbers from the server

    func testRefreshingFromTheServerReordersTheRanking() async throws {
        let r = try rig(songs: 3)                                  // plays: s1=2, s2=1, s3=0 → ranking s3, s2, s1
        XCTAssertEqual(r.model.rows.map(\.songKey), ["s3", "s2", "s1"])
        // …but on ANOTHER device the user listened to s3 a lot: the server says so.
        r.api.setPlaylists([MondropPlaylist(id: "p1", name: "Uno", songCount: 3)])
        r.api.scriptManifests("p1", [.success(TestSupport.manifest("p1", [
            OfflineTrack(songKey: "s1", state: "ready", plays: 2),
            OfflineTrack(songKey: "s2", state: "ready", plays: 1),
            OfflineTrack(songKey: "s3", state: "ready", plays: 9, lastPlayedAt: "2026-11-07T10:00:00Z"),
        ]))])

        await r.model.refreshFromServer()

        XCTAssertEqual(r.model.rows.map(\.songKey), ["s2", "s1", "s3"])
        XCTAssertNil(r.model.refreshNote)
    }

    func testOfflineKeepsTheNumbersItHasAndSaysSo() async throws {
        let r = try rig(songs: 3)
        r.api.setPlaylists([MondropPlaylist(id: "p1", name: "Uno", songCount: 3)])
        r.api.scriptManifests("p1", [.failure(MondropAPIError.transport("offline"))])
        await r.model.refreshFromServer()
        XCTAssertEqual(r.model.rows.map(\.songKey), ["s3", "s2", "s1"], "the ranking still works offline")
        XCTAssertTrue(r.model.refreshNote?.contains("Numeri non aggiornati") == true)
    }
}
