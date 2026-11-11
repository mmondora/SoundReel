import XCTest
@testable import Mondrop

/// What the phone keeps of a playlist it has read — the keys of its songs and which ones the server had failed — so that a card, a row of the list and
/// the page of a playlist can show its mark without reading every manifest again (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U9).
final class PlaylistRecordTests: XCTestCase {
    private func store() throws -> OfflineStore { OfflineStore(root: try TestSupport.tempDir("records")) }

    func testARecordKeepsTheKeysInOrderAndTheFailedOnes() throws {
        let store = try store()
        store.recordPlaylist(id: "p", name: "P", songKeys: ["b", "a", "c"], failedKeys: ["a"])
        XCTAssertEqual(store.playlistRecords()["p"], OfflineStore.PlaylistRecord(songKeys: ["b", "a", "c"], failedKeys: ["a"]))
    }

    func testARecordWithoutFailuresHasNone() throws {
        let store = try store()
        store.recordPlaylist(id: "p", name: "P", songKeys: ["a"])
        XCTAssertEqual(store.playlistRecords()["p"]?.failedKeys, [])
    }

    func testTheNextReadReplacesTheRecordSoAFixedSongIsNoLongerFailed() throws {
        let store = try store()
        store.recordPlaylist(id: "p", name: "P", songKeys: ["a", "b"], failedKeys: ["b"])
        store.recordPlaylist(id: "p", name: "P", songKeys: ["a", "b"])
        XCTAssertEqual(store.playlistRecords()["p"]?.failedKeys, [])
    }

    func testRecordsSurviveARelaunch() throws {
        let root = try TestSupport.tempDir("records-relaunch")
        OfflineStore(root: root).recordPlaylist(id: "p", name: "P", songKeys: ["a", "b"], failedKeys: ["b"])
        XCTAssertEqual(OfflineStore(root: root).playlistRecords()["p"], OfflineStore.PlaylistRecord(songKeys: ["a", "b"], failedKeys: ["b"]))
    }

    func testAMembershipWrittenByAnEarlierBuildStillLoadsAndHasNoFailures() throws {
        // an index written before 1.8.0 has no `failedKeys` in its memberships: it must load, not be thrown away as corrupt
        let before = OfflineStore.Membership(name: "P", songKeys: ["a"], seenAt: Date(timeIntervalSince1970: 1_794_000_000))
        let data = try JSONEncoder().encode(before)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("failedKeys"), "an absent list is not written at all")
        let back = try JSONDecoder().decode(OfflineStore.Membership.self, from: data)
        XCTAssertEqual(back, before)
        XCTAssertNil(back.failedKeys)
    }

    func testAPlaylistThePhoneNeverReadHasNoRecord() throws {
        XCTAssertNil(try store().playlistRecords()["nope"])
    }

    func testAPlaylistDeletedOnTheServerLosesItsRecord() throws {
        let store = try store()
        store.recordPlaylist(id: "gone", name: "G", songKeys: ["a"])
        store.recordPlaylist(id: "kept", name: "K", songKeys: ["b"])
        store.pruneMemberships(keeping: ["kept"])
        XCTAssertEqual(Set(store.playlistRecords().keys), ["kept"])
    }

    func testTheManifestNamesTheSongsTheServerCouldNotPrepare() {
        let manifest = TestSupport.manifest("p", [
            TestSupport.track("ok"), TestSupport.track("bad", state: "failed", error: "x"),
            TestSupport.track("nosrc", state: "no_source"), TestSupport.track("wait", state: "preparing"),
        ])
        XCTAssertEqual(manifest.failedKeys, ["bad"], "«no source» and «preparing» are online, not errors")
    }

    // MARK: where the records are written

    @MainActor
    func testTheSyncOfOnePlaylistRemembersItsFailedSongs() async throws {
        let rig = try EngineRig()
        let api = FakeAPI()
        api.scriptManifests("pl", [.success(TestSupport.manifest("pl", [TestSupport.track("ok"), TestSupport.track("bad", state: "failed", error: "x")]))])
        let coordinator = PlaylistSyncCoordinator(playlist: MondropPlaylist(id: "pl", name: "Playlist pl", songCount: 2), api: api, engine: rig.engine)
        await coordinator.load()
        XCTAssertEqual(rig.store.playlistRecords()["pl"], OfflineStore.PlaylistRecord(songKeys: ["ok", "bad"], failedKeys: ["bad"]))
    }

    func testReadingEveryPlaylistRemembersTheFailedSongsOfEach() async throws {
        let store = try store()
        let api = FakeAPI()
        api.setPlaylists([MondropPlaylist(id: "a", name: "A", songCount: 2), MondropPlaylist(id: "b", name: "B", songCount: 1)])
        api.scriptManifests("a", [.success(TestSupport.manifest("a", [TestSupport.track("a1"), TestSupport.track("a2", state: "failed", error: "x")]))])
        api.scriptManifests("b", [.success(TestSupport.manifest("b", [TestSupport.track("b1")]))])
        try await PlaylistSnapshots.refreshAll(api: api, store: store)
        XCTAssertEqual(store.playlistRecords()["a"]?.failedKeys, ["a2"])
        XCTAssertEqual(store.playlistRecords()["b"]?.failedKeys, [])
    }
}
