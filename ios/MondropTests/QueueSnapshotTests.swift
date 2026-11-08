import XCTest
@testable import Mondrop

/// «Riprendi» (spec 2026-11-08-mondrop-home-spotify-design.md H4): the queue survives the app being closed and comes back PAUSED, on the same
/// song, with where the user was inside it. Until now the queue lived only in memory.
@MainActor
final class QueueSnapshotTests: XCTestCase {
    private var dir: URL!
    private var defaults: UserDefaults!
    private var suite = ""

    override func setUpWithError() throws {
        continueAfterFailure = false
        dir = try TestSupport.tempDir("queue-snapshot")
        suite = "mondrop.test.queue.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    private func store() -> QueueSnapshotStore { QueueSnapshotStore(directory: dir, defaults: defaults, positionKey: "position") }

    private func newPlayer(api: MondropAPIProtocol = FakeAPI()) -> LocalAudioPlayer {
        LocalAudioPlayer(store: OfflineStore(root: dir.appendingPathComponent("offline")), api: api, snapshots: store())
    }

    private func items(_ n: Int, withTracks: Bool = false) -> [QueueItem] {
        (1...n).map { i in
            QueueItem(
                songKey: "a::t\(i)", title: "t\(i)", artist: "a", coverPath: "/c/\(i)", lyrics: withTracks ? "la la la" : nil,
                track: withTracks ? TestSupport.track("a::t\(i)") : nil
            )
        }
    }

    // MARK: the snapshot

    func testAnEmptyQueueIsNothingToKeep() {
        XCTAssertNil(QueueSnapshot.make(queue: [], index: 0, label: nil, playlistId: nil))
    }

    func testTheSnapshotIsCompactItKeepsTheSongsAndNotWhatTheServerKnowsOfThem() throws {
        let snapshot = try XCTUnwrap(QueueSnapshot.make(queue: items(3, withTracks: true), index: 1, label: "Playlist · Road trip", playlistId: "pl1"))
        XCTAssertEqual(snapshot.items.map(\.songKey), ["a::t1", "a::t2", "a::t3"])
        XCTAssertEqual(snapshot.items[1], QueueSnapshot.Item(songKey: "a::t2", title: "t2", artist: "a", coverPath: "/c/2", coverURL: nil))
        XCTAssertEqual(snapshot.index, 1)
        XCTAssertEqual(snapshot.label, "Playlist · Road trip")
        XCTAssertEqual(snapshot.playlistId, "pl1")
        let json = String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)
        XCTAssertFalse(json.contains("la la la"), "the lyrics are not kept: they can be a page long")
        XCTAssertFalse(json.contains("downloadPath"), "addresses and state are asked again at the first play")
        XCTAssertFalse(json.contains("positionSeconds"), "the position has its own place")
    }

    func testTheIndexIsBroughtInsideTheQueue() throws {
        XCTAssertEqual(try XCTUnwrap(QueueSnapshot.make(queue: items(3), index: 9, label: nil, playlistId: nil)).index, 2)
        XCTAssertEqual(try XCTUnwrap(QueueSnapshot.make(queue: items(3), index: -4, label: nil, playlistId: nil)).index, 0)
    }

    func testALongQueueKeepsAWindowAroundTheSongThatIsPlaying() throws {
        let long = (0..<800).map { QueueItem(songKey: "k\($0)", title: "t", artist: "a") }
        /// The song the snapshot points at, or nil if the index points outside the kept songs (a failure to report, not a crash).
        func current(_ snapshot: QueueSnapshot) -> String? {
            snapshot.items.indices.contains(snapshot.index) ? snapshot.items[snapshot.index].songKey : nil
        }

        let late = try XCTUnwrap(QueueSnapshot.make(queue: long, index: 700, label: nil, playlistId: nil))
        XCTAssertEqual(late.items.count, QueueSnapshot.maxItems)
        XCTAssertEqual(current(late), "k700")
        XCTAssertEqual(late.items.first?.songKey, "k300")                // the window ends with the queue
        XCTAssertEqual(late.items.last?.songKey, "k799")

        let early = try XCTUnwrap(QueueSnapshot.make(queue: long, index: 10, label: nil, playlistId: nil))
        XCTAssertEqual(early.items.count, QueueSnapshot.maxItems)
        XCTAssertEqual(current(early), "k10")
        XCTAssertEqual(early.items.first?.songKey, "k0")

        let middle = try XCTUnwrap(QueueSnapshot.make(queue: long, index: 400, label: nil, playlistId: nil))
        XCTAssertEqual(current(middle), "k400")
        XCTAssertGreaterThanOrEqual(middle.index, QueueSnapshot.keptBefore)   // a few songs to go back to
    }

    func testAQueueUnderTheCapIsKeptWhole() throws {
        let queue = (0..<QueueSnapshot.maxItems).map { QueueItem(songKey: "k\($0)", title: "t", artist: "a") }
        let snapshot = try XCTUnwrap(QueueSnapshot.make(queue: queue, index: 499, label: nil, playlistId: nil))
        XCTAssertEqual(snapshot.items.count, 500)
        XCTAssertEqual(snapshot.index, 499)
    }

    func testTheQueueComesBackWithoutTheServersViewOfIt() throws {
        let snapshot = try XCTUnwrap(QueueSnapshot.make(queue: items(2, withTracks: true), index: 0, label: nil, playlistId: nil))
        let back = snapshot.queueItems
        XCTAssertEqual(back.map(\.songKey), ["a::t1", "a::t2"])
        XCTAssertEqual(back.map(\.coverPath), ["/c/1", "/c/2"])
        XCTAssertTrue(back.allSatisfy { $0.track == nil && $0.lyrics == nil })
    }

    // MARK: the store

    func testWhatWasKeptComesBack() throws {
        let kept = try XCTUnwrap(QueueSnapshot.make(queue: items(4), index: 2, label: "Album · Thriller", playlistId: "pl1"))
        store().save(kept)
        let loaded = try XCTUnwrap(store().load())
        XCTAssertEqual(loaded.items, kept.items)
        XCTAssertEqual(loaded.index, 2)
        XCTAssertEqual(loaded.label, "Album · Thriller")
        XCTAssertEqual(loaded.playlistId, "pl1")
        XCTAssertEqual(loaded.positionSeconds, 0)
    }

    func testNothingKeptIsNoQueue() {
        XCTAssertNil(store().load())
    }

    func testAFileThatCannotBeReadIsNoQueueNeverACrash() throws {
        try Data("{ not json".utf8).write(to: dir.appendingPathComponent("queue.json"))
        XCTAssertNil(store().load())
        try Data(#"{"items":[],"index":0}"#.utf8).write(to: dir.appendingPathComponent("queue.json"))
        XCTAssertNil(store().load(), "a queue with no songs is no queue")
    }

    func testAnIndexOutsideTheListComesBackInside() throws {
        let json = #"{"items":[{"songKey":"a::t1","title":"t1","artist":"a"},{"songKey":"a::t2","title":"t2","artist":"a"}],"index":99}"#
        try Data(json.utf8).write(to: dir.appendingPathComponent("queue.json"))
        XCTAssertEqual(try XCTUnwrap(store().load()).index, 1)
    }

    func testThePositionComesBackOnlyForTheSongItWasKeptFor() throws {
        store().save(try XCTUnwrap(QueueSnapshot.make(queue: items(3), index: 1, label: nil, playlistId: nil)))
        store().save(position: "a::t2", seconds: 42, duration: 200)
        let same = try XCTUnwrap(store().load())
        XCTAssertEqual(same.positionSeconds, 42)
        XCTAssertEqual(same.durationSeconds, 200)

        // The queue moved on to another song: where the user was in the old one means nothing for the new one.
        store().save(try XCTUnwrap(QueueSnapshot.make(queue: items(3), index: 2, label: nil, playlistId: nil)))
        let other = try XCTUnwrap(store().load())
        XCTAssertEqual(other.positionSeconds, 0)
        XCTAssertEqual(other.durationSeconds, 0)
    }

    func testAPositionThatMakesNoSenseIsNotKept() throws {
        store().save(try XCTUnwrap(QueueSnapshot.make(queue: items(1), index: 0, label: nil, playlistId: nil)))
        store().save(position: "a::t1", seconds: -3, duration: 100)
        XCTAssertEqual(try XCTUnwrap(store().load()).positionSeconds, 0)
        store().save(position: "a::t1", seconds: .nan, duration: 100)
        XCTAssertEqual(try XCTUnwrap(store().load()).positionSeconds, 0)
        store().save(position: "a::t1", seconds: 10, duration: .infinity)
        let odd = try XCTUnwrap(store().load())
        XCTAssertEqual(odd.positionSeconds, 10)
        XCTAssertEqual(odd.durationSeconds, 0)
    }

    func testForgettingTheQueueForgetsThePositionToo() throws {
        store().save(try XCTUnwrap(QueueSnapshot.make(queue: items(2), index: 0, label: nil, playlistId: nil)))
        store().save(position: "a::t1", seconds: 30, duration: 100)
        store().save(nil)
        XCTAssertNil(store().load())
        store().save(try XCTUnwrap(QueueSnapshot.make(queue: items(2), index: 0, label: nil, playlistId: nil)))
        XCTAssertEqual(try XCTUnwrap(store().load()).positionSeconds, 0, "the old position must not come back with a new queue")
    }

    func testASecondSaveReplacesTheFirst() throws {
        store().save(try XCTUnwrap(QueueSnapshot.make(queue: items(5), index: 0, label: "uno", playlistId: nil)))
        store().save(try XCTUnwrap(QueueSnapshot.make(queue: items(2), index: 1, label: "due", playlistId: nil)))
        let loaded = try XCTUnwrap(store().load())
        XCTAssertEqual(loaded.items.count, 2)
        XCTAssertEqual(loaded.label, "due")
    }

    // MARK: the player

    func testSettingAQueueKeepsIt() throws {
        let player = newPlayer()
        player.setQueue(items(3), startAt: 1, playlistId: "pl9", label: "Playlist · Road trip", autoplay: false)
        let kept = try XCTUnwrap(store().load())
        XCTAssertEqual(kept.items.map(\.songKey), ["a::t1", "a::t2", "a::t3"])
        XCTAssertEqual(kept.index, 1)
        XCTAssertEqual(kept.label, "Playlist · Road trip")
        XCTAssertEqual(kept.playlistId, "pl9")
    }

    func testAnEmptiedQueueIsForgotten() {
        let player = newPlayer()
        player.setQueue(items(2), startAt: 0, autoplay: false)
        XCTAssertNotNil(store().load())
        player.setQueue([])
        XCTAssertNil(store().load())
        XCTAssertNil(newPlayer().queue.first, "a new player finds nothing to resume")
    }

    func testANewPlayerFindsTheQueueBackPausedOnTheSameSong() {
        newPlayer().setQueue(items(3), startAt: 1, playlistId: "pl9", label: "Playlist · Road trip", autoplay: false)
        let reborn = newPlayer()
        XCTAssertEqual(reborn.queue.map(\.songKey), ["a::t1", "a::t2", "a::t3"])
        XCTAssertEqual(reborn.index, 1)
        XCTAssertEqual(reborn.title, "t2")
        XCTAssertEqual(reborn.artist, "a")
        XCTAssertEqual(reborn.queueLabel, "Playlist · Road trip")
        XCTAssertEqual(reborn.queuePlaylistId, "pl9")
        XCTAssertFalse(reborn.playing, "the play is never automatic")
        XCTAssertEqual(reborn.playbackStatus, .idle)
        XCTAssertTrue(reborn.queue.allSatisfy { $0.track == nil }, "the server's view is asked again at the first play")
    }

    func testWhereTheUserWasComesBackAsTheTimeAndTheLengthOfTheSong() {
        newPlayer().setQueue(items(2), startAt: 1, autoplay: false)
        store().save(position: "a::t2", seconds: 60, duration: 200)
        let reborn = newPlayer()
        XCTAssertEqual(reborn.currentTime, 60)
        XCTAssertEqual(reborn.duration, 200)
        XCTAssertFalse(reborn.playing)
    }

    func testASongHeardToItsEndStartsOverInsteadOfResumingAtTheEnd() {
        newPlayer().setQueue(items(1), startAt: 0, autoplay: false)
        store().save(position: "a::t1", seconds: 199, duration: 200)
        let reborn = newPlayer()
        XCTAssertEqual(reborn.currentTime, 0)
        XCTAssertEqual(reborn.duration, 0)
    }

    func testTheRestoredQueueIsNotWrittenOverItself() throws {
        newPlayer().setQueue(items(3), startAt: 2, label: "Album · X", autoplay: false)
        store().save(position: "a::t3", seconds: 20, duration: 100)
        let file = dir.appendingPathComponent("queue.json")
        let before = try XCTUnwrap(try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date)
        Thread.sleep(forTimeInterval: 0.05)
        _ = newPlayer()
        let after = try XCTUnwrap(try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date)
        XCTAssertEqual(before, after, "putting the queue back must not write it again at every launch")
        XCTAssertEqual(try XCTUnwrap(store().load()).positionSeconds, 20, "restoring must not lose where the user was")
    }

    func testAddingToARestoredQueueKeepsTheAddition() throws {
        newPlayer().setQueue(items(2), startAt: 0, autoplay: false)
        let reborn = newPlayer()
        let outcome = reborn.append([TestSupport.track("b::new")], isLocal: { _ in true })
        XCTAssertEqual(outcome, .added(1))
        XCTAssertEqual(try XCTUnwrap(store().load()).items.map(\.songKey), ["a::t1", "a::t2", "b::new"])
    }

    func testTheQueueMovingToAnotherSongKeepsTheIndex() throws {
        let player = newPlayer()
        player.setQueue(items(3), startAt: 0, autoplay: false)
        player.play(at: 2)                          // nothing to stream with here: it only moves the queue's index
        XCTAssertEqual(try XCTUnwrap(store().load()).index, 2)
        player.pauseOnly()
    }

    func testThePositionIsKeptNowWhenTheAppGoesToTheBackground() throws {
        newPlayer().setQueue(items(2), startAt: 1, autoplay: false)
        store().save(position: "a::t2", seconds: 75, duration: 200)
        let reborn = newPlayer()
        store().save(position: "a::t2", seconds: 1, duration: 200)        // something older is there
        reborn.savePositionNow()
        XCTAssertEqual(try XCTUnwrap(store().load()).positionSeconds, 75)
    }

    func testNothingIsKeptAsAPositionBeforeAnythingHasPlayed() throws {
        let player = newPlayer()
        player.setQueue(items(2), startAt: 0, autoplay: false)
        player.savePositionNow()
        XCTAssertEqual(try XCTUnwrap(store().load()).positionSeconds, 0)
    }

    // MARK: the server's view of a restored song

    func testASongThatCameWithItsTrackNeedsNoCall() async {
        let api = FakeAPI()
        let item = QueueItem(track: TestSupport.track("a::t1"))
        let view = await LocalAudioPlayer.serverView(of: item, api: api)
        XCTAssertEqual(view?.songKey, "a::t1")
        XCTAssertTrue(api.calls.isEmpty)
    }

    func testARestoredSongAsksSoundReelForItsView() async {
        let api = FakeAPI()
        api.scriptTrack("a::t1", [.success(TestSupport.track("a::t1", version: "9-9"))])
        let item = QueueItem(songKey: "a::t1", title: "t1", artist: "a")
        let view = await LocalAudioPlayer.serverView(of: item, api: api)
        XCTAssertEqual(view?.version, "9-9")
        XCTAssertEqual(api.calls, ["track:a::t1"])
    }

    func testWhenSoundReelCannotBeReachedThereIsNoViewAndTheFirstPlayRuleSaysWhy() async {
        let api = FakeAPI()
        api.scriptTrack("a::t1", [.failure(MondropAPIError.transport("offline"))])
        let item = QueueItem(songKey: "a::t1", title: "t1", artist: "a")
        let view = await LocalAudioPlayer.serverView(of: item, api: api)
        XCTAssertNil(view)
        XCTAssertEqual(
            FirstPlay.decide(songKey: "a::t1", track: view, local: nil, config: MondropAPIConfig(baseURL: "https://x.test", apiKey: "k", user: "u")),
            .unavailable("brano non scaricato e senza informazioni dal server")
        )
    }
}
