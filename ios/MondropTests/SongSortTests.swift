import XCTest
@testable import Mondrop

/// «Voglio in tutte le playlist anche degli ordinamenti tipo : data di creazione, nome, stato ( locali o online )» (Michele, 11 November, after build 18; spec
/// 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md §12, U18): the songs of a playlist can be listed in the order of the playlist, by name, by state (on the phone /
/// online) and by the date they were added to it. These tables are the rule.
final class SongSortTests: XCTestCase {
    private func song(_ key: String, title: String? = nil, artist: String = "Artist", added: String? = nil) -> OfflineTrack {
        OfflineTrack(songKey: key, title: title ?? key, artist: artist, addedAt: added)
    }

    /// «a» and «c» are on the phone, «e» is in error, the rest are online.
    private func phone(_ track: OfflineTrack) -> SongState {
        switch track.songKey {
        case "a", "c": return .local
        case "e": return .error("brano non disponibile")
        default: return .online(percent: nil)
        }
    }

    private func keys(_ tracks: [OfflineTrack]) -> [String] { tracks.map(\.songKey) }

    private let five = ["a", "b", "c", "d", "e"]

    private func sorted(_ tracks: [OfflineTrack], _ sort: SongSort, _ order: PlaylistOrder) -> [String] {
        keys(SongSort.sorted(tracks, by: sort, order: order, state: phone))
    }

    // MARK: stato

    func testStateWithThePhoneFirstPutsTheSongsOnItFirstThenOnlineThenErrorsKeepingThePlaylistOrderInside() {
        XCTAssertEqual(sorted(five.map { song($0) }, .state, .asc), ["a", "c", "b", "d", "e"])
    }

    func testStateWithOnlineFirstPutsTheOnlineSongsFirstAndTheErrorsStayLast() {
        XCTAssertEqual(sorted(five.map { song($0) }, .state, .desc), ["b", "d", "a", "c", "e"])
    }

    // MARK: ordine della playlist

    func testThePlaylistOrderIsTheOneSoundReelSentAndItsReverse() {
        XCTAssertEqual(sorted(five.map { song($0) }, .playlist, .asc), five)
        XCTAssertEqual(sorted(five.map { song($0) }, .playlist, .desc), ["e", "d", "c", "b", "a"])
    }

    // MARK: nome

    func testNameIsAToZIgnoringCaseAndAccents() {
        let titles = ["a": "Zeta", "b": "alfa", "c": "Èco", "d": "beta", "e": "Delta"]
        let tracks = five.map { song($0, title: titles[$0]) }
        XCTAssertEqual(sorted(tracks, .name, .asc), ["b", "d", "e", "c", "a"], "alfa, beta, Delta, Èco, Zeta")
        XCTAssertEqual(sorted(tracks, .name, .desc), ["a", "c", "e", "d", "b"])
    }

    func testNumbersInANameCountAsNumbers() {
        let tracks = [song("a", title: "Brano 10"), song("b", title: "Brano 2"), song("c", title: "Brano 1")]
        XCTAssertEqual(sorted(tracks, .name, .asc), ["c", "b", "a"])
    }

    func testTwoSongsWithTheSameNameGoByArtistThenByTheOrderOfThePlaylist() {
        let tracks = [song("x1", title: "Same", artist: "B"), song("x2", title: "Same", artist: "A"), song("x3", title: "Same", artist: "A")]
        XCTAssertEqual(sorted(tracks, .name, .asc), ["x2", "x3", "x1"])
        XCTAssertEqual(sorted(tracks, .name, .desc), ["x1", "x3", "x2"], "the other direction is the exact reverse")
    }

    // MARK: data di aggiunta

    func testTheDateOfAdditionHasTheNewestFirstAndTheUndatedLast() {
        let tracks = [
            song("a", added: "2026-11-01T10:00:00.000Z"), song("b", added: "2026-11-05T10:00:00.000Z"), song("c"),
            song("d", added: "2026-11-03T10:00:00Z"), song("e"),
        ]
        XCTAssertEqual(sorted(tracks, .added, .desc), ["b", "d", "a", "c", "e"], "the ones with no date stay last, in the order of the playlist")
    }

    func testTheOldestFirstStillLeavesTheUndatedLast() {
        let tracks = [
            song("a", added: "2026-11-01T10:00:00.000Z"), song("b", added: "2026-11-05T10:00:00.000Z"), song("c"),
            song("d", added: "2026-11-03T10:00:00Z"), song("e"),
        ]
        XCTAssertEqual(sorted(tracks, .added, .asc), ["a", "d", "b", "c", "e"])
    }

    func testADateNobodyCanReadIsNoDate() {
        let tracks = [song("a", added: "ieri"), song("b", added: "2026-11-05T10:00:00.000Z")]
        XCTAssertEqual(sorted(tracks, .added, .desc), ["b", "a"])
    }

    func testTwoSongsAddedTogetherKeepTheOrderOfThePlaylist() {
        // an automatic playlist puts all its songs in with one date: that is no reason to shuffle them
        let tracks = ["a", "b", "c"].map { song($0, added: "2026-11-05T10:00:00.000Z") }
        XCTAssertEqual(sorted(tracks, .added, .desc), ["a", "b", "c"])
        XCTAssertEqual(sorted(tracks, .added, .asc), ["a", "b", "c"])
    }

    // MARK: what the menu offers

    func testTheDateOfAdditionIsOfferedOnlyWhenSomeSongHasOne() {
        XCTAssertEqual(SongSort.available(for: [song("a"), song("b")]), [.state, .playlist, .name])
        XCTAssertEqual(SongSort.available(for: []), [.state, .playlist, .name])
        XCTAssertEqual(SongSort.available(for: [song("a"), song("b", added: "2026-11-05T10:00:00.000Z")]), [.state, .playlist, .name, .added])
        XCTAssertEqual(SongSort.available(for: [song("a", added: "non è una data")]), [.state, .playlist, .name], "a date nobody can read is no date")
    }

    func testEverySortKnowsItsNaturalDirectionAndItsWords() {
        XCTAssertEqual(SongSort.allCases, [.state, .playlist, .name, .added])
        XCTAssertEqual(SongSort.state.naturalOrder, .asc)
        XCTAssertEqual(SongSort.playlist.naturalOrder, .asc)
        XCTAssertEqual(SongSort.name.naturalOrder, .asc)
        XCTAssertEqual(SongSort.added.naturalOrder, .desc)
        XCTAssertEqual(SongSort.state.title, "Stato (sul telefono / online)")
        XCTAssertEqual(SongSort.state.orderTitle(.asc), "Sul telefono prima")
        XCTAssertEqual(SongSort.state.orderTitle(.desc), "Online prima")
        XCTAssertEqual(SongSort.playlist.title, "Ordine della playlist")
        XCTAssertEqual(SongSort.playlist.orderTitle(.asc), "Come nella playlist")
        XCTAssertEqual(SongSort.playlist.orderTitle(.desc), "Dall'ultimo al primo")
        XCTAssertEqual(SongSort.name.title, "Nome")
        XCTAssertEqual(SongSort.name.orderTitle(.asc), "Da A a Z")
        XCTAssertEqual(SongSort.name.orderTitle(.desc), "Da Z a A")
        XCTAssertEqual(SongSort.added.title, "Data di aggiunta")
        XCTAssertEqual(SongSort.added.orderTitle(.desc), "Più recenti prima")
        XCTAssertEqual(SongSort.added.orderTitle(.asc), "Più vecchie prima")
    }

    // MARK: nothing lost

    func testWhateverTheSortNothingIsDroppedOrRepeated() {
        let tracks = five.map { song($0, title: "T\($0)", added: $0 == "c" ? nil : "2026-11-0\(five.firstIndex(of: $0)! + 1)T10:00:00.000Z") }
        for sort in SongSort.allCases {
            for order in [PlaylistOrder.asc, .desc] {
                XCTAssertEqual(Set(sorted(tracks, sort, order)), Set(five), "\(sort) \(order)")
                XCTAssertEqual(sorted(tracks, sort, order).count, five.count, "\(sort) \(order)")
            }
        }
        XCTAssertEqual(sorted([], .name, .asc), [])
    }

    // MARK: the date that comes from the server

    func testTheDateASongWasAddedComesFromTheManifestWhenTheServerSendsIt() throws {
        let json = #"{"songKey":"a","title":"A","artist":"X","state":"ready","addedAt":"2026-11-05T10:00:00.000Z"}"#
        let track = try JSONDecoder().decode(OfflineTrack.self, from: Data(json.utf8))
        XCTAssertEqual(track.addedAt, "2026-11-05T10:00:00.000Z")
        XCTAssertNotNil(track.addedDate)
    }

    func testAnOlderServerOrADynamicPlaylistSendsNoDate() throws {
        let old = try JSONDecoder().decode(OfflineTrack.self, from: Data(#"{"songKey":"a","title":"A","artist":"X"}"#.utf8))
        XCTAssertNil(old.addedAt)
        let null = try JSONDecoder().decode(OfflineTrack.self, from: Data(#"{"songKey":"a","title":"A","artist":"X","addedAt":null}"#.utf8))
        XCTAssertNil(null.addedAt)
        XCTAssertNil(null.addedDate)
    }

    func testTheDateSurvivesTheFileTheListIsKeptIn() throws {
        let original = song("a", added: "2026-11-05T10:00:00.000Z")
        let back = try JSONDecoder().decode(OfflineTrack.self, from: JSONEncoder().encode(original))
        XCTAssertEqual(back.addedAt, "2026-11-05T10:00:00.000Z")
    }
}

/// The sort the person chose last is kept between launches: one for the list of playlists, one for the songs inside a playlist.
final class SortPreferencesTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "mondrop.test.sortprefs.\(UUID().uuidString)"
        let suite = UserDefaults(suiteName: name)!
        addTeardownBlock { suite.removePersistentDomain(forName: name) }
        return suite
    }

    func testNothingChosenIsTheStateSortWithThePhoneFirstEverywhere() {
        let prefs = SortPreferences(defaults: defaults())
        XCTAssertEqual(prefs.playlists.sort, .state)
        XCTAssertEqual(prefs.playlists.order, .asc)
        XCTAssertEqual(prefs.songs.sort, .state)
        XCTAssertEqual(prefs.songs.order, .asc)
    }

    func testTheChoiceOfThePlaylistsAndTheChoiceOfTheSongsAreKeptApart() {
        let suite = defaults()
        let prefs = SortPreferences(defaults: suite)
        prefs.playlists = (.name, .desc)
        prefs.songs = (.added, .asc)
        let again = SortPreferences(defaults: suite)
        XCTAssertEqual(again.playlists.sort, .name)
        XCTAssertEqual(again.playlists.order, .desc)
        XCTAssertEqual(again.songs.sort, .added)
        XCTAssertEqual(again.songs.order, .asc)
    }

    func testAnUnreadableChoiceIsTheFirstOneAndAnUnreadableDirectionIsTheNaturalOne() {
        let suite = defaults()
        suite.set("zzz", forKey: SortPreferences.playlistSortKey)
        suite.set("zzz", forKey: SortPreferences.songSortKey)
        let prefs = SortPreferences(defaults: suite)
        XCTAssertEqual(prefs.playlists.sort, .state)
        XCTAssertEqual(prefs.songs.sort, .state)

        suite.set("created", forKey: SortPreferences.playlistSortKey)
        suite.set("sideways", forKey: SortPreferences.playlistOrderKey)
        suite.set("added", forKey: SortPreferences.songSortKey)
        XCTAssertEqual(prefs.playlists.order, .desc, "the date of creation goes newest first")
        XCTAssertEqual(prefs.songs.order, .desc, "the date of addition goes newest first")
    }
}
