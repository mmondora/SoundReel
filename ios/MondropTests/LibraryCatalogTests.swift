import XCTest
@testable import Mondrop

/// The rules of the library on the phone — a port of backend/src/services/libraryFacets.test.ts, case by case, so the
/// phone answers offline what the server answers online.
final class SearchTextTests: XCTestCase {
    func testNoCaseNoAccentsAndEveryRunOfPunctuationIsOneSpace() {
        XCTAssertEqual(SearchText.normalize("Là Città!"), "la citta")
        XCTAssertEqual(SearchText.normalize("  AC/DC — Back In Black  "), "ac dc back in black")
        XCTAssertEqual(SearchText.normalize("R&B/Soul"), "r b soul")
        XCTAssertEqual(SearchText.normalize("Beyoncé"), "beyonce")
        XCTAssertEqual(SearchText.normalize("..."), "")
        XCTAssertEqual(SearchText.normalize(""), "")
    }

    func testTokensIgnoreOrderAndPunctuation() {
        XCTAssertEqual(SearchText.tokens("Maestro  Bassi"), ["maestro", "bassi"])
        XCTAssertEqual(SearchText.tokens("  "), [])
    }
}

final class LibraryCatalogTests: XCTestCase {
    private let songs = TestSupport.catalog()
    private func titles(_ f: LibraryFilters, skipping: LibraryCatalog.Heading? = nil) -> [String] {
        TestSupport.titles(LibraryCatalog.filter(songs, f, skipping: skipping))
    }

    // MARK: filter

    func testNoFilterGivesEverySongInTheOrderGiven() {
        XCTAssertEqual(titles(.none), TestSupport.titles(songs))
    }

    func testByGenre() {
        XCTAssertEqual(titles(LibraryFilters(genre: "Elettronica")), ["One More Time", "Around the World"])
        XCTAssertEqual(titles(LibraryFilters(genre: "elettronica")), ["One More Time", "Around the World"], "no case")
        XCTAssertEqual(titles(LibraryFilters(genre: "Alternative")), ["Creep", "Everlong"])
        XCTAssertEqual(titles(LibraryFilters(genre: "Rock")), ["Beat It"], "a song can be of two genres")
    }

    func testByDecadeAnni80IsFrom1980To1989() {
        XCTAssertEqual(titles(LibraryFilters(decade: .decade(1980))), ["Billie Jean", "Beat It", "Like a Prayer", "Untitled"])
        XCTAssertEqual(titles(LibraryFilters(decade: .decade(1990))), ["Around the World", "Creep", "Everlong"])
        XCTAssertEqual(titles(LibraryFilters(decade: .decade(2000))), ["One More Time", "Il Mio Ragazzo"])
        XCTAssertEqual(titles(LibraryFilters(decade: .decade(1970))), [])
    }

    func testSenzaAnnoFindsTheSongsNoProviderDated() {
        XCTAssertEqual(titles(LibraryFilters(decade: .noYear)), ["Mystery"])
    }

    func testByAlbumIgnoringCaseAccentsAndPunctuation() {
        XCTAssertEqual(titles(LibraryFilters(album: "thriller")), ["Billie Jean", "Beat It"])
        XCTAssertEqual(titles(LibraryFilters(album: "THE COLOUR AND THE SHAPE")), ["Everlong"])
        XCTAssertEqual(titles(LibraryFilters(album: "mystery lp")), ["Mystery"])
        XCTAssertEqual(titles(LibraryFilters(album: "like a prayer!")), ["Like a Prayer"])
    }

    func testByArtist() {
        XCTAssertEqual(titles(LibraryFilters(artist: "daft punk")), ["One More Time", "Around the World"])
    }

    func testFreeTextWordsInAnyOrder() {
        XCTAssertEqual(titles(LibraryFilters(q: "Maestro Bassi")), ["Il Mio Ragazzo"], "«Maestro Bassi» finds «Bassi Maestro»")
        XCTAssertEqual(titles(LibraryFilters(q: "jean billie")), ["Billie Jean"])
        XCTAssertEqual(titles(LibraryFilters(q: "pablo honey")), ["Creep"], "through the album")
    }

    func testFiltersCombine() {
        XCTAssertEqual(titles(LibraryFilters(genre: "Pop", decade: .decade(1980))), ["Billie Jean", "Beat It", "Like a Prayer", "Untitled"])
        XCTAssertEqual(titles(LibraryFilters(genre: "Pop", artist: "madonna", decade: .decade(1980))), ["Like a Prayer"])
        XCTAssertEqual(titles(LibraryFilters(genre: "Pop", decade: .decade(2000))), [])
    }

    func testOneFilterCanBeLeftOut() {
        XCTAssertEqual(titles(LibraryFilters(genre: "Rock", decade: .decade(1990)), skipping: .genre), ["Around the World", "Creep", "Everlong"])
    }

    func testABlankFilterIsNoFilter() {
        XCTAssertEqual(titles(LibraryFilters(q: "   ", genre: "")), TestSupport.titles(songs))
    }

    // MARK: facets

    func testGenresAreCountedMostSongsFirst() {
        let genres = LibraryCatalog.facets(of: songs, filters: .none).genres
        XCTAssertEqual(genres.first, LibraryFacetEntry(value: "Pop", label: "Pop", count: 4))
        XCTAssertEqual(genres.first { $0.value == "Elettronica" }?.count, 2)
        XCTAssertEqual(genres.first { $0.value == "Alternative" }?.count, 2)
        XCTAssertEqual(genres.first { $0.value == "Rock" }?.count, 1)
    }

    func testDecadesAreChronologicalWithSenzaAnnoLast() {
        let decades = LibraryCatalog.facets(of: songs, filters: .none).decades
        XCTAssertEqual(decades.map(\.value), ["1980", "1990", "2000", "none"])
        XCTAssertEqual(decades.map(\.label), ["Anni 80", "Anni 90", "Anni 2000", "Senza anno"])
        XCTAssertEqual(decades.map(\.count), [4, 3, 2, 1])
    }

    func testNoSenzaAnnoEntryWhenEverySongHasAYear() {
        let dated = [songs[0], songs[2]]
        XCTAssertEqual(LibraryCatalog.facets(of: dated, filters: .none).decades.map(\.value), ["1980"])
    }

    func testAlbumsAndArtistsLeaveOutTheBlanks() {
        let facets = LibraryCatalog.facets(of: songs, filters: .none)
        XCTAssertEqual(facets.albums.first, LibraryFacetEntry(value: "Thriller", label: "Thriller", count: 2))
        XCTAssertTrue(facets.albums.map(\.value).contains("Mystery LP"))
        XCTAssertFalse(facets.albums.map(\.value).contains(""))
        XCTAssertEqual(facets.artists.prefix(2).map { "\($0.value) \($0.count)" }, ["Daft Punk 2", "Michael Jackson 2"], "ties A to Z")
        XCTAssertFalse(facets.artists.map(\.value).contains(""), "the song with no artist is not an artist")
    }

    func testEachHeadingCountsWithoutItsOwnFilter() {
        let facets = LibraryCatalog.facets(of: songs, filters: LibraryFilters(genre: "Elettronica"))
        XCTAssertEqual(facets.albums.map(\.value).sorted(), ["Discovery", "Homework"], "a genre narrows the albums…")
        XCTAssertEqual(facets.artists.map(\.value), ["Daft Punk"])
        XCTAssertTrue(facets.genres.map(\.value).contains("Pop"), "…but the other genres stay there to switch to")
        XCTAssertEqual(facets.genres.first { $0.value == "Pop" }?.count, 4)
        XCTAssertEqual(facets.decades.map(\.value), ["1990", "2000"])
    }

    func testADecadeNarrowsTheGenresButNotTheDecades() {
        let facets = LibraryCatalog.facets(of: songs, filters: LibraryFilters(decade: .decade(1980)))
        XCTAssertEqual(facets.genres.map(\.value).sorted(), ["Pop", "Rock"])
        XCTAssertEqual(facets.decades.map(\.value), ["1980", "1990", "2000", "none"])
    }

    func testAValueIsSpeltTheWayMostOfItsSongsSpellIt() {
        let spelt = [
            TestSupport.track("a", artist: "Daft Punk", album: "Discovery"),
            TestSupport.track("b", artist: "daft punk", album: "discovery"),
            TestSupport.track("c", artist: "Daft Punk", album: "Discovery"),
        ]
        let facets = LibraryCatalog.facets(of: spelt, filters: .none)
        XCTAssertEqual(facets.albums, [LibraryFacetEntry(value: "Discovery", label: "Discovery", count: 3)])
        XCTAssertEqual(facets.artists, [LibraryFacetEntry(value: "Daft Punk", label: "Daft Punk", count: 3)])
    }

    func testOfNothingGivesNothing() {
        XCTAssertEqual(LibraryCatalog.facets(of: [], filters: .none), .empty)
    }

    // MARK: sort + page

    func testSortedByArtistThenTitleAccentsAndCaseAside() {
        let input = [
            TestSupport.track("1", title: "z", artist: "b"), TestSupport.track("2", title: "y", artist: "A"),
            TestSupport.track("3", title: "a", artist: "b"), TestSupport.track("4", title: "b", artist: "À"),
        ]
        XCTAssertEqual(LibraryCatalog.sortedByArtistTitle(input).map { "\($0.artist)/\($0.title)" }, ["A/y", "À/b", "b/a", "b/z"])
        XCTAssertEqual(input.map(\.title), ["z", "y", "a", "b"], "the input is not touched")
    }

    func testAPageHasTheTotalOfEverythingThatMatches() {
        let page = LibraryCatalog.page(of: songs, filters: LibraryFilters(genre: "Pop"), limit: 2, offset: 0)
        XCTAssertEqual(page.total, 4)
        XCTAssertEqual(page.songs.count, 2)
        XCTAssertEqual(page.offset, 0)
        XCTAssertNotNil(page.facets)
        let second = LibraryCatalog.page(of: songs, filters: LibraryFilters(genre: "Pop"), limit: 2, offset: 2, withFacets: false)
        XCTAssertEqual(second.songs.count, 2)
        XCTAssertNil(second.facets)
        let keys = Set((page.songs + second.songs).map(\.songKey))
        XCTAssertEqual(keys.count, 4, "the two pages do not overlap")
    }

    func testPagesPastTheEndAreEmptyAndAHugeLimitDoesNotOverflow() {
        XCTAssertEqual(LibraryCatalog.page(of: songs, filters: .none, limit: 10, offset: 999).songs.count, 0)
        XCTAssertEqual(LibraryCatalog.page(of: songs, filters: .none, limit: Int.max, offset: 3).songs.count, songs.count - 3)
        XCTAssertEqual(LibraryCatalog.page(of: songs, filters: .none, limit: 0).songs.count, 0)
        XCTAssertEqual(LibraryCatalog.page(of: songs, filters: .none, limit: 5, offset: -3).offset, 0)
    }

    func testPageOrderIsArtistThenTitle() {
        let page = LibraryCatalog.page(of: songs, filters: LibraryFilters(genre: "Pop"))
        XCTAssertEqual(page.songs.map(\.title), ["Untitled", "Like a Prayer", "Beat It", "Billie Jean"], "no artist first, then Madonna, then Jackson by title")
    }
}
