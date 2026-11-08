import XCTest
@testable import Mondrop

/// The query string of GET /api/mondrop/library, and the reading of its answer (old and new shapes).
final class LibraryQueryTests: XCTestCase {
    private func query(_ filters: LibraryFilters = .none, limit: Int = 100, offset: Int = 0, facets: Bool = true) -> LibraryQuery {
        LibraryQuery(filters: filters, limit: limit, offset: offset, withFacets: facets)
    }

    func testNoFilterIsJustThePage() {
        XCTAssertEqual(query().queryString(), "limit=100&offset=0")
        XCTAssertEqual(query(limit: 50, offset: 100).queryString(), "limit=50&offset=100")
    }

    func testEveryFilterGoesOutInAFixedOrder() {
        let f = LibraryFilters(q: "billie", genre: "Pop", album: "Thriller", artist: "Michael Jackson", decade: .decade(1980))
        XCTAssertEqual(
            query(f).queryString(),
            "q=billie&genre=Pop&album=Thriller&artist=Michael%20Jackson&decade=1980&limit=100&offset=0"
        )
    }

    func testNoYearIsTheWordNone() {
        XCTAssertEqual(query(LibraryFilters(decade: .noYear)).queryString(), "decade=none&limit=100&offset=0")
    }

    func testBlankFiltersAreLeftOut() {
        let f = LibraryFilters(q: "   ", genre: "", album: "\n", artist: " Daft Punk ")
        XCTAssertEqual(query(f).queryString(), "artist=Daft%20Punk&limit=100&offset=0")
    }

    func testFacetsOffOnlyWhenAsked() {
        XCTAssertFalse(query().queryString().contains("facets"))
        XCTAssertEqual(query(limit: 100, offset: 100, facets: false).queryString(), "limit=100&offset=100&facets=0")
    }

    func testPlusAndAmpersandAreEscapedBecauseTheServerReadsAPlusAsASpace() {
        // URLComponents.queryItems would leave «+» alone: «AC+DC» would arrive as «AC DC».
        XCTAssertEqual(query(LibraryFilters(artist: "AC+DC")).queryString(), "artist=AC%2BDC&limit=100&offset=0")
        XCTAssertEqual(query(LibraryFilters(genre: "R&B/Soul")).queryString(), "genre=R%26B%2FSoul&limit=100&offset=0")
        XCTAssertEqual(query(LibraryFilters(q: "a=b#c?d%e")).queryString(), "q=a%3Db%23c%3Fd%25e&limit=100&offset=0")
    }

    func testAccentsAndEmojiArePercentEncodedAsUTF8() {
        XCTAssertEqual(query(LibraryFilters(album: "Là città")).queryString(), "album=L%C3%A0%20citt%C3%A0&limit=100&offset=0")
        XCTAssertEqual(query(LibraryFilters(q: "🎵")).queryString(), "q=%F0%9F%8E%B5&limit=100&offset=0")
    }

    /// What the server parses must be exactly what the user typed, whatever it is.
    func testEveryNastyStringSurvivesTheRoundTrip() throws {
        let nasty = ["a&b=c+d%20e#f?g/h", "Là città — «prova»", "50% off + more", "x=1&y=2", "日本語 🎵 ñ", "tab\there", "semi;colon,comma"]
        for text in nasty {
            let q = query(LibraryFilters(q: text, album: text)).queryString(user: "mike")
            var comps = URLComponents()
            comps.percentEncodedQuery = q
            let items = try XCTUnwrap(comps.queryItems)
            XCTAssertEqual(items.first { $0.name == "q" }?.value, text, "q: \(text)")
            XCTAssertEqual(items.first { $0.name == "album" }?.value, text, "album: \(text)")
            XCTAssertEqual(items.first { $0.name == "user" }?.value, "mike")
            XCTAssertFalse(q.contains("+"), "a bare plus would be read as a space")
        }
    }

    func testLimitAndOffsetAreKeptInsideWhatTheServerAccepts() {
        XCTAssertEqual(query(limit: 0).queryString(), "limit=1&offset=0")
        XCTAssertEqual(query(limit: 9999, offset: -5).queryString(), "limit=500&offset=0")
    }

    func testLongTextIsCutToWhatTheServerAcceptsWithoutSplittingACharacter() {
        let long = String(repeating: "a", count: 300)
        let cleaned = try? XCTUnwrap(LibraryQuery.clean(long))
        XCTAssertEqual(cleaned?.utf16.count, 200)
        // 150 emoji = 300 UTF-16 units: only 100 fit, and none is cut in half.
        let emoji = LibraryQuery.clean(String(repeating: "🎵", count: 150))
        XCTAssertEqual(emoji?.count, 100)
        XCTAssertEqual(emoji?.utf16.count, 200)
    }

    func testUserHintGoesLast() {
        XCTAssertEqual(query(LibraryFilters(q: "x")).queryString(user: "mike"), "q=x&limit=100&offset=0&user=mike")
        XCTAssertEqual(query().queryString(user: " "), "limit=100&offset=0", "a blank user is not sent")
    }
}

final class DecadeFilterTests: XCTestCase {
    func testValuesParseOnlyTheWayTheServerAccepts() {
        XCTAssertEqual(DecadeFilter(value: "1980"), .decade(1980))
        XCTAssertEqual(DecadeFilter(value: " 2000 "), .decade(2000))
        XCTAssertEqual(DecadeFilter(value: "none"), .noYear)
        XCTAssertEqual(DecadeFilter(value: "NONE"), .noYear)
        for bad in ["1985", "1890", "2100", "abc", "", "19 80", "-1980", "1980.0", "٢٠٠٠"] {
            XCTAssertNil(DecadeFilter(value: bad), "\(bad.debugDescription) is not a decade")
        }
    }

    func testTheDecadeOfAYear() {
        XCTAssertEqual(DecadeFilter.of(year: 1987), .decade(1980))
        XCTAssertEqual(DecadeFilter.of(year: 1980), .decade(1980))
        XCTAssertEqual(DecadeFilter.of(year: 1989), .decade(1980))
        XCTAssertEqual(DecadeFilter.of(year: 1990), .decade(1990))
        XCTAssertEqual(DecadeFilter.of(year: nil), .noYear)
        XCTAssertTrue(DecadeFilter.decade(1980).matches(year: 1989))
        XCTAssertFalse(DecadeFilter.decade(1980).matches(year: 1990))
        XCTAssertFalse(DecadeFilter.decade(1980).matches(year: nil))
        XCTAssertTrue(DecadeFilter.noYear.matches(year: nil))
        XCTAssertFalse(DecadeFilter.noYear.matches(year: 1999))
    }

    func testLabelsAreThoseOfTheServer() {
        XCTAssertEqual(DecadeFilter.decade(1980).label, "Anni 80")
        XCTAssertEqual(DecadeFilter.decade(1920).label, "Anni 20")
        XCTAssertEqual(DecadeFilter.decade(1990).label, "Anni 90")
        XCTAssertEqual(DecadeFilter.decade(2000).label, "Anni 2000")
        XCTAssertEqual(DecadeFilter.decade(2010).label, "Anni 2010")
        XCTAssertEqual(DecadeFilter.decade(1910).label, "Anni 1910")
        XCTAssertEqual(DecadeFilter.noYear.label, "Senza anno")
    }

    func testTheValueRoundTrips() {
        for decade in [DecadeFilter.decade(1980), .decade(2020), .noYear] {
            XCTAssertEqual(DecadeFilter(value: decade.value), decade)
        }
    }
}

/// The new track fields are optional everywhere: an older server sends none of them.
final class TrackDescriptorDecodingTests: XCTestCase {
    private func decode(_ json: String) throws -> OfflineTrack {
        try JSONDecoder().decode(OfflineTrack.self, from: Data(json.utf8))
    }

    func testAnOldTrackHasNoAlbumGenresOrYear() throws {
        let manifest = try ManifestFixtures.decode(ManifestFixtures.old)
        for track in manifest.tracks {
            XCTAssertNil(track.album)
            XCTAssertEqual(track.genres, [])
            XCTAssertNil(track.year)
        }
        let current = try ManifestFixtures.decode(ManifestFixtures.current)
        XCTAssertNil(current.tracks[0].album, "the 2.8.0 manifest has none either")
    }

    func testTheNewFieldsDecode() throws {
        let t = try decode(#"{"songKey":"k","album":"Church of Scars","genres":["Alternative","Pop"],"year":2018}"#)
        XCTAssertEqual(t.album, "Church of Scars")
        XCTAssertEqual(t.genres, ["Alternative", "Pop"])
        XCTAssertEqual(t.year, 2018)
    }

    func testNullsAndWrongTypesAreNotFatal() throws {
        let nulls = try decode(#"{"songKey":"k","album":null,"genres":null,"year":null}"#)
        XCTAssertNil(nulls.album)
        XCTAssertEqual(nulls.genres, [])
        XCTAssertNil(nulls.year)

        let wrong = try decode(#"{"songKey":"k","album":7,"genres":{"a":1},"year":"abc"}"#)
        XCTAssertNil(wrong.album)
        XCTAssertEqual(wrong.genres, [])
        XCTAssertNil(wrong.year)
        XCTAssertEqual(wrong.songKey, "k", "the rest of the track survives")
    }

    func testGenresKeepOnlyNamesAndABareStringIsOneName() throws {
        XCTAssertEqual(try decode(#"{"songKey":"k","genres":[1,"Rock",{"x":1}]}"#).genres, ["Rock"])
        XCTAssertEqual(try decode(#"{"songKey":"k","genres":"Pop"}"#).genres, ["Pop"])
        XCTAssertEqual(try decode(#"{"songKey":"k","genres":["Pop","  ","Pop"," Rock  Roll "]}"#).genres, ["Pop", "Rock Roll"])
    }

    func testABlankAlbumIsNoAlbumAndWhitespaceIsCollapsed() throws {
        XCTAssertNil(try decode(#"{"songKey":"k","album":"   "}"#).album)
        XCTAssertEqual(try decode(#"{"songKey":"k","album":"  The   Colour "}"#).album, "The Colour")
    }

    func testAYearIsAWholeNumberOrAFloatThatIsOne() throws {
        XCTAssertEqual(try decode(#"{"songKey":"k","year":1982}"#).year, 1982)
        XCTAssertEqual(try decode(#"{"songKey":"k","year":1982.0}"#).year, 1982)
    }

    func testAnImplausibleYearIsNoYear() throws {
        for bad in ["0", "-5", "1899", "2100", "99999"] {
            XCTAssertNil(try decode(#"{"songKey":"k","year":\#(bad)}"#).year, "year \(bad)")
        }
        XCTAssertEqual(try decode(#"{"songKey":"k","year":1900}"#).year, 1900)
        XCTAssertEqual(try decode(#"{"songKey":"k","year":2099}"#).year, 2099)
    }

    func testTheFieldsSurviveEncodingBecauseTheQueuedJobsAreSavedThatWay() throws {
        let t = TestSupport.track("k", album: "Thriller", genres: ["Pop"], year: 1982)
        let again = try JSONDecoder().decode(OfflineTrack.self, from: try JSONEncoder().encode(t))
        XCTAssertEqual(again, t)
        XCTAssertEqual(again.album, "Thriller")
    }

    func testAQueuedJobSavedByAnEarlierBuildStillLoads() throws {
        // `sync-queue.json` written by 1.4.0: no album / genres / year on the track.
        let old = #"[{"home":true,"track":{"songKey":"a","title":"A","artist":"X","state":"ready","canEnqueueSpooty":false}}]"#
        let jobs = try JSONDecoder().decode([QueuedJob].self, from: Data(old.utf8))
        XCTAssertEqual(jobs.count, 1)
        XCTAssertEqual(jobs[0].track.genres, [])
    }
}

final class LibraryPageDecodingTests: XCTestCase {
    private func decode(_ json: String) throws -> LibraryPage {
        try JSONDecoder().decode(LibraryPage.self, from: Data(json.utf8))
    }

    /// The example of docs/mondrop-sync.md.
    static let documented = #"""
    {
      "songs": [ { "songKey": "mj::billie", "title": "Billie Jean", "artist": "Michael Jackson", "album": "Thriller",
                   "genres": ["Pop"], "year": 1982, "state": "ready", "version": "1-1", "plays": 4 } ],
      "total": 214, "offset": 0, "limit": 100,
      "facets": {
        "genres":  [ { "value": "Pop", "label": "Pop", "count": 61 } ],
        "albums":  [ { "value": "Thriller", "label": "Thriller", "count": 9 } ],
        "artists": [ { "value": "Michael Jackson", "label": "Michael Jackson", "count": 14 } ],
        "decades": [ { "value": 1980, "label": "Anni 80", "count": 52 }, { "value": "none", "label": "Senza anno", "count": 7 } ]
      },
      "user": "mike"
    }
    """#

    func testTheDocumentedResponseDecodes() throws {
        let page = try decode(Self.documented)
        XCTAssertEqual(page.total, 214)
        XCTAssertEqual(page.offset, 0)
        XCTAssertEqual(page.limit, 100)
        XCTAssertEqual(page.user, "mike")
        let song = try XCTUnwrap(page.songs.first)
        XCTAssertEqual(song.album, "Thriller")
        XCTAssertEqual(song.genres, ["Pop"])
        XCTAssertEqual(song.year, 1982)
        XCTAssertEqual(song.plays, 4)
        XCTAssertEqual(song.resolvedState, .ready)
    }

    func testTheDecadeValueIsANumberOrTheWordNone() throws {
        let decades = try XCTUnwrap(try decode(Self.documented).facets).decades
        XCTAssertEqual(decades.map(\.value), ["1980", "none"])
        XCTAssertEqual(decades.map(\.label), ["Anni 80", "Senza anno"])
        XCTAssertEqual(decades.map(\.count), [52, 7])
        XCTAssertEqual(DecadeFilter(value: decades[0].value), .decade(1980), "what is shown can be sent back")
        XCTAssertEqual(DecadeFilter(value: decades[1].value), .noYear)
    }

    func testTheOtherHeadingsDecode() throws {
        let facets = try XCTUnwrap(try decode(Self.documented).facets)
        XCTAssertEqual(facets.genres, [LibraryFacetEntry(value: "Pop", label: "Pop", count: 61)])
        XCTAssertEqual(facets.albums.first?.count, 9)
        XCTAssertEqual(facets.artists.first?.label, "Michael Jackson")
    }

    func testWithoutFacetsThereAreNone() throws {
        let page = try decode(#"{"songs":[],"total":0,"offset":100,"limit":100,"user":"mike"}"#)
        XCTAssertNil(page.facets, "facets=0 → the field is absent")
        XCTAssertEqual(page.offset, 100)
    }

    func testAMalformedSongOrHeadingIsSkippedNotFatal() throws {
        let page = try decode(#"""
        {"songs":[{"title":"no key"},{"songKey":"ok","title":"Ok"}],"total":2,
         "facets":{"genres":[{"label":"no value","count":1},{"value":"Pop","count":3}],"albums":"nope","artists":[],"decades":[{"value":2000,"count":5}]}}
        """#)
        XCTAssertEqual(page.songs.map(\.songKey), ["ok"])
        let facets = try XCTUnwrap(page.facets)
        XCTAssertEqual(facets.genres.map(\.value), ["Pop"])
        XCTAssertEqual(facets.genres.first?.label, "Pop", "no label → the value")
        XCTAssertEqual(facets.albums, [])
        XCTAssertEqual(facets.decades.map(\.value), ["2000"])
        XCTAssertEqual(facets.decades.first?.label, "Anni 2000", "a decade the server did not label is still said the Italian way")
    }

    func testMissingTotalFallsBackToWhatWasSent() throws {
        let page = try decode(#"{"songs":[{"songKey":"a"},{"songKey":"b"}],"offset":10}"#)
        XCTAssertEqual(page.total, 12)
        XCTAssertEqual(page.limit, LibraryQuery.defaultLimit)
    }

    func testATotalSmallerThanWhatWasSentIsRaised() throws {
        XCTAssertEqual(try decode(#"{"songs":[{"songKey":"a"},{"songKey":"b"}],"total":1}"#).total, 2)
    }

    func testUnknownFieldsAreIgnoredAndAnEmptyObjectIsAnEmptyPage() throws {
        let page = try decode(#"{"songs":[{"songKey":"a","future":{"x":1}}],"total":1,"somethingNew":true}"#)
        XCTAssertEqual(page.songs.count, 1)
        let empty = try decode("{}")
        XCTAssertEqual(empty.songs.count, 0)
        XCTAssertEqual(empty.total, 0)
    }
}

/// The HTTP side, against the URLProtocol stub: the request that goes on the wire.
final class LibraryAPITests: XCTestCase {
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

    func testTheRequestIsAGetWithTheFiltersEncodedOnTheWire() async throws {
        StubURLProtocol.handler = { _ in (200, Data(LibraryPageDecodingTests.documented.utf8)) }
        let page = try await api().library(
            LibraryQuery(filters: LibraryFilters(q: "Maestro Bassi", genre: "R&B/Soul", artist: "AC+DC", decade: .decade(1980)), limit: 50, offset: 100, withFacets: false)
        )
        XCTAssertEqual(page.total, 214)
        let request = try XCTUnwrap(captured).request
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.host, "soundreel.test")
        XCTAssertEqual(request.url?.path, "/api/mondrop/library")
        XCTAssertEqual(
            request.url?.query,
            "q=Maestro%20Bassi&genre=R%26B%2FSoul&artist=AC%2BDC&decade=1980&limit=50&offset=100&facets=0&user=mike",
            "encoded by hand: nothing is re-encoded and a plus never goes out bare"
        )
    }

    func testCredentialsAndTheUserHintTravelAsInEveryOtherCall() async throws {
        StubURLProtocol.handler = { _ in (200, Data("{}".utf8)) }
        _ = try await api().library(q: "x")
        let request = try XCTUnwrap(captured).request
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-SoundReel-Key"), "sr_test_key_0123456789abcdef")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-SoundReel-User"), "mike")
        XCTAssertEqual(request.url?.query, "q=x&limit=100&offset=0&user=mike")
    }

    func testTheConvenienceCallBuildsTheSameQuery() async throws {
        StubURLProtocol.handler = { _ in (200, Data("{}".utf8)) }
        _ = try await api().library(album: "Thriller", decade: .noYear, limit: 20, offset: 40, facets: false)
        XCTAssertEqual(try XCTUnwrap(captured).request.url?.query, "album=Thriller&decade=none&limit=20&offset=40&facets=0&user=mike")
    }

    func testAnInvalidQueryIsAnHttpError() async {
        StubURLProtocol.handler = { _ in (400, Data(#"{"error":"invalid_query","field":"decade"}"#.utf8)) }
        do {
            _ = try await api().library(LibraryQuery())
            XCTFail("should have thrown")
        } catch {
            XCTAssertEqual(error as? MondropAPIError, .http(400, #"{"error":"invalid_query","field":"decade"}"#))
        }
    }

    func testAnOlderServerAnswers404() async {
        StubURLProtocol.handler = { _ in (404, Data(#"{"error":"not found"}"#.utf8)) }
        do {
            _ = try await api().library(LibraryQuery())
            XCTFail("should have thrown")
        } catch {
            guard case .http(404, _)? = error as? MondropAPIError else { return XCTFail("\(error)") }
        }
    }

    func testWithoutAKeyNothingIsSent() async {
        let noKey = MondropAPI(session: StubURLProtocol.session(), config: { MondropAPIConfig(baseURL: "https://x.test", apiKey: "", user: "mike") })
        do {
            _ = try await noKey.library(LibraryQuery())
            XCTFail("should have thrown")
        } catch {
            XCTAssertEqual(error as? MondropAPIError, .missingApiKey)
        }
        XCTAssertTrue(StubURLProtocol.captured.isEmpty)
    }

    func testTheOtherCallsStillSendTheUserTheOldWay() async throws {
        StubURLProtocol.handler = { _ in (200, Data(#"{"playlists":[]}"#.utf8)) }
        _ = try await api().listPlaylists()
        XCTAssertEqual(try XCTUnwrap(captured).request.url?.query, "user=mike")
    }
}
