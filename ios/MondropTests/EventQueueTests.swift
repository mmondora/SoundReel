import XCTest
@testable import Mondrop

final class EventQueueTests: XCTestCase {
    private func makeQueue(capacity: Int = EventQueue.defaultCapacity, dir: URL? = nil) throws -> (EventQueue, URL) {
        let directory = try dir ?? TestSupport.tempDir("queue")
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return (EventQueue(directory: directory, capacity: capacity), directory)
    }

    private func play(_ id: String, key: String = "a") -> EventQueue.Record { .play(TestSupport.playEvent(id, songKey: key)) }
    private func device(_ id: String) -> EventQueue.Record { .device(TestSupport.deviceEvent(id)) }

    // MARK: persistence

    func testEventsSurviveARelaunchInOrder() throws {
        let (queue, dir) = try makeQueue()
        try queue.append(play("p1"))
        try queue.append(device("d1"))
        try queue.append(play("p2"))

        let relaunched = EventQueue(directory: dir)
        XCTAssertEqual(relaunched.count, 3)
        XCTAssertEqual(relaunched.pendingPlays(limit: 10).map(\.id), ["p1", "p2"])
        XCTAssertEqual(relaunched.pendingDeviceEvents(limit: 10).map(\.id), ["d1"])
    }

    func testTheFileIsJsonLinesWithOneRecordPerLine() throws {
        let (queue, dir) = try makeQueue()
        try queue.append(play("p1"))
        try queue.append(device("d1"))
        let text = try String(contentsOf: dir.appendingPathComponent("event-queue.jsonl"), encoding: .utf8)
        let lines = text.split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.count, 2)
        let kinds = try lines.map { line in
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])["k"] as? String
        }
        XCTAssertEqual(kinds, ["play", "device"])
        XCTAssertTrue(text.hasSuffix("\n"))
    }

    func testTheQueueFilesAreExcludedFromBackup() throws {
        let (queue, dir) = try makeQueue()
        try queue.append(play("p1"))
        queue.markUploaded(at: Date())
        for name in ["event-queue.jsonl", "event-queue-meta.json"] {
            let url = dir.appendingPathComponent(name)
            XCTAssertEqual(try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true, name)
        }
        XCTAssertEqual(try dir.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    // MARK: idempotent ids

    func testTheSameIdIsNeverQueuedTwice() throws {
        let (queue, dir) = try makeQueue()
        XCTAssertEqual(try queue.append(play("same")), .added)
        XCTAssertEqual(try queue.append(play("same")), .duplicate, "a session recovered after a crash must not be queued again")
        XCTAssertEqual(try queue.append(device("same")), .duplicate, "ids are unique across both kinds")
        XCTAssertEqual(queue.count, 1)
        XCTAssertEqual(EventQueue(directory: dir).count, 1, "…and nothing was written for the duplicates")
    }

    func testAnIdCanBeQueuedAgainAfterTheServerAnswered() throws {
        let (queue, _) = try makeQueue()
        try queue.append(play("p1"))
        queue.remove(ids: ["p1"])
        XCTAssertEqual(try queue.append(play("p1")), .added)
    }

    func testDuplicateLinesInTheFileAreCollapsedOnLoad() throws {
        let (queue, dir) = try makeQueue()
        try queue.append(play("p1"))
        let file = dir.appendingPathComponent("event-queue.jsonl")
        let line = try String(contentsOf: file, encoding: .utf8)
        try (line + line).write(to: file, atomically: true, encoding: .utf8)     // a doubled write
        XCTAssertEqual(EventQueue(directory: dir).count, 1)
    }

    // MARK: removal + batches

    func testRemoveTakesOnlyTheGivenIdsAndIsDurable() throws {
        let (queue, dir) = try makeQueue()
        for i in 1...4 { try queue.append(play("p\(i)")) }
        queue.remove(ids: ["p2", "p4", "unknown"])
        XCTAssertEqual(queue.pendingPlays(limit: 10).map(\.id), ["p1", "p3"])
        XCTAssertEqual(EventQueue(directory: dir).pendingPlays(limit: 10).map(\.id), ["p1", "p3"])
    }

    func testPendingBatchesAreOldestFirstAndPerKind() throws {
        let (queue, _) = try makeQueue()
        try queue.append(play("p1"))
        try queue.append(device("d1"))
        try queue.append(play("p2"))
        try queue.append(play("p3"))
        XCTAssertEqual(queue.pendingPlays(limit: 2).map(\.id), ["p1", "p2"])
        XCTAssertEqual(queue.pendingDeviceEvents(limit: 5).map(\.id), ["d1"])
        XCTAssertEqual(queue.playCount, 3)
        XCTAssertEqual(queue.deviceCount, 1)
    }

    // MARK: capacity

    func testWhenFullTheOldestPlayEventsGoAndAreCounted() throws {
        let (queue, dir) = try makeQueue(capacity: 20)
        var dropped: [String] = []
        queue.onDrop = { dropped.append($0.id) }
        for i in 1...25 { try queue.append(play("p\(i)")) }

        XCTAssertLessThanOrEqual(queue.count, 20, "never above the cap")
        XCTAssertGreaterThan(queue.droppedCount, 0)
        XCTAssertEqual(queue.droppedCount, dropped.count, "the counter and onDrop agree")
        XCTAssertEqual(dropped.first, "p1", "the OLDEST goes first")
        XCTAssertEqual(queue.count + queue.droppedCount, 25, "nothing vanishes without being counted")
        XCTAssertTrue(queue.contains(id: "p25"), "the newest is always kept")
        XCTAssertFalse(queue.contains(id: "p1"))
        XCTAssertEqual(EventQueue(directory: dir).droppedCount, queue.droppedCount, "the counter survives a relaunch (Settings shows it)")
    }

    func testDeviceEventsOutliveDroppedPlayEvents() throws {
        let (queue, _) = try makeQueue(capacity: 20)
        try queue.append(device("audit-1"))                     // the OLDEST record of all
        for i in 1...30 { try queue.append(play("p\(i)")) }
        XCTAssertTrue(queue.contains(id: "audit-1"), "the audit trail of deleted songs is worth more than one listen")
    }

    func testWithOnlyDeviceEventsLeftTheOldestOfThoseGoes() throws {
        let (queue, _) = try makeQueue(capacity: 10)
        for i in 1...12 { try queue.append(device("d\(i)")) }
        XCTAssertLessThanOrEqual(queue.count, 10)
        XCTAssertFalse(queue.contains(id: "d1"))
        XCTAssertTrue(queue.contains(id: "d12"))
        XCTAssertGreaterThan(queue.droppedCount, 0)
    }

    // MARK: damage

    func testATornLastLineIsIgnoredAndTheFileIsRepairedBeforeTheNextAppend() throws {
        let (queue, dir) = try makeQueue()
        try queue.append(play("p1"))
        try queue.append(play("p2"))
        let file = dir.appendingPathComponent("event-queue.jsonl")
        var data = try Data(contentsOf: file)
        data.append(Data(#"{"k":"play","e":{"id":"torn","songK"#.utf8))     // power cut in the middle of a write
        try data.write(to: file)

        let relaunched = EventQueue(directory: dir)
        XCTAssertEqual(relaunched.count, 2, "the torn line is skipped, never fatal")
        try relaunched.append(play("p3"))

        let again = EventQueue(directory: dir)
        XCTAssertEqual(again.pendingPlays(limit: 10).map(\.id), ["p1", "p2", "p3"], "the new line did not get glued to the torn one")
        let lines = try String(contentsOf: file, encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(lines.count, 3)
    }

    func testGarbageLinesAreSkipped() throws {
        let (queue, dir) = try makeQueue()
        try queue.append(play("p1"))
        let file = dir.appendingPathComponent("event-queue.jsonl")
        var text = try String(contentsOf: file, encoding: .utf8)
        text += "not json at all\n{\"k\":\"alien\",\"e\":{}}\n"
        try text.write(to: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(EventQueue(directory: dir).count, 1)
    }

    func testAppendThrowsWhenTheFileCannotBeWrittenAndLeavesNoGhost() throws {
        let (queue, dir) = try makeQueue()
        // The queue file path is occupied by a DIRECTORY: nothing can be appended.
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("event-queue.jsonl"), withIntermediateDirectories: true)
        XCTAssertThrowsError(try queue.append(device("d1")))
        XCTAssertFalse(queue.contains(id: "d1"), "a failed write must not leave the id behind")
        XCTAssertEqual(queue.count, 0)
    }

    // MARK: meta

    func testLastUploadTimeSurvivesARelaunch() throws {
        let (queue, dir) = try makeQueue()
        XCTAssertNil(queue.lastUploadAt)
        let at = Date(timeIntervalSince1970: 1_794_000_123)
        queue.markUploaded(at: at)
        XCTAssertEqual(EventQueue(directory: dir).lastUploadAt, at)
    }
}
