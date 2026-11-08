import XCTest
@testable import Mondrop

/// docs/mondrop-stats.md §3–§4: numbers per song, dynamic playlists — every new field optional.
final class StatsDecodingTests: XCTestCase {
    func testPlaysAndLastPlayedAtAreReadFromTheManifest() throws {
        let json = #"""
        { "playlistId": "p", "name": "N", "tracks": [
          {"songKey": "a", "state": "ready", "plays": 12, "lastPlayedAt": "2026-11-05T21:03:11Z"},
          {"songKey": "b", "state": "ready", "plays": 0, "lastPlayedAt": null},
          {"songKey": "c", "state": "ready"} ] }
        """#
        let manifest = try JSONDecoder().decode(OfflineManifest.self, from: Data(json.utf8))
        XCTAssertEqual(manifest.tracks[0].plays, 12)
        XCTAssertEqual(manifest.tracks[0].lastPlayedDate, ISO.parse("2026-11-05T21:03:11Z"))
        XCTAssertEqual(manifest.tracks[1].plays, 0)
        XCTAssertNil(manifest.tracks[1].lastPlayedAt, "null = never played")
        XCTAssertNil(manifest.tracks[2].plays, "an older backend sends nothing")
        XCTAssertNil(manifest.tracks[2].lastPlayedDate)
    }

    func testFractionalSecondsInLastPlayedAtAreAccepted() throws {
        let t = try JSONDecoder().decode(OfflineTrack.self, from: Data(#"{"songKey":"a","plays":1,"lastPlayedAt":"2026-11-05T21:03:11.482Z"}"#.utf8))
        XCTAssertNotNil(t.lastPlayedDate)
    }

    func testTheOldManifestStillDecodesWithoutAnyOfIt() throws {
        let manifest = try ManifestFixtures.decode(ManifestFixtures.old)
        XCTAssertEqual(manifest.tracks.count, 4)
        XCTAssertTrue(manifest.tracks.allSatisfy { $0.plays == nil && $0.lastPlayedAt == nil })
        XCTAssertFalse(manifest.dynamic)
        XCTAssertNil(manifest.generatedAt)
    }

    func testASingleTrackAnswerCarriesTheNumbers() throws {
        let t = try MondropAPI.decodeTrack(Data(#"{"songKey":"a","state":"ready","plays":3,"lastPlayedAt":"2026-11-05T21:03:11Z"}"#.utf8))
        XCTAssertEqual(t.plays, 3)
    }

    func testADynamicManifestCarriesTheFlagAndGenerationTime() throws {
        let json = #"{"playlistId":"d1","name":"Mattina","dynamic":true,"generatedAt":"2026-11-08T06:55:00Z","tracks":[{"songKey":"a","state":"ready"}]}"#
        let manifest = try JSONDecoder().decode(OfflineManifest.self, from: Data(json.utf8))
        XCTAssertTrue(manifest.dynamic)
        XCTAssertEqual(manifest.generatedDate, ISO.parse("2026-11-08T06:55:00Z"))
        XCTAssertEqual(manifest.tracks.count, 1)
    }

    func testPlaylistsCarryKindAndRuleSummary() throws {
        let json = #"""
        { "playlists": [
          {"id": "s1", "name": "Road trip", "songCount": 12, "kind": "static"},
          {"id": "d1", "name": "Mattina", "songCount": 0, "kind": "dynamic",
           "rule": {"v": 1, "scope": "me", "order": "most_played"}, "ruleSummary": "Più ascoltate · 07:00–08:00 · ultimi 30 giorni"},
          {"id": "old", "name": "Vecchia", "songCount": 3} ] }
        """#
        struct Wrap: Decodable { let playlists: [MondropPlaylist] }
        let lists = try JSONDecoder().decode(Wrap.self, from: Data(json.utf8)).playlists
        XCTAssertFalse(lists[0].isDynamic)
        XCTAssertTrue(lists[1].isDynamic)
        XCTAssertEqual(lists[1].ruleSummary, "Più ascoltate · 07:00–08:00 · ultimi 30 giorni")
        XCTAssertFalse(lists[2].isDynamic, "an older backend has no kind: static")
        XCTAssertNil(lists[2].ruleSummary)
    }

    func testARuleBuiltPlaylistWithoutASongCountStillDecodes() throws {
        let p = try JSONDecoder().decode(MondropPlaylist.self, from: Data(#"{"id":"d","name":"Notte","kind":"dynamic"}"#.utf8))
        XCTAssertTrue(p.isDynamic)
        XCTAssertEqual(p.songCount, 0)
    }

    func testKindIsCaseInsensitive() throws {
        let p = try JSONDecoder().decode(MondropPlaylist.self, from: Data(#"{"id":"d","name":"N","songCount":1,"kind":"Dynamic"}"#.utf8))
        XCTAssertTrue(p.isDynamic)
    }
}

@MainActor
final class DynamicPlaylistSyncTests: XCTestCase {
    func testADynamicPlaylistSyncsLikeAnyOtherAndItsSongsAreRecordedAsMembers() async throws {
        let rig = try EngineRig()
        let dir = rig.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let api = FakeAPI()
        api.scriptPrepare("dyn", [OfflineManifest(playlistId: "dyn", name: "Mattina", tracks: [TestSupport.track("a"), TestSupport.track("b")], dynamic: true, generatedAt: "2026-11-08T06:55:00Z")])
        let coordinator = PlaylistSyncCoordinator(
            playlist: MondropPlaylist(id: "dyn", name: "Mattina", songCount: 0, kind: "dynamic", ruleSummary: "Più ascoltate"),
            api: api, engine: rig.engine, clock: FakeClock().clock
        )
        await coordinator.sync()
        XCTAssertEqual(rig.transport.startedKeys, ["a", "b"])
        XCTAssertEqual(rig.store.knownPlaylistIds, ["dyn"])
        XCTAssertTrue(coordinator.manifest?.dynamic == true)
    }

    func testSongsThatLeftADynamicPlaylistBecomeOrphansButAreNeverDeletedBySync() throws {
        let rig = try EngineRig()
        let dir = rig.root
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        try rig.installLocal("was-in", version: "100-1")
        try rig.installLocal("still-in", version: "100-1")
        rig.store.recordPlaylist(id: "dyn", name: "Mattina", songKeys: ["was-in", "still-in"])
        // next Sync: the rule now yields different songs
        rig.store.recordPlaylist(id: "dyn", name: "Mattina", songKeys: ["still-in", "new"])
        XCTAssertEqual(rig.store.orphans().map(\.songKey), ["was-in"], "an orphan, removable only on explicit action")
        XCTAssertNotNil(rig.store.fileURL(songKey: "was-in"), "nothing was deleted by the sync itself")
    }
}

final class PlayStatTests: XCTestCase {
    private func makeStore() throws -> (OfflineStore, URL) {
        let dir = try TestSupport.tempDir("stats")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return (OfflineStore(root: dir), dir)
    }

    @discardableResult
    private func install(_ store: OfflineStore, _ key: String, plays: Int? = nil, last: Date? = nil) throws -> OfflineStore.Item {
        let staged = store.stagingURL()
        try Data(repeating: 1, count: 100).write(to: staged)
        return try store.install(stagedFile: staged, songKey: key, metadata: InstallMetadata(title: key, artist: "A", version: "1-1", plays: plays, lastPlayedAt: last))
    }

    func testTheServerNumbersArrivedWithTheDownloadAreKept() throws {
        let (store, _) = try makeStore()
        try install(store, "a", plays: 7, last: TestSupport.day(3))
        XCTAssertEqual(store.stat(songKey: "a"), PlayStat(plays: 7, lastPlayedAt: TestSupport.day(3), unsynced: 0))
    }

    func testACountedListenBumpsTheNumbersRightAwayEvenOffline() throws {
        let (store, _) = try makeStore()
        try install(store, "a", plays: 7, last: TestSupport.day(3))
        store.bumpLocalPlay(songKey: "a", at: TestSupport.day(9))
        let stat = try XCTUnwrap(store.stat(songKey: "a"))
        XCTAssertEqual(stat.plays, 8)
        XCTAssertEqual(stat.lastPlayedAt, TestSupport.day(9))
        XCTAssertEqual(stat.unsynced, 1)
        XCTAssertEqual(store.spaceRows().first?.plays, 8, "the ranking sees it at once")
    }

    func testTheLastPlayNeverGoesBackwards() throws {
        let (store, _) = try makeStore()
        try install(store, "a", plays: 1, last: TestSupport.day(9))
        store.bumpLocalPlay(songKey: "a", at: TestSupport.day(2))        // a late-delivered older event
        XCTAssertEqual(store.stat(songKey: "a")?.lastPlayedAt, TestSupport.day(9))
    }

    func testServerNumbersKeepThePendingLocalListensOnTop() throws {
        let (store, _) = try makeStore()
        try install(store, "a", plays: 7)
        store.bumpLocalPlay(songKey: "a", at: TestSupport.day(5))
        store.bumpLocalPlay(songKey: "a", at: TestSupport.day(6))        // 2 listens the server has not seen yet
        store.recordServerNumbers(songKey: "a", plays: 7, lastPlayedAt: TestSupport.day(1))   // a sync that predates them
        XCTAssertEqual(store.stat(songKey: "a")?.plays, 9, "server 7 + 2 unacknowledged: the ranking never goes backwards")
        XCTAssertEqual(store.stat(songKey: "a")?.lastPlayedAt, TestSupport.day(6))
    }

    func testAcknowledgeSettlesOnlyCountedListens() throws {
        let (store, _) = try makeStore()
        try install(store, "a", plays: 0)
        let counted = TestSupport.playEvent("e1", songKey: "a", listenedMs: 60_000, durationMs: 200_000)
        let skipped = TestSupport.playEvent("e2", songKey: "a", listenedMs: 4_000, durationMs: 200_000)
        let stillWaiting = TestSupport.playEvent("e3", songKey: "a", listenedMs: 90_000, durationMs: 200_000)
        store.bumpLocalPlay(songKey: "a", at: counted.startedAt)
        store.bumpLocalPlay(songKey: "a", at: stillWaiting.startedAt)      // a second counted listen, not in the acknowledged batch
        XCTAssertEqual(store.stat(songKey: "a")?.unsynced, 2)

        store.settleAckedPlays([counted, skipped])                          // the batch: one counted listen + one 4 s skip

        XCTAssertEqual(store.stat(songKey: "a")?.unsynced, 1, "the skip was never bumped, so it must not settle anything")
        XCTAssertEqual(store.stat(songKey: "a")?.plays, 2)
    }

    func testAcknowledgementThenTheNextSyncIsConsistent() throws {
        let (store, _) = try makeStore()
        try install(store, "a", plays: 7)
        let e = TestSupport.playEvent("e1", songKey: "a", listenedMs: 60_000, durationMs: 200_000)
        store.bumpLocalPlay(songKey: "a", at: e.startedAt)
        store.settleAckedPlays([e])
        store.recordServerNumbers(songKey: "a", plays: 8, lastPlayedAt: e.startedAt)     // the server now counts it
        XCTAssertEqual(store.stat(songKey: "a")?.plays, 8, "not 9: it is not counted twice")
    }

    func testAStreamedOnlySongKeepsAStatOnlyWhileListensArePending() throws {
        let (store, _) = try makeStore()
        let e = TestSupport.playEvent("e1", songKey: "streamed", listenedMs: 60_000, durationMs: 200_000)
        store.recordServerNumbers(songKey: "streamed", plays: 5, lastPlayedAt: nil)
        XCTAssertNil(store.stat(songKey: "streamed"), "numbers only matter for songs on the phone")
        store.bumpLocalPlay(songKey: "streamed", at: e.startedAt)
        XCTAssertEqual(store.stat(songKey: "streamed")?.unsynced, 1)
        store.settleAckedPlays([e])
        XCTAssertNil(store.stat(songKey: "streamed"), "acknowledged and not on the phone: forgotten")
    }

    func testNumbersFromAManifestUpdateEverySongOnThePhone() throws {
        let (store, _) = try makeStore()
        try install(store, "a", plays: 1)
        try install(store, "b", plays: 1)
        let manifest = OfflineManifest(playlistId: "p", name: "P", tracks: [
            OfflineTrack(songKey: "a", state: "ready", plays: 10, lastPlayedAt: "2026-11-06T10:00:00Z"),
            OfflineTrack(songKey: "b", state: "ready"),                                  // older backend: no numbers
            OfflineTrack(songKey: "not-local", state: "ready", plays: 4),
        ])
        store.recordServerNumbers(from: manifest)
        XCTAssertEqual(store.stat(songKey: "a")?.plays, 10)
        XCTAssertEqual(store.stat(songKey: "b")?.plays, 1, "no numbers sent: what we had stays")
        XCTAssertNil(store.stat(songKey: "not-local"))
    }

    func testRemovingASongForgetsItsStatUnlessListensArePending() throws {
        let (store, _) = try makeStore()
        try install(store, "a", plays: 3)
        try install(store, "b", plays: 3)
        store.bumpLocalPlay(songKey: "b", at: TestSupport.day(1))
        store.removeSongs(["a", "b"])
        XCTAssertNil(store.stat(songKey: "a"))
        XCTAssertEqual(store.stat(songKey: "b")?.unsynced, 1, "the pending listen must still be settled when its event is acknowledged")
    }

    func testStatsSurviveARelaunch() throws {
        let (store, dir) = try makeStore()
        try install(store, "a", plays: 3, last: TestSupport.day(2))
        store.bumpLocalPlay(songKey: "a", at: TestSupport.day(4))
        let relaunched = OfflineStore(root: dir)
        XCTAssertEqual(relaunched.stat(songKey: "a"), PlayStat(plays: 4, lastPlayedAt: TestSupport.day(4), unsynced: 1))
    }

    func testAnIndexWrittenByTheEarlierBuildStillLoads() throws {
        // What build 4 wrote: no playStats, no skipped, version 2. It must load — not be set aside as corrupt.
        let dir = try TestSupport.tempDir("old-index")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("Offline/old-0123456789.mp3")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(repeating: 1, count: 500).write(to: file)
        let old = #"""
        {"version":2,"legacyMigrated":true,"lyricsOverrides":{"old::song":"parole"},
         "playlists":{"p1":{"name":"Uno","songKeys":["old::song"],"seenAt":"2026-11-06T10:00:00Z"}},
         "items":[{"songKey":"old::song","title":"Old","artist":"A","relativePath":"Offline/old-0123456789.mp3",
                   "version":"500-9","bytes":500,"addedAt":"2026-11-06T09:00:00Z"}]}
        """#
        try Data(old.utf8).write(to: dir.appendingPathComponent("offline-index.json"))

        let store = OfflineStore(root: dir)

        XCTAssertEqual(store.loadIndex().map(\.songKey), ["old::song"], "the downloaded songs are still there")
        XCTAssertEqual(store.lyrics(for: "old::song"), "parole")
        XCTAssertEqual(store.knownPlaylistIds, ["p1"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("offline-index.corrupt.json").path))
        XCTAssertTrue(store.skippedKeys.isEmpty)
        XCTAssertNil(store.stat(songKey: "old::song"))
        XCTAssertEqual(store.spaceRows().first?.plays, 0, "no numbers yet: the next manifest fills them")
    }

    func testSpaceRowsReportTheOnDiskSizeAndSkipEmptyFiles() throws {
        let (store, _) = try makeStore()
        let item = try install(store, "a")
        try install(store, "b")
        try Data(repeating: 1, count: 40).write(to: try XCTUnwrap(store.fileURL(for: item)))
        try Data().write(to: try XCTUnwrap(store.fileURL(songKey: "b")))
        let rows = store.spaceRows()
        XCTAssertEqual(rows.map(\.songKey), ["a"], "an empty file is never a song")
        XCTAssertEqual(rows.first?.bytes, 40)
    }
}

@MainActor
final class PlayRecorderTests: XCTestCase {
    private struct Rig {
        let recorder: PlayRecorder
        let queue: EventQueue
        let store: OfflineStore
        let transport: FakeEventTransport
        let clock: FakeTrackerClock
        let journal: MemoryJournal
        let uploader: EventUploader
    }

    private func rig() throws -> Rig {
        let dir = try TestSupport.tempDir("recorder")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let queue = EventQueue(directory: dir.appendingPathComponent("q"))
        let store = OfflineStore(root: dir.appendingPathComponent("s"))
        let transport = FakeEventTransport()
        var config = UploaderConfig()
        config.threshold = 3
        let uploader = EventUploader(queue: queue, transport: transport, store: store, clock: FakeClock().clock, config: config)
        let clock = FakeTrackerClock()
        let journal = MemoryJournal()
        let recorder = PlayRecorder(queue: queue, store: store, uploader: uploader, journal: journal, clock: clock.clock, timeZone: { TimeZone(identifier: "Europe/Rome")! })
        let staged = store.stagingURL()
        try Data(repeating: 1, count: 100).write(to: staged)
        try store.install(stagedFile: staged, songKey: "a", metadata: InstallMetadata(title: "A", artist: "X", version: "1-1", plays: 2))
        return Rig(recorder: recorder, queue: queue, store: store, transport: transport, clock: clock, journal: journal, uploader: uploader)
    }

    private func listen(_ r: Rig, key: String = "a", seconds: TimeInterval, duration: Int? = 200_000, completed: Bool = false) {
        r.recorder.tracker.begin(songKey: key, durationMs: duration, origin: .local, playlistId: "p1")
        r.recorder.tracker.setPlaying(true)
        r.clock.advance(seconds)
        r.recorder.tracker.finish(completed: completed)
    }

    func testAFinishedSessionIsQueuedDurablyAndBumpsTheLocalNumbers() throws {
        let r = try rig()
        listen(r, seconds: 45)
        XCTAssertEqual(r.queue.playCount, 1)
        XCTAssertEqual(r.store.stat(songKey: "a")?.plays, 3, "counted (≥ 30 s): 2 + 1, even offline")
        XCTAssertEqual(r.store.stat(songKey: "a")?.unsynced, 1)
    }

    func testAShortListenIsQueuedButNotCounted() throws {
        let r = try rig()
        listen(r, seconds: 10)                                     // ≥ 3 s: recorded; < 30 s of 200: a skip
        XCTAssertEqual(r.queue.playCount, 1, "the server decides, but it needs the raw fact")
        XCTAssertEqual(r.store.stat(songKey: "a")?.plays, 2)
        XCTAssertEqual(r.store.stat(songKey: "a")?.unsynced, 0)
    }

    func testAnUnderThreeSecondSessionIsNotEvenQueued() throws {
        let r = try rig()
        listen(r, seconds: 2)
        XCTAssertEqual(r.queue.count, 0)
    }

    func testARecoveredSessionIsNeitherQueuedNorCountedTwice() throws {
        let r = try rig()
        r.journal.failToClear = true                               // the app died between "queued" and "journal cleared"
        r.recorder.tracker.begin(songKey: "a", durationMs: 200_000, origin: .local, playlistId: nil)
        r.recorder.tracker.setPlaying(true)
        r.clock.advance(60)
        r.recorder.tracker.checkpoint()
        r.recorder.tracker.finish(completed: true)
        XCTAssertEqual(r.queue.playCount, 1)
        XCTAssertEqual(r.store.stat(songKey: "a")?.unsynced, 1)

        r.journal.failToClear = false
        r.recorder.recoverInterruptedSession()                     // next launch: same id comes back

        XCTAssertEqual(r.queue.playCount, 1, "same id: not queued again")
        XCTAssertEqual(r.store.stat(songKey: "a")?.unsynced, 1, "…and not counted again")
        XCTAssertEqual(r.store.stat(songKey: "a")?.plays, 3)
    }

    func testAGenuinelyInterruptedSessionIsRecoveredAtLaunch() throws {
        let r = try rig()
        r.recorder.tracker.begin(songKey: "a", durationMs: 200_000, origin: .stream, playlistId: "p1")
        r.recorder.tracker.setPlaying(true)
        r.clock.advance(50)
        r.recorder.checkpoint()                                    // the scene went to background, then the app was killed
        XCTAssertEqual(r.queue.playCount, 0)

        // Next launch = a NEW process: new recorder, new tracker, same files on disk.
        let relaunched = PlayRecorder(queue: r.queue, store: r.store, uploader: nil, journal: r.journal, clock: r.clock.clock)
        relaunched.recoverInterruptedSession()

        let e = try XCTUnwrap(r.queue.pendingPlays(limit: 1).first)
        XCTAssertEqual(e.listenedMs, 50_000)
        XCTAssertEqual(e.origin, .stream)
        XCTAssertEqual(r.store.stat(songKey: "a")?.plays, 3)
    }

    func testReachingTheThresholdTriggersTheUpload() async throws {
        let r = try rig()                                          // threshold 3 in this rig
        for _ in 0..<3 { listen(r, seconds: 40) }
        await r.uploader.waitForScheduledFlush()
        XCTAssertEqual(r.transport.playCalls.map(\.count), [3])
        XCTAssertEqual(r.queue.count, 0)
        XCTAssertEqual(r.store.stat(songKey: "a")?.unsynced, 0, "acknowledged by the upload")
        XCTAssertEqual(r.store.stat(songKey: "a")?.plays, 5)
    }

    func testTheQueueDroppingAPlayEventSettlesItsPendingNumber() throws {
        let dir = try TestSupport.tempDir("recorder-drop")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let queue = EventQueue(directory: dir.appendingPathComponent("q"), capacity: 10)
        let store = OfflineStore(root: dir.appendingPathComponent("s"))
        let clock = FakeTrackerClock()
        let recorder = PlayRecorder(queue: queue, store: store, uploader: nil, journal: MemoryJournal(), clock: clock.clock)
        let staged = store.stagingURL()
        try Data(repeating: 1, count: 100).write(to: staged)
        try store.install(stagedFile: staged, songKey: "a", metadata: InstallMetadata(title: "A", artist: "X", version: "1-1"))

        for _ in 0..<12 {                                          // more counted listens than the queue can hold
            recorder.tracker.begin(songKey: "a", durationMs: 200_000, origin: .local, playlistId: nil)
            recorder.tracker.setPlaying(true)
            clock.advance(40)
            recorder.tracker.finish(completed: false)
        }
        XCTAssertGreaterThan(queue.droppedCount, 0)
        XCTAssertEqual(store.stat(songKey: "a")?.unsynced, queue.playCount, "a dropped event will never be acknowledged: it must not stay 'pending'")
        XCTAssertEqual(store.stat(songKey: "a")?.plays, 12, "the listens still count locally")
    }
}
