import XCTest
@testable import Mondrop

/// «Cerca», the contract: the query on the wire and the answer the server gives (docs/mondrop-sync.md, ADR-0018).
final class SearchQueryTests: XCTestCase {
    func testTheQueryStringHasAFixedOrderAndTheUserLast() {
        XCTAssertEqual(SearchQuery(text: "bassi maestro").queryString(user: "mike"), "q=bassi%20maestro&limit=30&offset=0&user=mike")
        XCTAssertEqual(
            SearchQuery(text: "x", artist: "Bassi Maestro", album: "Classe 73", limit: 50, offset: 100, withSections: false).queryString(),
            "q=x&artist=Bassi%20Maestro&album=Classe%2073&limit=50&offset=100&sections=0"
        )
    }

    func testAnArtistPageNeedsNoWords() {
        XCTAssertEqual(
            SearchQuery(artist: "Bassi Maestro", limit: 200).queryString(user: "mike"),
            "artist=Bassi%20Maestro&limit=200&offset=0&user=mike"
        )
    }

    func testAPlusAnAmpersandAndAnAccentArriveAsThemselves() {
        // the server reads a bare «+» as a space and «&» ends a value: «AC+DC» and «R&B/Soul» must be escaped
        XCTAssertEqual(SearchQuery(text: "AC+DC").queryString(), "q=AC%2BDC&limit=30&offset=0")
        XCTAssertEqual(SearchQuery(text: "R&B/Soul").queryString(), "q=R%26B%2FSoul&limit=30&offset=0")
        XCTAssertEqual(SearchQuery(text: "Mia maestà").queryString(), "q=Mia%20maest%C3%A0&limit=30&offset=0")
    }

    func testBlankIsNoFilterAndTheTextIsTrimmed() {
        XCTAssertEqual(SearchQuery(text: "  bassi  ", artist: "   ").queryString(), "q=bassi&limit=30&offset=0")
    }

    func testALongTextIsCutWhereTheServerCutsWithoutSplittingACharacter() {
        let emoji = String(repeating: "😀", count: 150)          // 2 UTF-16 units each: 200 units = 100 characters
        let cut = SearchQuery(text: emoji).pairs().first { $0.0 == "q" }?.1
        XCTAssertEqual(cut?.count, 100)
        XCTAssertEqual(cut?.utf16.count, 200)
    }

    func testTheLimitAndTheOffsetStayInsideWhatTheServerAccepts() {
        XCTAssertEqual(SearchQuery(text: "x", limit: 0, offset: -5).queryString(), "q=x&limit=1&offset=0")
        XCTAssertEqual(SearchQuery(text: "x", limit: 999).queryString(), "q=x&limit=200&offset=0")
    }

    func testASearchWithNothingToLookForIsEmpty() {
        XCTAssertTrue(SearchQuery().isEmpty)
        XCTAssertTrue(SearchQuery(text: "  ", artist: "\n").isEmpty)
        XCTAssertFalse(SearchQuery(artist: "Bassi Maestro").isEmpty)
        XCTAssertFalse(SearchQuery(album: "Classe 73").isEmpty)
    }
}

final class SearchPageDecodingTests: XCTestCase {
    /// The example of docs/mondrop-sync.md, with the keys the server really sends.
    static let documented = """
    {
      "q": "bassi maestro",
      "tracks": [
        { "songKey": "bassi maestro::foto di gruppo", "title": "Foto di gruppo", "artist": "Bassi Maestro", "album": "Foto di gruppo",
          "genres": [], "year": null, "state": "ready", "status": "ready", "source": "library",
          "downloadPath": "/api/mondrop/songs/bassi%20maestro%3A%3Afoto%20di%20gruppo/file", "mediaUrl": null,
          "version": "3084818-1", "bytes": 3084818, "plays": 0, "entryId": null, "canEnqueueSpooty": false }
      ],
      "artists": [ { "name": "Bassi Maestro", "tracks": 45 } ],
      "albums": [ { "title": "Mia maestà", "artist": "Bassi Maestro", "tracks": 14 } ],
      "total": 45, "offset": 0, "limit": 30, "user": "mike"
    }
    """

    private func decode(_ json: String) throws -> SearchPage {
        try JSONDecoder().decode(SearchPage.self, from: Data(json.utf8))
    }

    func testTheDocumentedAnswerDecodes() throws {
        let page = try decode(Self.documented)
        XCTAssertEqual(page.q, "bassi maestro")
        XCTAssertEqual(page.tracks.map(\.songKey), ["bassi maestro::foto di gruppo"])
        XCTAssertEqual(page.tracks[0].resolvedState, .ready)
        XCTAssertEqual(page.artists, [SearchArtistHit(name: "Bassi Maestro", tracks: 45)])
        XCTAssertEqual(page.albums, [SearchAlbumHit(title: "Mia maestà", artist: "Bassi Maestro", tracks: 14)])
        XCTAssertEqual(page.total, 45)
        XCTAssertEqual(page.limit, 30)
        XCTAssertEqual(page.user, "mike")
    }

    func testABrokenRowIsDroppedNotTheWholeAnswer() throws {
        let page = try decode(#"""
        { "tracks": [ { "title": "no key" }, { "songKey": "a::b", "title": "B", "artist": "A" } ],
          "artists": [ { "name": "  " }, { "name": "A", "tracks": 1 } ],
          "albums": [ { "artist": "no title" }, { "title": "T", "tracks": 2 } ], "total": 2 }
        """#)
        XCTAssertEqual(page.tracks.map(\.songKey), ["a::b"])
        XCTAssertEqual(page.artists.map(\.name), ["A"])
        XCTAssertEqual(page.albums.map(\.title), ["T"])
        XCTAssertEqual(page.albums.first?.artist, "")
    }

    func testAMissingTotalIsWhatWasSentAndTheTotalNeverBelowIt() throws {
        let forgotten = try decode(#"{ "tracks": [ { "songKey": "a::b", "title": "B", "artist": "A" } ], "offset": 10 }"#)
        XCTAssertEqual(forgotten.total, 11)
        let small = try decode(#"{ "tracks": [ { "songKey": "a::b", "title": "B", "artist": "A" } ], "total": 0 }"#)
        XCTAssertEqual(small.total, 1)
    }

    func testAnAnswerWithoutSectionsOrWithNewFieldsStillDecodes() throws {
        let bare = try decode(#"{ "q": "x", "tracks": [], "total": 0, "somethingNew": { "a": 1 } }"#)
        XCTAssertTrue(bare.artists.isEmpty)
        XCTAssertTrue(bare.albums.isEmpty)
        let empty = try decode("{}")
        XCTAssertEqual(empty.total, 0)
        XCTAssertTrue(empty.tracks.isEmpty)
    }

    func testAnAddressOfAStoreInATrackIsIgnored() throws {
        // rule P: the server sends `mediaUrl: null`; even if an old or odd server did not, the app never uses it
        let page = try decode(#"{ "tracks": [ { "songKey": "a::b", "title": "B", "artist": "A", "state": "ready", "mediaUrl": "http://192.168.178.10:49200/x.mp3" } ], "total": 1 }"#)
        XCTAssertEqual(page.tracks.count, 1)
    }
}

/// The HTTP side, against the URLProtocol stub: the requests that go on the wire.
final class SearchAPITests: XCTestCase {
    private func api() -> MondropAPI {
        MondropAPI(
            session: StubURLProtocol.session(),
            config: { MondropAPIConfig(baseURL: "https://soundreel.test/", apiKey: "sr_test_key_0123456789abcdef", user: "mike") }
        )
    }

    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    private var captured: StubURLProtocol.Captured? { StubURLProtocol.captured.last }

    func testSearchIsAReadOnlyGetWithTheWordsEncodedOnTheWire() async throws {
        StubURLProtocol.handler = { _ in (200, Data(SearchPageDecodingTests.documented.utf8)) }
        let page = try await api().search(SearchQuery(text: "Maestro Bassi", artist: "AC+DC", limit: 50, offset: 100, withSections: false))
        XCTAssertEqual(page.total, 45)
        let request = try XCTUnwrap(captured).request
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/mondrop/search")
        XCTAssertEqual(request.url?.query, "q=Maestro%20Bassi&artist=AC%2BDC&limit=50&offset=100&sections=0&user=mike")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-SoundReel-Key"), "sr_test_key_0123456789abcdef")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-SoundReel-User"), "mike")
        XCTAssertNil(captured?.body, "a search sends nothing")
    }

    func testAnOlderServerWithoutTheRouteAnswers404() async {
        StubURLProtocol.handler = { _ in (404, Data(#"{"error":"Not Found"}"#.utf8)) }
        do {
            _ = try await api().search(SearchQuery(text: "x"))
            XCTFail("a 404 must throw")
        } catch {
            guard case .http(404, _)? = error as? MondropAPIError else { return XCTFail("\(error)") }
        }
    }

    func testAddingASongToAPlaylistIsAPostWithTheKeyInTheBody() async throws {
        StubURLProtocol.handler = { _ in (200, Data(#"{"ok":true,"playlist":{"id":"p1","name":"Rap","songs":12},"user":"mike"}"#.utf8)) }
        let ack = try await api().addSong(songKey: "bassi maestro::capirai", toPlaylist: "p/1")
        XCTAssertEqual(ack, PlaylistAddAck(playlistId: "p1", name: "Rap", songs: 12))
        let request = try XCTUnwrap(captured).request
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString.hasPrefix("https://soundreel.test/api/mondrop/playlists/p%2F1/songs"), true, "the id cannot break out of its path segment")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(captured?.body)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String], ["songKey": "bassi maestro::capirai"])
    }

    func testAnAddThatTheServerAcceptedIsDoneEvenIfTheBodyCannotBeRead() async throws {
        StubURLProtocol.handler = { _ in (200, Data("not json".utf8)) }
        let ack = try await api().addSong(songKey: "a::b", toPlaylist: "p1")
        XCTAssertEqual(ack.playlistId, "p1")
    }

    func testTheServersRefusalsReachTheCaller() async {
        for status in [404, 409] {
            StubURLProtocol.handler = { _ in (status, Data(#"{"error":"x"}"#.utf8)) }
            do {
                _ = try await api().addSong(songKey: "a::b", toPlaylist: "p1")
                XCTFail("\(status) must throw")
            } catch {
                guard case .http(status, _)? = error as? MondropAPIError else { return XCTFail("\(error)") }
            }
        }
    }
}
