import XCTest
@testable import Mondrop

/// The app must read the OLD manifest (installed backend before this change) and the NEW one (docs/mondrop-sync.md).
enum ManifestFixtures {
    /// Shape served before the sync contract v2: `status` only, wav/mp4 sources, no mediaUrl/version/state.
    static let old = #"""
    {
      "playlistId": "pl-old",
      "name": "Vecchia",
      "user": "mike",
      "readyCount": 2,
      "missingCount": 2,
      "tracks": [
        {"songKey": "air::sexy boy", "title": "Sexy Boy", "artist": "Air", "status": "ready", "source": "library",
         "downloadPath": "/api/mondrop/songs/air%3A%3Asexy%20boy/file", "absPath": "/music/Air/Air - Sexy Boy.mp3",
         "bytes": 7340032, "spotifyUrl": "https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA", "entryId": "e1",
         "canEnqueueSpooty": true, "coverUrl": "https://img.test/air.jpg", "lyrics": null},
        {"songKey": "reel::audio", "title": "Audio del reel", "artist": "", "status": "ready", "source": "entry_audio",
         "downloadPath": "/api/mondrop/entries/e2/file?kind=audio", "bytes": 52428800, "spotifyUrl": null, "entryId": "e2",
         "canEnqueueSpooty": false, "coverUrl": null, "lyrics": "testo del reel"},
        {"songKey": "pino::mancante", "title": "Mancante", "artist": "Pino", "status": "missing", "source": "none",
         "downloadPath": null, "bytes": null, "spotifyUrl": "https://open.spotify.com/track/BBBBBBBBBBBBBBBBBBBBBB",
         "entryId": null, "canEnqueueSpooty": true, "coverUrl": null, "lyrics": null},
        {"songKey": "solo::chiave", "status": "missing", "source": "none", "canEnqueueSpooty": false}
      ]
    }
    """#

    /// Every state of the contract, an unknown state, a malformed track, and the new fields.
    static let current = #"""
    {
      "playlistId": "pl-new",
      "name": "Road trip",
      "user": "mike",
      "readyCount": 1, "missingCount": 5, "preparingCount": 1, "failedCount": 1,
      "tracks": [
        {"songKey": "bishop briggs::white flag", "title": "White Flag", "artist": "Bishop Briggs",
         "status": "ready", "state": "ready", "source": "ytdlp",
         "downloadPath": "/api/mondrop/songs/bishop%20briggs%3A%3Awhite%20flag/file",
         "mediaUrl": "http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/White%20Flag.mp3",
         "version": "6291456-1794085004000", "bytes": 6291456, "durationS": 230, "error": null,
         "spotifyUrl": null, "entryId": "e3", "canEnqueueSpooty": false,
         "coverUrl": "https://img.test/wf.jpg", "lyrics": null},
        {"songKey": "a::preparing", "title": "In corso", "artist": "A", "status": "missing", "state": "preparing", "source": "none"},
        {"songKey": "b::failed", "title": "Rotto", "artist": "B", "status": "missing", "state": "failed", "error": "HTTP Error 403"},
        {"songKey": "c::nosource", "title": "Senza", "artist": "C", "status": "missing", "state": "no_source", "error": "nessun risultato"},
        {"songKey": "d::missing", "title": "Mai chiesto", "artist": "D", "status": "missing", "state": "missing"},
        {"songKey": "e::weird", "title": "Stato nuovo", "artist": "E", "status": "missing", "state": "rebuilding"},
        {"title": "Senza chiave", "artist": "X"}
      ]
    }
    """#

    static func decode(_ text: String) throws -> OfflineManifest {
        try JSONDecoder().decode(OfflineManifest.self, from: Data(text.utf8))
    }
}

final class ManifestDecodingTests: XCTestCase {

    // MARK: old shape

    func testOldManifestDecodesAndLegacyStatusDrivesTheState() throws {
        let manifest = try ManifestFixtures.decode(ManifestFixtures.old)
        XCTAssertEqual(manifest.playlistId, "pl-old")
        XCTAssertEqual(manifest.tracks.count, 4)

        let air = manifest.tracks[0]
        XCTAssertNil(air.state, "the old backend sends no state")
        XCTAssertEqual(air.resolvedState, .ready, "legacy status=ready → ready")
        XCTAssertNil(air.version)
        XCTAssertEqual(air.bytes, 7_340_032)
        XCTAssertEqual(air.downloadPath, "/api/mondrop/songs/air%3A%3Asexy%20boy/file")
        XCTAssertTrue(air.canEnqueueSpooty)

        XCTAssertEqual(manifest.tracks[2].resolvedState, .missing, "legacy status=missing → missing")
        XCTAssertEqual(manifest.readyCount, 2)
        XCTAssertEqual(manifest.missingCount, 2)
        XCTAssertEqual(manifest.preparingCount, 0)
    }

    func testOldManifestTrackWithOnlyAKeyStillDecodes() throws {
        let manifest = try ManifestFixtures.decode(ManifestFixtures.old)
        let bare = manifest.tracks[3]
        XCTAssertEqual(bare.songKey, "solo::chiave")
        XCTAssertEqual(bare.title, "solo::chiave", "no title → the key, as the contract says for unknown songs")
        XCTAssertEqual(bare.artist, "")
        XCTAssertFalse(bare.canEnqueueSpooty)
    }

    // MARK: new shape

    func testNewManifestDecodesEveryContractField() throws {
        let manifest = try ManifestFixtures.decode(ManifestFixtures.current)
        let wf = manifest.tracks[0]
        XCTAssertEqual(wf.resolvedState, .ready)
        XCTAssertEqual(wf.downloadPath, "/api/mondrop/songs/bishop%20briggs%3A%3Awhite%20flag/file")
        XCTAssertEqual(wf.version, "6291456-1794085004000")
        XCTAssertEqual(wf.bytes, 6_291_456)
        XCTAssertEqual(wf.durationS, 230)
        XCTAssertEqual(wf.source, "ytdlp")
        XCTAssertNil(wf.error)
    }

    /// Rule P (ADR-0018): a server older than 2.13.0 sends the address of a media-server file in every ready track. The
    /// manifest still decodes, and the address is dropped: it is not kept, and so never persisted (the queue file, the
    /// offline index) or used.
    func testTheAddressOfAStoreFileIsReadAndDropped() throws {
        let manifest = try ManifestFixtures.decode(ManifestFixtures.current)
        let wf = manifest.tracks[0]
        XCTAssertEqual(wf.songKey, "bishop briggs::white flag", "the track decodes as usual")
        let again = String(decoding: try JSONEncoder().encode(wf), as: UTF8.self)
        XCTAssertFalse(again.contains("mediaUrl"))
        XCTAssertFalse(again.contains("192.168."))
        XCTAssertFalse(again.contains("49200"))
        XCTAssertEqual(try JSONDecoder().decode(OfflineTrack.self, from: Data(again.utf8)), wf)
    }

    func testEveryStateMapsAndUnknownOnesFallBackToMissing() throws {
        let states = try ManifestFixtures.decode(ManifestFixtures.current).tracks.map(\.resolvedState)
        XCTAssertEqual(states, [.ready, .preparing, .failed, .noSource, .missing, .missing])
    }

    func testMalformedTrackIsSkippedNotFatal() throws {
        let manifest = try ManifestFixtures.decode(ManifestFixtures.current)
        XCTAssertEqual(manifest.tracks.count, 6, "the track without songKey is dropped, the rest survive")
        XCTAssertFalse(manifest.tracks.contains { $0.title == "Senza chiave" })
    }

    func testCountsAreDerivedFromTheTracks() throws {
        let manifest = try ManifestFixtures.decode(ManifestFixtures.current)
        XCTAssertEqual(manifest.readyCount, 1)
        XCTAssertEqual(manifest.preparingCount, 1)
        XCTAssertEqual(manifest.failedCount, 1)
        XCTAssertEqual(manifest.noSourceCount, 1)
        XCTAssertEqual(manifest.missingCount, 5, "contract: everything that is not ready")
    }

    func testStateWinsOverLegacyStatus() {
        let t = TestSupport.track("x", state: "preparing", status: "ready")
        XCTAssertEqual(t.resolvedState, .preparing)
    }

    func testNumbersAsDoublesAreAccepted() throws {
        let json = #"{"songKey":"k","bytes":1024.0,"durationS":199.6,"state":"ready"}"#
        let t = try JSONDecoder().decode(OfflineTrack.self, from: Data(json.utf8))
        XCTAssertEqual(t.bytes, 1024)
        XCTAssertEqual(t.durationS, 200)
    }

    // MARK: single track, net, ack

    func testSingleTrackBareOrWrappedBothDecode() throws {
        let bare = Data(#"{"songKey":"k","title":"T","state":"ready","version":"1-1"}"#.utf8)
        let wrapped = Data(#"{"track":{"songKey":"k","title":"T","state":"ready","version":"1-1"}}"#.utf8)
        XCTAssertEqual(try MondropAPI.decodeTrack(bare).version, "1-1")
        XCTAssertEqual(try MondropAPI.decodeTrack(wrapped).version, "1-1")
        XCTAssertThrowsError(try MondropAPI.decodeTrack(Data(#"{"nope":true}"#.utf8)))
    }

    func testNetInfoDerivesHomeWhenMissing() throws {
        let full = try JSONDecoder().decode(NetInfo.self, from: Data(#"{"viaCloudflare":false,"home":true}"#.utf8))
        XCTAssertEqual(full, NetInfo(viaCloudflare: false, home: true))
        let onlyCF = try JSONDecoder().decode(NetInfo.self, from: Data(#"{"viaCloudflare":true}"#.utf8))
        XCTAssertFalse(onlyCF.home, "through Cloudflare you are not at home")
        let empty = try JSONDecoder().decode(NetInfo.self, from: Data("{}".utf8))
        XCTAssertTrue(empty.home)
    }

    func testDownloadAckDecodesStateAndTrack() throws {
        let json = #"{"ok":true,"state":"preparing","track":{"songKey":"k","state":"preparing"}}"#
        let ack = try JSONDecoder().decode(DownloadAck.self, from: Data(json.utf8))
        XCTAssertTrue(ack.ok)
        XCTAssertEqual(ack.state, "preparing")
        XCTAssertEqual(ack.track?.resolvedState, .preparing)
    }

    func testTrackStateServerValues() {
        XCTAssertEqual(TrackState(serverValue: "READY"), .ready)
        XCTAssertEqual(TrackState(serverValue: "queued"), .preparing)
        XCTAssertEqual(TrackState(serverValue: "no_source"), .noSource)
        XCTAssertEqual(TrackState(serverValue: nil), .missing)
        XCTAssertEqual(TrackState(serverValue: "???"), .missing)
    }
}
