import XCTest
@testable import Mondrop

/// The choice made in «Libreria» becomes the queue («In coda»).
final class LibraryQueueTests: XCTestCase {
    private let all = TestSupport.catalog()

    private func queue(
        _ choice: LibraryChoice, from tracks: [OfflineTrack]? = nil, startAt: String? = nil, shuffled: Bool = false,
        local: Set<String> = [], localFirst: Bool = false
    ) -> PlayQueue? {
        var generator = SeededGenerator(seed: 42)
        return LibraryQueueBuilder.make(
            choice: choice, tracks: tracks ?? all, startAt: startAt, shuffled: shuffled, localFirst: localFirst, using: &generator,
            isLocal: { local.contains($0) }
        )
    }

    /// What the album screen would hold: the songs the filters select, in the server's order.
    private func chosen(_ choice: LibraryChoice) -> [OfflineTrack] {
        LibraryCatalog.page(of: all, filters: choice.filters).songs
    }

    // MARK: from an album / artist / decade / tipo

    func testAnAlbumBecomesTheQueueStartingAtTheFirstSong() throws {
        let choice = LibraryChoice.album("Thriller")
        let q = try XCTUnwrap(queue(choice, from: chosen(choice)))
        XCTAssertEqual(q.items.map(\.title), ["Beat It", "Billie Jean"])
        XCTAssertEqual(q.startIndex, 0)
        XCTAssertEqual(q.label, "Album · Thriller")
        XCTAssertNil(q.playlistId)
    }

    func testAnArtistBecomesTheQueue() throws {
        let choice = LibraryChoice.artist("Daft Punk")
        let q = try XCTUnwrap(queue(choice, from: chosen(choice)))
        XCTAssertEqual(q.items.map(\.title), ["Around the World", "One More Time"])
        XCTAssertEqual(q.label, "Autore · Daft Punk")
    }

    func testADecadeBecomesTheQueueAndSenzaAnnoToo() throws {
        let eighties = LibraryChoice.decade(.decade(1980))
        let q = try XCTUnwrap(queue(eighties, from: chosen(eighties)))
        XCTAssertEqual(Set(q.items.map(\.title)), ["Billie Jean", "Beat It", "Like a Prayer", "Untitled"])
        XCTAssertEqual(q.label, "Anni 80")

        let none = LibraryChoice.decade(.noYear)
        let undated = try XCTUnwrap(queue(none, from: chosen(none)))
        XCTAssertEqual(undated.items.map(\.title), ["Mystery"])
        XCTAssertEqual(undated.label, "Senza anno")
    }

    func testATipoBecomesTheQueue() throws {
        let choice = LibraryChoice.genre("Alternative")
        let q = try XCTUnwrap(queue(choice, from: chosen(choice)))
        XCTAssertEqual(q.items.count, 2)
        XCTAssertEqual(q.label, "Tipo · Alternative")
    }

    func testTheTappedSongIsWhereItStartsAndTheRestFollows() throws {
        let choice = LibraryChoice.album("Thriller")
        let songs = chosen(choice)
        let q = try XCTUnwrap(queue(choice, from: songs, startAt: "mj::billie"))
        XCTAssertEqual(q.items.count, 2, "the whole album is still the queue")
        XCTAssertEqual(q.items[q.startIndex].songKey, "mj::billie")
        XCTAssertEqual(q.startIndex, 1)
    }

    func testItemsCarryTheTrackSoTheFirstPlayLogicCanStreamAndDownload() throws {
        let q = try XCTUnwrap(queue(.album("Thriller"), from: chosen(.album("Thriller"))))
        for item in q.items { XCTAssertNotNil(item.track) }
        XCTAssertEqual(q.items.first?.track?.album, "Thriller")
    }

    // MARK: single song, playlist, search, phone

    func testASingleSongIsAQueueOfOne() throws {
        let song = try XCTUnwrap(all.first { $0.songKey == "md::prayer" })
        let q = try XCTUnwrap(queue(.song(title: song.title), from: [song]))
        XCTAssertEqual(q.items.map(\.songKey), ["md::prayer"])
        XCTAssertEqual(q.label, "Brano · Like a Prayer")
    }

    func testAPlaylistKeepsItsOrderAndCreditsTheListens() throws {
        let tracks = [TestSupport.track("c"), TestSupport.track("a"), TestSupport.track("b")]
        let q = try XCTUnwrap(queue(.playlist(id: "pl1", name: "Road trip"), from: tracks, startAt: "a"))
        XCTAssertEqual(q.items.map(\.songKey), ["c", "a", "b"], "a hand-made playlist is not re-sorted")
        XCTAssertEqual(q.startIndex, 1)
        XCTAssertEqual(q.playlistId, "pl1", "listening stats credit the playlist")
        XCTAssertEqual(q.label, "Playlist · Road trip")
    }

    func testSearchAndPhoneAndEverythingHaveTheirOwnLabel() throws {
        XCTAssertEqual(LibraryChoice.search(" billie ").label, "Ricerca · «billie»")
        XCTAssertEqual(LibraryChoice.onPhone.label, "Sul telefono")
        XCTAssertEqual(LibraryChoice.everything.label, "Tutta la libreria")
        XCTAssertEqual(LibraryChoice.search("billie").filters, LibraryFilters(q: "billie"))
        XCTAssertEqual(LibraryChoice.album("Thriller").filters, LibraryFilters(album: "Thriller"))
        XCTAssertEqual(LibraryChoice.decade(.noYear).filters, LibraryFilters(decade: .noYear))
        XCTAssertEqual(LibraryChoice.playlist(id: "p", name: "n").filters, .none, "a playlist is not a filter")
    }

    // MARK: what cannot play

    func testSongsTheServerFoundNoSourceForAreLeftOutUnlessTheyAreOnThePhone() throws {
        let tracks = [
            TestSupport.track("a"),
            TestSupport.track("b", state: "no_source", error: "nessun risultato"),
            TestSupport.track("c", state: "no_source"),
            TestSupport.track("d", state: "failed"),
            TestSupport.track("e", state: "preparing"),
        ]
        let q = try XCTUnwrap(queue(.everything, from: tracks, local: ["c"]))
        XCTAssertEqual(q.items.map(\.songKey), ["a", "c", "d", "e"], "b has nowhere to come from; c is already on the phone; failed/preparing are asked again by the first play")
    }

    func testTappingASongThatCannotPlayStartsNothing() {
        let tracks = [TestSupport.track("a"), TestSupport.track("b", state: "no_source")]
        XCTAssertNil(queue(.everything, from: tracks, startAt: "b"))
    }

    func testNothingPlayableIsNoQueue() {
        XCTAssertNil(queue(.everything, from: []))
        XCTAssertNil(queue(.everything, from: [TestSupport.track("a", state: "no_source")]))
    }

    func testASongTwiceIsQueuedOnce() throws {
        let q = try XCTUnwrap(queue(.everything, from: [TestSupport.track("a"), TestSupport.track("a"), TestSupport.track("b")]))
        XCTAssertEqual(q.items.map(\.songKey), ["a", "b"])
    }

    // MARK: Mescola

    func testShuffleKeepsTheSameSongsInAnotherOrder() throws {
        let tracks = (1...30).map { TestSupport.track("s\($0)") }
        let plain = try XCTUnwrap(queue(.everything, from: tracks))
        let mixed = try XCTUnwrap(queue(.everything, from: tracks, shuffled: true))
        XCTAssertEqual(Set(mixed.items.map(\.songKey)), Set(plain.items.map(\.songKey)))
        XCTAssertEqual(mixed.items.count, 30)
        XCTAssertNotEqual(mixed.items.map(\.songKey), plain.items.map(\.songKey))
        XCTAssertEqual(mixed.startIndex, 0)
    }

    func testShuffleIsReproducibleWithTheSameSeed() throws {
        let tracks = (1...30).map { TestSupport.track("s\($0)") }
        let first = try XCTUnwrap(queue(.everything, from: tracks, shuffled: true))
        let second = try XCTUnwrap(queue(.everything, from: tracks, shuffled: true))
        XCTAssertEqual(first.items.map(\.songKey), second.items.map(\.songKey))
    }

    // MARK: «Vanno privilegiati i file già scaricati» (U10)

    func testAQueueThatPrefersThePhoneStartsWithTheSongsThatAreOnIt() throws {
        let tracks = ["a", "b", "c", "d", "e"].map { TestSupport.track($0) }
        let q = try XCTUnwrap(queue(.playlist(id: "p", name: "P"), from: tracks, local: ["d", "b"], localFirst: true))
        XCTAssertEqual(q.items.map(\.songKey), ["b", "d", "a", "c", "e"], "the phone's songs first, each group in the order it came in")
        XCTAssertEqual(q.startIndex, 0)
        XCTAssertEqual(q.playlistId, "p", "the listens are still credited to the playlist")
    }

    func testTheTappedSongIsWhereItStandsInThatOrder() throws {
        let tracks = ["a", "b", "c", "d", "e"].map { TestSupport.track($0) }
        let q = try XCTUnwrap(queue(.playlist(id: "p", name: "P"), from: tracks, startAt: "c", local: ["d", "b"], localFirst: true))
        XCTAssertEqual(q.items.map(\.songKey), ["b", "d", "a", "c", "e"])
        XCTAssertEqual(q.items[q.startIndex].songKey, "c")
    }

    func testWithoutThePreferenceTheOrderIsTheOneGivenWhateverIsOnThePhone() throws {
        let tracks = ["a", "b", "c"].map { TestSupport.track($0) }
        let q = try XCTUnwrap(queue(.playlist(id: "p", name: "P"), from: tracks, local: ["c"]))
        XCTAssertEqual(q.items.map(\.songKey), ["a", "b", "c"])
    }

    func testTheSongsThatCannotPlayAreStillLeftOutWhenThePhoneIsPreferred() throws {
        let tracks = [TestSupport.track("a"), TestSupport.track("b", state: "no_source"), TestSupport.track("c")]
        let q = try XCTUnwrap(queue(.everything, from: tracks, local: ["c"], localFirst: true))
        XCTAssertEqual(q.items.map(\.songKey), ["c", "a"])
    }

    func testShuffleThatPrefersThePhoneMixesEachGroupOnItsOwnAndPlaysThePhoneFirst() throws {
        let tracks = (1...30).map { TestSupport.track("s\($0)") }
        let onPhone = Set((1...10).map { "s\($0 * 2)" })                       // ten of the thirty
        let plain = try XCTUnwrap(queue(.everything, from: tracks, local: onPhone, localFirst: true))
        let mixed = try XCTUnwrap(queue(.everything, from: tracks, shuffled: true, local: onPhone, localFirst: true))
        let keys = mixed.items.map(\.songKey)
        XCTAssertEqual(Set(keys), Set(plain.items.map(\.songKey)))
        XCTAssertEqual(keys.count, 30)
        XCTAssertEqual(Set(keys.prefix(10)), onPhone, "the first ten are exactly the songs on the phone")
        XCTAssertNotEqual(Array(keys.prefix(10)), Array(plain.items.map(\.songKey).prefix(10)), "and they are mixed")
        XCTAssertNotEqual(Array(keys.suffix(20)), Array(plain.items.map(\.songKey).suffix(20)), "so are the online ones")
    }

    func testShuffleThatPrefersThePhoneStillPlaysTheTappedSongFirst() throws {
        let tracks = (1...30).map { TestSupport.track("s\($0)") }
        let q = try XCTUnwrap(queue(.everything, from: tracks, startAt: "s17", shuffled: true, local: ["s2", "s4"], localFirst: true))
        XCTAssertEqual(q.items.first?.songKey, "s17")
        XCTAssertEqual(q.startIndex, 0)
        XCTAssertEqual(q.items.count, 30)
    }

    func testShuffleStillPlaysTheTappedSongFirst() throws {
        let tracks = (1...30).map { TestSupport.track("s\($0)") }
        let q = try XCTUnwrap(queue(.everything, from: tracks, startAt: "s17", shuffled: true))
        XCTAssertEqual(q.startIndex, 0)
        XCTAssertEqual(q.items.first?.songKey, "s17")
        XCTAssertEqual(q.items.count, 30)
    }
}

/// A repeatable generator (SplitMix64), so a shuffle is the same in every run.
struct SeededGenerator: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
