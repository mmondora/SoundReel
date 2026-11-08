import XCTest
@testable import Mondrop

/// What the share sheet sends: the body (playlistId / shareWith only when chosen), the answer in its old and new
/// shapes, and the pure pieces around it.
final class ShareRequestBodyTests: XCTestCase {
    private func client(user: String = "mike") -> BackendClient {
        BackendClient(
            session: StubURLProtocol.session(),
            config: { MondropAPIConfig(baseURL: "https://soundreel.test/", apiKey: "sr_test_key_0123456789abcdef", user: user) }
        )
    }

    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
        StubURLProtocol.handler = { _ in (200, Data(#"{"success":true,"entryId":"e1","status":"queued","kind":"generic"}"#.utf8)) }
    }

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    private func sentBody() throws -> [String: Any] {
        let captured = try XCTUnwrap(StubURLProtocol.captured.last)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(captured.body)) as? [String: Any])
    }

    func testNothingChosenMeansNeitherFieldIsInTheBody() async throws {
        _ = try await client().share(url: "https://open.spotify.com/track/1", comment: "#tesla", tags: nil, options: .none)
        let body = try sentBody()
        XCTAssertNil(body["playlistId"], "«Nessuna» is the field being absent")
        XCTAssertNil(body["shareWith"], "nobody is the field being absent, not an empty list")
        XCTAssertEqual(body["url"] as? String, "https://open.spotify.com/track/1")
        XCTAssertEqual(body["comment"] as? String, "#tesla")
        XCTAssertEqual(body["user"] as? String, "mike")
    }

    func testThePlaylistIsSentOnlyWhenChosen() async throws {
        _ = try await client().share(url: "https://x.test/a", comment: nil, tags: nil, options: ShareOptions(playlistId: "p1"))
        let body = try sentBody()
        XCTAssertEqual(body["playlistId"] as? String, "p1")
        XCTAssertNil(body["shareWith"])
    }

    func testTheRecipientsAreSentOnlyWhenChosen() async throws {
        _ = try await client().share(url: "https://x.test/a", comment: nil, tags: nil, options: ShareOptions(shareWith: ["archi", "sara"]))
        let body = try sentBody()
        XCTAssertEqual(body["shareWith"] as? [String], ["archi", "sara"])
        XCTAssertNil(body["playlistId"])
    }

    func testBothTogether() async throws {
        _ = try await client().share(url: "https://x.test/a", comment: nil, tags: nil, options: ShareOptions(playlistId: "p1", shareWith: ["sara"]))
        let body = try sentBody()
        XCTAssertEqual(body["playlistId"] as? String, "p1")
        XCTAssertEqual(body["shareWith"] as? [String], ["sara"])
    }

    func testAnEmptyRecipientListIsNeverSent() throws {
        let data = try JSONEncoder().encode(ShareRequest(url: "https://x.test", shareWith: []))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(object["shareWith"])
    }

    func testTheOldCallStillWorksAndSendsNoNewField() async throws {
        _ = try await client().share(url: "https://x.test/a", comment: nil, tags: nil)
        let body = try sentBody()
        XCTAssertNil(body["playlistId"])
        XCTAssertNil(body["shareWith"])
        XCTAssertEqual(body["channel"] as? String, "ios")
    }

    func testTheCredentialsTravelInTheHeaderOnly() async throws {
        _ = try await client().share(url: "https://x.test/a", comment: nil, tags: nil, options: .none)
        let captured = try XCTUnwrap(StubURLProtocol.captured.last)
        XCTAssertEqual(captured.request.value(forHTTPHeaderField: "X-SoundReel-Key"), "sr_test_key_0123456789abcdef")
        XCTAssertEqual(captured.request.url?.path, "/api/share")
        let text = String(data: try XCTUnwrap(captured.body), encoding: .utf8) ?? ""
        XCTAssertFalse(text.contains("sr_test_key"), "the key is never in the body")
    }

    func testWithoutAKeyOrUserNothingIsSent() async {
        let noKey = BackendClient(session: StubURLProtocol.session(), config: { MondropAPIConfig(baseURL: "https://x.test", apiKey: " ", user: "mike") })
        do {
            _ = try await noKey.share(url: "https://x.test/a", comment: nil, tags: nil, options: .none)
            XCTFail("should have thrown")
        } catch {
            guard case BackendError.missingApiKey = error else { return XCTFail("\(error)") }
        }
        XCTAssertTrue(StubURLProtocol.captured.isEmpty)
    }

    func testAnHttpErrorCarriesTheStatus() async {
        StubURLProtocol.handler = { _ in (401, Data(#"{"error":"unauthorized"}"#.utf8)) }
        do {
            _ = try await client().share(url: "https://x.test/a", comment: nil, tags: nil, options: .none)
            XCTFail("should have thrown")
        } catch {
            guard case BackendError.http(401, _) = error else { return XCTFail("\(error)") }
        }
    }
}

final class ShareResponseDecodingTests: XCTestCase {
    private func decode(_ json: String) throws -> ShareResponse {
        try JSONDecoder().decode(ShareResponse.self, from: Data(json.utf8))
    }

    func testTheResponseOfTheInstalledBackendStillDecodes() throws {
        let r = try decode(##"{"success":true,"entryId":"e1","tags":["#tesla"],"status":"queued","kind":"generic"}"##)
        XCTAssertTrue(r.success)
        XCTAssertEqual(r.entryId, "e1")
        XCTAssertEqual(r.tags, ["#tesla"])
        XCTAssertNil(r.playlist)
        XCTAssertEqual(r.sharedWith, [])
        XCTAssertEqual(r.rejected, [])
    }

    func testASpotifyResponseOfTheOldShapeKeepsTitleAndArtist() throws {
        let r = try decode(#"{"success":true,"entryId":"e","tags":[],"status":"queued","kind":"spotify","title":"Say it Ain't So","artist":"PENNY"}"#)
        XCTAssertEqual(r.title, "Say it Ain't So")
        XCTAssertEqual(r.artist, "PENNY")
    }

    func testTheDocumentedNewResponse() throws {
        let r = try decode(#"""
        { "success": true, "entryId": "e", "tags": [], "status": "queued", "kind": "spotify", "title": "T", "artist": "A",
          "playlist": { "id": "p1", "name": "Road trip", "added": 1 },
          "sharedWith": ["archi"],
          "rejected": [ { "user": "mike", "reason": "self" } ] }
        """#)
        XCTAssertEqual(r.playlist, .added(id: "p1", name: "Road trip", count: 1))
        XCTAssertEqual(r.sharedWith, ["archi"])
        XCTAssertEqual(r.rejected, [ShareRejection(user: "mike", reason: "self")])
    }

    func testAPlaylistThatWillBeFilledAtTheEndOfTheAnalysis() throws {
        let r = try decode(#"{"success":true,"playlist":{"id":"p1","name":"Road trip","added":"pending"}}"#)
        XCTAssertEqual(r.playlist, .pending(id: "p1", name: "Road trip"))
    }

    func testEveryWayAPlaylistCanBeRefused() throws {
        XCTAssertEqual(try decode(#"{"success":true,"playlist":{"id":"p1","error":"not_found"}}"#).playlist, .invalid(id: "p1", reason: .notFound))
        XCTAssertEqual(try decode(#"{"success":true,"playlist":{"id":"p1","error":"dynamic"}}"#).playlist, .invalid(id: "p1", reason: .dynamic))
        XCTAssertEqual(try decode(#"{"success":true,"playlist":{"id":"p1","error":"read_only"}}"#).playlist, .invalid(id: "p1", reason: .readOnly))
        XCTAssertEqual(try decode(#"{"success":true,"playlist":{"id":"p1","error":"quota"}}"#).playlist, .invalid(id: "p1", reason: .other("quota")))
    }

    func testNoPlaylistAskedForIsNull() throws {
        XCTAssertNil(try decode(#"{"success":true,"playlist":null,"sharedWith":[],"rejected":[]}"#).playlist)
    }

    func testAnAddedCountOfZeroIsKept() throws {
        XCTAssertEqual(try decode(#"{"success":true,"playlist":{"id":"p","name":"N","added":0}}"#).playlist, .added(id: "p", name: "N", count: 0))
    }

    func testAMissingPlaylistNameFallsBackToTheId() throws {
        XCTAssertEqual(try decode(#"{"success":true,"playlist":{"id":"p9","added":2}}"#).playlist, .added(id: "p9", name: "p9", count: 2))
    }

    func testTheFailureOfTheOldShape() throws {
        let r = try decode(#"{"success":false,"entryId":"e","status":"error","kind":"shazam","error":"Shazam: Shazam ha risposto HTTP 503"}"#)
        XCTAssertFalse(r.success)
        XCTAssertEqual(r.error, "Shazam: Shazam ha risposto HTTP 503")
    }

    func testSurprisesDoNotBreakAnAcceptedShare() throws {
        let r = try decode(#"{"success":true,"playlist":"weird","sharedWith":[1,"sara",null],"rejected":[{"nope":1},{"user":"x"}],"future":{"a":1}}"#)
        XCTAssertTrue(r.success)
        XCTAssertNil(r.playlist)
        XCTAssertEqual(r.sharedWith, ["sara"])
        XCTAssertEqual(r.rejected, [ShareRejection(user: "x", reason: "")])
    }

    func testAnEmptyObjectIsNotASuccess() throws {
        XCTAssertFalse(try decode("{}").success)
    }

    // MARK: the answers of the 2.10.0 server, exactly as `POST /api/share` composes them

    func testAShareWithNoOptionsGetsTheNewFieldsEmpty() throws {
        let r = try decode(##"{"success":true,"entryId":"e1","tags":["#tesla"],"status":"queued","kind":"generic","playlist":null,"sharedWith":[],"rejected":[]}"##)
        XCTAssertNil(r.playlist)
        XCTAssertEqual(r.sharedWith, [])
        XCTAssertEqual(r.rejected, [])
    }

    func testASpotifyShareThatFilledThePlaylistAndSharedWithTheFamily() throws {
        let r = try decode(#"""
        {"success":true,"entryId":"e1","tags":[],"status":"queued","kind":"spotify","title":"White Flag","artist":"Bishop Briggs",
         "playlist":{"id":"p_static","name":"PL p_static","added":2},"sharedWith":["archi","sara"],
         "rejected":[{"user":"mike","reason":"self"},{"user":"mario","reason":"unknown_user"}]}
        """#)
        XCTAssertEqual(r.playlist, .added(id: "p_static", name: "PL p_static", count: 2))
        XCTAssertEqual(r.sharedWith, ["archi", "sara"])
        XCTAssertEqual(r.rejected, [ShareRejection(user: "mike", reason: "self"), ShareRejection(user: "mario", reason: "unknown_user")])
    }

    func testAPlaylistThatWasAlreadyFullIsZeroAdded() throws {
        let r = try decode(#"{"success":true,"kind":"spotify","playlist":{"id":"p1","name":"Road trip","added":0},"sharedWith":["archi"],"rejected":[]}"#)
        XCTAssertEqual(r.playlist, .added(id: "p1", name: "Road trip", count: 0))
        XCTAssertEqual(ShareOutcomeText.success(r).headline, "Già in Road trip")
    }

    func testAGenericLinkWaitsForItsAnalysisBeforeFillingThePlaylist() throws {
        let r = try decode(#"{"success":true,"entryId":"e1","tags":[],"status":"queued","kind":"generic","playlist":{"id":"p1","name":"Road trip","added":"pending"},"sharedWith":[],"rejected":[]}"#)
        XCTAssertEqual(r.playlist, .pending(id: "p1", name: "Road trip"))
        XCTAssertEqual(ShareOutcomeText.success(r).headline, "Link in analisi: i brani andranno in Road trip, ti avviso")
    }

    func testAPlaylistTheServerRefusedStillSavesTheLink() throws {
        for (word, problem) in [("not_found", SharePlaylistProblem.notFound), ("dynamic", .dynamic), ("read_only", .readOnly)] {
            let r = try decode(#"{"success":true,"entryId":"e1","status":"queued","kind":"spotify","playlist":{"id":"p1","error":"\#(word)"},"sharedWith":[],"rejected":[]}"#)
            XCTAssertEqual(r.playlist, .invalid(id: "p1", reason: problem), word)
            XCTAssertTrue(r.success)
        }
    }

    func testAShazamPageThatCouldNotBeReadIsAFailureWithTheNewFieldsToo() throws {
        let r = try decode(#"{"success":false,"entryId":"e3","tags":[],"status":"error","kind":"shazam","error":"Shazam: page not found","playlist":null,"sharedWith":[],"rejected":[]}"#)
        XCTAssertFalse(r.success)
        XCTAssertEqual(ShareOutcomeText.failure(for: r), "Shazam: page not found")
    }

    func testAKeyWithNoUserCannotShareWithAnybody() throws {
        let r = try decode(#"{"success":true,"kind":"spotify","sharedWith":[],"rejected":[{"user":"archi","reason":"sender_unknown"}]}"#)
        XCTAssertEqual(r.rejected, [ShareRejection(user: "archi", reason: "sender_unknown")])
        XCTAssertEqual(ShareOutcomeText.success(r).warnings, ["Non condiviso con archi: la tua chiave non è legata a un utente"])
    }
}

final class MediaLinkClassifierTests: XCTestCase {
    func testTheLinksThatGetAPlaylistPicker() {
        let music = [
            "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc",
            "https://open.spotify.com/intl-it/track/4uLU6hMCjMI75M1A2tKUQC",
            "https://spotify.link/AbCdEf",
            "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
            "https://music.apple.com/it/album/thriller/269572838",
            "https://www.shazam.com/track/12345/white-flag",
            "https://shazam.com/song/123/slug",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ",
            "https://music.youtube.com/watch?v=abc",
            "https://m.youtube.com/watch?v=abc",
            "https://soundcloud.com/artist/track",
            "https://on.soundcloud.com/xyz",
            "https://www.instagram.com/reel/Cabc123/",
            "https://instagram.com/p/abc",
            "https://www.tiktok.com/@user/video/123",
            "https://vm.tiktok.com/ZMabc/",
            "HTTPS://OPEN.SPOTIFY.COM/track/1",
        ]
        for link in music { XCTAssertTrue(MediaLinkClassifier.isMusicOrMedia(link), link) }
    }

    func testOrdinaryPagesDoNot() {
        let other = [
            "https://www.repubblica.it/articolo",
            "https://github.com/mmondora/soundreel",
            "https://www.spotify.com/it/premium/",
            "https://apple.com/it/iphone",
            "https://www.imdb.com/title/tt0111161/",
            "https://example.com/youtube.com",
            "https://example.com/?u=https://open.spotify.com/track/1",
            "mailto:me@example.com",
            "ftp://youtube.com/video",
            "javascript:alert(1)",
            "not a url",
            "",
        ]
        for link in other { XCTAssertFalse(MediaLinkClassifier.isMusicOrMedia(link), link) }
    }

    func testLookAlikeHostsDoNot() {
        let tricks = [
            "https://notspotify.com/track/1",
            "https://open.spotify.com.evil.example/track/1",
            "https://evilyoutube.com/watch?v=1",
            "https://youtube.com.evil.example/",
            "https://fakeinstagram.com/p/1",
            "https://tiktok.com.cn.example/",
            "https://shazam.com.example/",
            "https://xmusic.apple.com.example/",
        ]
        for link in tricks { XCTAssertFalse(MediaLinkClassifier.isMusicOrMedia(link), link) }
    }

    func testAURLValueWorksToo() throws {
        XCTAssertTrue(MediaLinkClassifier.isMusicOrMedia(try XCTUnwrap(URL(string: "https://youtu.be/abc"))))
        XCTAssertFalse(MediaLinkClassifier.isMusicOrMedia(try XCTUnwrap(URL(string: "https://example.com/abc"))))
    }

    func testAHostWithATrailingDotIsTheSameHost() throws {
        XCTAssertTrue(MediaLinkClassifier.isMusicOrMedia(try XCTUnwrap(URL(string: "https://open.spotify.com./track/1"))))
    }
}

final class LinkPreviewTests: XCTestCase {
    func testTheHostWithoutWwwAndTheShortUrl() throws {
        let preview = LinkPreview.make(try XCTUnwrap(URL(string: "https://www.instagram.com/reel/Cabc123/")))
        XCTAssertEqual(preview.host, "instagram.com")
        XCTAssertEqual(preview.shortURL, "instagram.com/reel/Cabc123", "the trailing slash adds nothing")
    }

    func testALongUrlIsCutWithAnEllipsis() throws {
        let long = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=a1b2c3d4e5f6g7h8i9j0&utm_source=copy-link&utm_campaign=x"
        let preview = LinkPreview.make(try XCTUnwrap(URL(string: long)), maxLength: 40)
        XCTAssertEqual(preview.shortURL.count, 40)
        XCTAssertTrue(preview.shortURL.hasSuffix("…"))
        XCTAssertTrue(preview.shortURL.hasPrefix("open.spotify.com/track/"))
        XCTAssertEqual(preview.host, "open.spotify.com")
    }

    func testABareHostHasNoTrailingSlash() throws {
        XCTAssertEqual(LinkPreview.make(try XCTUnwrap(URL(string: "https://example.com/"))).shortURL, "example.com")
    }
}

final class ShareRecipientsTests: XCTestCase {
    func testTheFamilyWithoutTheSender() {
        XCTAssertEqual(ShareRecipients.available(for: "mike"), ["archi", "sara"])
        XCTAssertEqual(ShareRecipients.available(for: "sara"), ["mike", "archi"])
        XCTAssertEqual(ShareRecipients.available(for: " Archi "), ["mike", "sara"], "no case, no spaces")
    }

    func testAnUnknownSenderOffersTheWholeFamily() {
        XCTAssertEqual(ShareRecipients.available(for: ""), ["mike", "archi", "sara"])
    }

    func testSanitizeKeepsOnlyAllowedIdsOnceInFamilyOrder() {
        XCTAssertEqual(ShareRecipients.sanitize(["sara", "archi", "sara"], for: "mike"), ["archi", "sara"])
        XCTAssertEqual(ShareRecipients.sanitize(["mike", "stranger", "ARCHI"], for: "mike"), ["archi"], "never yourself, never a stranger")
        XCTAssertEqual(ShareRecipients.sanitize([], for: "mike"), [])
    }
}

final class PlaylistsCacheTests: XCTestCase {
    private func cache() throws -> PlaylistsCache {
        PlaylistsCache(url: try TestSupport.tempFile("playlists-cache.json"))
    }

    private let playlists = [
        MondropPlaylist(id: "p1", name: "Road trip", songCount: 5, canEdit: true),
        MondropPlaylist(id: "p2", name: "Condivisa da sara", songCount: 3, canEdit: false),
        MondropPlaylist(id: "p3", name: "Notte", songCount: 0, kind: "dynamic", ruleSummary: "Più ascoltate", canEdit: false),
        MondropPlaylist(id: "p4", name: "Vecchio backend", songCount: 2),
        MondropPlaylist(id: "p5", name: "Anni 80", songCount: 9, canEdit: true),
    ]

    func testOnlyThePlaylistsTheUserMayEditAreKept() throws {
        let cache = try cache()
        let stored = cache.store(playlists, user: "mike")
        XCTAssertEqual(stored.map(\.id), ["p1", "p5"])
        let loaded = try XCTUnwrap(cache.load(forUser: "mike"))
        XCTAssertEqual(loaded.playlists, [CachedPlaylist(id: "p1", name: "Road trip"), CachedPlaylist(id: "p5", name: "Anni 80")])
    }

    func testADynamicPlaylistIsNeverOfferedEvenIfTheServerSaidEditable() throws {
        let cache = try cache()
        let stored = cache.store([MondropPlaylist(id: "d", name: "Dyn", songCount: 0, kind: "dynamic", canEdit: true)], user: "mike")
        XCTAssertEqual(stored, [])
    }

    func testAnOlderBackendWithoutCanEditOffersNone() throws {
        let cache = try cache()
        cache.store([MondropPlaylist(id: "a", name: "A", songCount: 1), MondropPlaylist(id: "b", name: "B", songCount: 2)], user: "mike")
        XCTAssertEqual(try XCTUnwrap(cache.load(forUser: "mike")).playlists, [], "better no choice than one the server may refuse")
    }

    func testNoFileMeansNoCache() throws {
        XCTAssertNil(try cache().load(forUser: "mike"))
    }

    func testAnotherUsersCacheIsNotUsed() throws {
        let cache = try cache()
        cache.store(playlists, user: "mike")
        XCTAssertNil(cache.load(forUser: "sara"), "a renewed key may belong to someone else")
        XCTAssertNotNil(cache.load(forUser: "MIKE"))
    }

    func testAGarbageFileIsNoCacheNotACrash() throws {
        let url = try TestSupport.tempFile("playlists-cache.json")
        try Data("not json".utf8).write(to: url)
        XCTAssertNil(PlaylistsCache(url: url).load(forUser: "mike"))
    }

    func testTheNewestWriteWins() throws {
        let cache = try cache()
        cache.store(playlists, user: "mike", at: Date(timeIntervalSince1970: 100))
        cache.store([MondropPlaylist(id: "n", name: "Nuova", songCount: 1, canEdit: true)], user: "mike", at: Date(timeIntervalSince1970: 200))
        let loaded = try XCTUnwrap(cache.load(forUser: "mike"))
        XCTAssertEqual(loaded.playlists.map(\.id), ["n"])
        XCTAssertEqual(loaded.updatedAt, Date(timeIntervalSince1970: 200))
    }

    func testPlaylistsDecodeCanEditFromTheServer() throws {
        let json = #"{"playlists":[{"id":"p1","name":"A","songCount":1,"canEdit":true},{"id":"p2","name":"B","songCount":2}]}"#
        struct Wrap: Decodable { let playlists: [MondropPlaylist] }
        let list = try JSONDecoder().decode(Wrap.self, from: Data(json.utf8)).playlists
        XCTAssertEqual(list.map(\.canEdit), [true, nil])
    }
}

final class ShareLogTests: XCTestCase {
    private func log() throws -> ShareLog { ShareLog(url: try TestSupport.tempFile("share-log.json")) }

    func testWhatALinkWasSentWithIsFoundAgain() throws {
        let log = try log()
        log.record(url: "https://open.spotify.com/track/1", comment: "#tesla", options: ShareOptions(playlistId: "p1", shareWith: ["sara"]))
        let entry = try XCTUnwrap(log.lastEntry(forURL: "https://open.spotify.com/track/1"))
        XCTAssertEqual(entry.comment, "#tesla")
        XCTAssertEqual(entry.options, ShareOptions(playlistId: "p1", shareWith: ["sara"]))
    }

    func testTrackingParametersDoNotMakeItAnotherLink() throws {
        let log = try log()
        log.record(url: "https://open.spotify.com/track/1?si=abc123", comment: nil, options: ShareOptions(playlistId: "p1"))
        XCTAssertNotNil(log.lastEntry(forURL: "https://open.spotify.com/track/1"), "the server stores the canonical URL")
        XCTAssertNotNil(log.lastEntry(forURL: "https://OPEN.spotify.com/track/1?utm_source=x&si=zzz#frag"))
        XCTAssertNil(log.lastEntry(forURL: "https://open.spotify.com/track/2"))
    }

    func testKeysKeepTheParametersThatMatter() {
        XCTAssertNotEqual(ShareLog.key(for: "https://www.youtube.com/watch?v=aaa"), ShareLog.key(for: "https://www.youtube.com/watch?v=bbb"))
        XCTAssertEqual(ShareLog.key(for: "https://www.youtube.com/watch?v=aaa&feature=share"), ShareLog.key(for: "https://www.youtube.com/watch?v=aaa"))
        XCTAssertEqual(ShareLog.key(for: "https://www.instagram.com/reel/X/?igsh=abc"), ShareLog.key(for: "https://www.instagram.com/reel/X"))
    }

    func testSendingAgainReplacesTheLine() throws {
        let log = try log()
        log.record(url: "https://x.test/a", comment: nil, options: ShareOptions(playlistId: "p1"))
        log.record(url: "https://x.test/a", comment: "#new", options: ShareOptions(shareWith: ["archi"]))
        let entry = try XCTUnwrap(log.lastEntry(forURL: "https://x.test/a"))
        XCTAssertEqual(entry.options, ShareOptions(shareWith: ["archi"]))
        XCTAssertEqual(entry.comment, "#new")
    }

    func testItStaysSmallAndForgetsOldLines() throws {
        let log = try log()
        let start = Date(timeIntervalSince1970: 1_794_000_000)
        for i in 0..<(ShareLog.capacity + 10) {
            log.record(url: "https://x.test/\(i)", comment: nil, options: .none, at: start.addingTimeInterval(Double(i)))
        }
        let now = start.addingTimeInterval(1000)
        XCTAssertNil(log.lastEntry(forURL: "https://x.test/0", now: now), "the oldest went out")
        XCTAssertNotNil(log.lastEntry(forURL: "https://x.test/\(ShareLog.capacity + 9)", now: now))
        XCTAssertNil(log.lastEntry(forURL: "https://x.test/\(ShareLog.capacity + 9)", now: start.addingTimeInterval(40 * 86_400)), "and a month later nothing is left")
    }
}

final class ShareOutcomeTextTests: XCTestCase {
    private func ok(_ r: ShareResponse) -> ShareOutcome { ShareOutcomeText.success(r) }

    func testAGenericLinkIsBeingAnalysed() {
        XCTAssertEqual(ok(ShareResponse(success: true, status: "queued", kind: "generic")).headline, "Link in analisi, ti avviso")
    }

    func testASongKnownAtOnceIsSaved() {
        let outcome = ok(ShareResponse(success: true, status: "queued", kind: "spotify", title: "Say it Ain't So", artist: "PENNY"))
        XCTAssertEqual(outcome.headline, "Brano salvato su SoundReel")
        XCTAssertEqual(outcome.details, ["Say it Ain't So — PENNY"])
        XCTAssertTrue(outcome.warnings.isEmpty)
    }

    func testAShazamLinkIsAlreadyCompleted() {
        XCTAssertEqual(ok(ShareResponse(success: true, status: "completed", kind: "shazam", title: "White Flag")).headline, "Brano salvato su SoundReel")
        XCTAssertEqual(ok(ShareResponse(success: true, status: "completed", kind: "generic")).headline, "Link salvato su SoundReel")
    }

    func testTheSongWentIntoThePlaylist() {
        let one = ok(ShareResponse(success: true, kind: "spotify", playlist: .added(id: "p1", name: "Road trip", count: 1)))
        XCTAssertEqual(one.headline, "Brano aggiunto a Road trip")
        let many = ok(ShareResponse(success: true, kind: "spotify", playlist: .added(id: "p1", name: "Road trip", count: 12)))
        XCTAssertEqual(many.headline, "12 brani aggiunti a Road trip")
    }

    func testASongAlreadyThere() {
        XCTAssertEqual(ok(ShareResponse(success: true, kind: "spotify", playlist: .added(id: "p1", name: "Road trip", count: 0))).headline, "Già in Road trip")
    }

    func testTheSongsWillComeAtTheEndOfTheAnalysis() {
        let outcome = ok(ShareResponse(success: true, status: "queued", kind: "generic", playlist: .pending(id: "p1", name: "Road trip")))
        XCTAssertEqual(outcome.headline, "Link in analisi: i brani andranno in Road trip, ti avviso")
    }

    func testAPlaylistTheServerRefusedIsAWarningNotAFailure() {
        for (problem, text) in [
            (SharePlaylistProblem.notFound, "non esiste più"),
            (.dynamic, "è dinamica: la regola decide i brani"),
            (.readOnly, "è in sola lettura"),
            (.other("quota"), "quota"),
        ] {
            let outcome = ok(ShareResponse(success: true, status: "queued", kind: "generic", playlist: .invalid(id: "p1", reason: problem)))
            XCTAssertEqual(outcome.headline, "Link in analisi, ti avviso", "the link is saved all the same")
            XCTAssertEqual(outcome.warnings, ["Playlist non usata (\(text)): il link è in libreria"])
        }
    }

    func testWhoItWasSharedWith() {
        XCTAssertEqual(ok(ShareResponse(success: true, sharedWith: ["archi"])).details, ["Condiviso con archi"])
        XCTAssertEqual(ok(ShareResponse(success: true, sharedWith: ["archi", "sara"])).details, ["Condiviso con archi e sara"])
        XCTAssertEqual(ok(ShareResponse(success: true, sharedWith: ["mike", "archi", "sara"])).details, ["Condiviso con mike, archi e sara"])
    }

    func testWhoItWasNotSharedWith() {
        let outcome = ok(ShareResponse(success: true, rejected: [
            ShareRejection(user: "mike", reason: "self"), ShareRejection(user: "zed", reason: "unknown_user"), ShareRejection(user: "q", reason: "boh"),
        ]))
        XCTAssertEqual(outcome.warnings, ["Non condiviso con mike: sei tu", "Non condiviso con zed: utente sconosciuto", "Non condiviso con q: boh"])
    }

    func testASenderTheServerDoesNotKnow() {
        let outcome = ok(ShareResponse(success: true, rejected: [ShareRejection(user: "archi", reason: "sender_unknown")]))
        XCTAssertEqual(outcome.warnings, ["Non condiviso con archi: la tua chiave non è legata a un utente"])
    }

    func testEverythingAtOnce() {
        let outcome = ok(ShareResponse(
            success: true, status: "queued", kind: "spotify", title: "T", artist: "A",
            playlist: .added(id: "p1", name: "Road trip", count: 1), sharedWith: ["archi"],
            rejected: [ShareRejection(user: "mike", reason: "self")]
        ))
        XCTAssertEqual(outcome.headline, "Brano aggiunto a Road trip")
        XCTAssertEqual(outcome.details, ["T — A", "Condiviso con archi"])
        XCTAssertEqual(outcome.warnings, ["Non condiviso con mike: sei tu"])
    }

    func testTheSheetStaysLongerWhenThereIsSomethingToRead() {
        XCTAssertEqual(ok(ShareResponse(success: true)).closeDelay, 1.2, accuracy: 0.001)
        XCTAssertEqual(ok(ShareResponse(success: true, rejected: [ShareRejection(user: "mike", reason: "self")])).closeDelay, 3.0, accuracy: 0.001)
    }

    // MARK: failures

    func testTheReasonOfAServerRefusalIsShownAsIs() {
        XCTAssertEqual(ShareOutcomeText.failure(for: ShareResponse(success: false, error: "Shazam: Shazam ha risposto HTTP 503")), "Shazam: Shazam ha risposto HTTP 503")
        XCTAssertEqual(ShareOutcomeText.failure(for: ShareResponse(success: false)), "Il server non ha accettato il link")
        XCTAssertEqual(ShareOutcomeText.failure(for: ShareResponse(success: false, error: "  ")), "Il server non ha accettato il link")
    }

    func testTheReasonOfACallThatFailed() {
        XCTAssertEqual(ShareOutcomeText.failure(for: BackendError.http(401, nil)), "API key non valida: rinnovala in Mondrop → Impostazioni")
        XCTAssertEqual(ShareOutcomeText.failure(for: BackendError.http(403, nil)), "API key non valida: rinnovala in Mondrop → Impostazioni")
        XCTAssertEqual(ShareOutcomeText.failure(for: BackendError.http(400, nil)), "Il server non accetta questo link")
        XCTAssertTrue(ShareOutcomeText.failure(for: BackendError.http(502, nil)).contains("HTTP 502"))
        XCTAssertTrue(ShareOutcomeText.failure(for: BackendError.transport(URLError(.notConnectedToInternet))).hasPrefix("Server non raggiungibile"))
        XCTAssertTrue(ShareOutcomeText.failure(for: BackendError.decode(URLError(.cannotParseResponse))).contains("riprova"))
        XCTAssertEqual(ShareOutcomeText.failure(for: BackendError.missingApiKey), BackendError.missingApiKey.description)
        XCTAssertTrue(ShareOutcomeText.failure(for: URLError(.timedOut)).hasPrefix("Errore"))
    }
}
