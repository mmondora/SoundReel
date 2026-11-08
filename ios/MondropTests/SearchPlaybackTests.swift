import XCTest
@testable import Mondrop

/// What a tap, «Riproduci», «Casuale» and «Aggiungi in coda» do with the songs «Cerca» shows.
final class SearchPlaybackTests: XCTestCase {
    private func tracks() -> [OfflineTrack] {
        [
            TestSupport.track("a::1", title: "Uno", artist: "A"),
            TestSupport.track("a::2", title: "Due", artist: "A"),
            TestSupport.track("a::3", title: "Tre", artist: "A"),
            TestSupport.track("a::4", title: "Quattro", artist: "A"),
        ]
    }

    private let none: (String) -> Bool = { _ in false }

    // MARK: tap = this song and the ones that follow

    func testATapStartsThatSongAndQueuesTheOnesThatFollow() throws {
        let queue = try XCTUnwrap(SearchPlayback.queue(choice: .search("a"), tracks: tracks(), tapped: "a::2", isLocal: none))
        XCTAssertEqual(queue.items.map(\.songKey), ["a::2", "a::3", "a::4"], "what comes before is not queued")
        XCTAssertEqual(queue.startIndex, 0)
        XCTAssertEqual(queue.label, "Ricerca · «a»")
        XCTAssertNil(queue.playlistId)
    }

    func testTheLastSongOfAListIsAQueueOfOne() throws {
        let queue = try XCTUnwrap(SearchPlayback.queue(choice: .search("a"), tracks: tracks(), tapped: "a::4", isLocal: none))
        XCTAssertEqual(queue.items.map(\.songKey), ["a::4"])
    }

    func testASongThatIsNotInTheListDoesNothing() {
        XCTAssertNil(SearchPlayback.queue(choice: .search("a"), tracks: tracks(), tapped: "ghost::x", isLocal: none))
        XCTAssertNil(SearchPlayback.queue(choice: .search("a"), tracks: [], tapped: "a::1", isLocal: none))
    }

    func testASongWithNoSourceDoesNothingUnlessItIsOnThePhone() throws {
        var list = tracks()
        list[1] = TestSupport.track("a::2", state: "no_source", version: nil, bytes: nil, title: "Due", artist: "A")
        XCTAssertNil(SearchPlayback.queue(choice: .search("a"), tracks: list, tapped: "a::2", isLocal: none), "a «da cercare» row does nothing")
        let onPhone = try XCTUnwrap(SearchPlayback.queue(choice: .search("a"), tracks: list, tapped: "a::2", isLocal: { $0 == "a::2" }))
        XCTAssertEqual(onPhone.items.map(\.songKey), ["a::2", "a::3", "a::4"])
    }

    func testASongThatCannotPlayIsSkippedInTheFollowingOnes() throws {
        var list = tracks()
        list[2] = TestSupport.track("a::3", state: "no_source", version: nil, bytes: nil, title: "Tre", artist: "A")
        let queue = try XCTUnwrap(SearchPlayback.queue(choice: .search("a"), tracks: list, tapped: "a::1", isLocal: none))
        XCTAssertEqual(queue.items.map(\.songKey), ["a::1", "a::2", "a::4"])
    }

    // MARK: the whole list

    func testRiproduciIsTheWholeListInOrderAndCasualeMixesIt() throws {
        let whole = try XCTUnwrap(SearchPlayback.queue(choice: .artist("A"), tracks: tracks(), shuffled: false, isLocal: none))
        XCTAssertEqual(whole.items.map(\.songKey), ["a::1", "a::2", "a::3", "a::4"])
        XCTAssertEqual(whole.label, "Autore · A")

        var generator = SeededGenerator(seed: 7)
        let mixed = try XCTUnwrap(
            LibraryQueueBuilder.make(choice: .artist("A"), tracks: tracks(), shuffled: true, using: &generator, isLocal: none)
        )
        XCTAssertEqual(Set(mixed.items.map(\.songKey)), Set(whole.items.map(\.songKey)), "the same songs, in another order")

        let shuffled = try XCTUnwrap(SearchPlayback.queue(choice: .artist("A"), tracks: tracks(), shuffled: true, isLocal: none))
        XCTAssertEqual(shuffled.items.count, 4)
        XCTAssertNil(SearchPlayback.queue(choice: .artist("A"), tracks: [], shuffled: false, isLocal: none))
    }

    // MARK: what «In coda» calls it

    func testAnAlbumPageIsAnAlbumAnArtistPageAnArtistAndTheRestASearch() {
        XCTAssertEqual(SearchPlayback.choice(text: "ignored", artist: "Bassi Maestro", album: "Classe 73"), .album("Classe 73"))
        XCTAssertEqual(SearchPlayback.choice(text: "ignored", artist: " Bassi Maestro ", album: "  "), .artist("Bassi Maestro"))
        XCTAssertEqual(SearchPlayback.choice(text: "bassi maestro", artist: "", album: ""), .search("bassi maestro"))
        XCTAssertEqual(SearchPlayback.choice(text: "bassi maestro", artist: "", album: "").label, "Ricerca · «bassi maestro»")
    }
}

/// «Aggiungi in coda»
final class QueueAppendTests: XCTestCase {
    private func item(_ key: String) -> QueueItem { QueueItem(track: TestSupport.track(key)) }
    private let none: (String) -> Bool = { _ in false }

    func testASongGoesAfterTheOnesAlreadyQueued() {
        let result = QueueAppend.merge(existing: [item("a"), item("b")], adding: [TestSupport.track("c")], isLocal: none)
        XCTAssertEqual(result.queue.map(\.songKey), ["a", "b", "c"])
        XCTAssertEqual(result.outcome, .added(1))
        XCTAssertEqual(result.added, 1)
        XCTAssertEqual(result.outcome.message, "Aggiunto in coda")
    }

    func testASongAlreadyInTheQueueStaysWhereItIsAndIsNotAddedTwice() {
        let result = QueueAppend.merge(existing: [item("a"), item("b")], adding: [TestSupport.track("a")], isLocal: none)
        XCTAssertEqual(result.queue.map(\.songKey), ["a", "b"])
        XCTAssertEqual(result.outcome, .alreadyQueued)
        XCTAssertEqual(result.added, 0)
        XCTAssertEqual(result.outcome.message, "È già in coda")
    }

    func testSeveralSongsCountOnlyTheOnesReallyAdded() {
        let adding = [TestSupport.track("a"), TestSupport.track("c"), TestSupport.track("c"), TestSupport.track("d")]
        let result = QueueAppend.merge(existing: [item("a")], adding: adding, isLocal: none)
        XCTAssertEqual(result.queue.map(\.songKey), ["a", "c", "d"])
        XCTAssertEqual(result.outcome, .added(2))
        XCTAssertEqual(result.outcome.message, "Aggiunti in coda: 2 brani")
    }

    func testASongThatCannotPlayIsNotQueuedUnlessItIsOnThePhone() {
        let broken = TestSupport.track("x", state: "no_source", version: nil, bytes: nil)
        let refused = QueueAppend.merge(existing: [item("a")], adding: [broken], isLocal: none)
        XCTAssertEqual(refused.queue.map(\.songKey), ["a"])
        XCTAssertEqual(refused.outcome, .notPlayable)
        XCTAssertTrue(refused.outcome.message.contains("nessuna sorgente"))

        let local = QueueAppend.merge(existing: [item("a")], adding: [broken], isLocal: { $0 == "x" })
        XCTAssertEqual(local.queue.map(\.songKey), ["a", "x"])
    }

    func testAnEmptyQueueTakesTheSongs() {
        let result = QueueAppend.merge(existing: [], adding: [TestSupport.track("a"), TestSupport.track("b")], isLocal: none)
        XCTAssertEqual(result.queue.map(\.songKey), ["a", "b"])
        XCTAssertEqual(result.added, 2)
    }
}

/// «Ricerche recenti»
final class RecentSearchesTests: XCTestCase {
    func testTheNewestIsFirstAndASearchIsRememberedOnce() {
        var recent = RecentSearches()
        recent.record("bassi maestro")
        recent.record("daft punk")
        recent.record("  Bassi   Maestro!  ")      // the same words, another spelling: moves to the front, replaces
        XCTAssertEqual(recent.items, ["Bassi   Maestro!", "daft punk"])
    }

    func testAccentsAndCaseDoNotMakeTwoSearches() {
        var recent = RecentSearches()
        recent.record("Mia maestà")
        recent.record("MIA MAESTA")
        XCTAssertEqual(recent.items, ["MIA MAESTA"])
    }

    func testBlankAndSingleLetterAreNotRemembered() {
        var recent = RecentSearches()
        recent.record("")
        recent.record("   ")
        recent.record("a")
        recent.record("!!")
        XCTAssertTrue(recent.isEmpty)
        recent.record("ab")
        XCTAssertEqual(recent.items, ["ab"])
    }

    func testOnlyTheLastTenAreKept() {
        var recent = RecentSearches()
        for n in 1...15 { recent.record("search \(n)") }
        XCTAssertEqual(recent.items.count, RecentSearches.maxCount)
        XCTAssertEqual(recent.items.first, "search 15")
        XCTAssertEqual(recent.items.last, "search 6")
    }

    func testOneCanBeRemovedAndAllCanBeCleared() {
        var recent = RecentSearches(items: ["uno", "due", "tre"])
        recent.remove("DUE")
        XCTAssertEqual(recent.items, ["uno", "tre"])
        recent.clear()
        XCTAssertTrue(recent.isEmpty)
    }

    func testBuildingFromAListKeepsItsOrderAndTheRules() {
        XCTAssertEqual(RecentSearches(items: ["uno", "due", "UNO", "x"]).items, ["uno", "due"], "the newest spelling wins; a single letter is dropped")
        XCTAssertEqual(RecentSearches(items: (1...20).map { "search \($0)" }).items.count, RecentSearches.maxCount)
        XCTAssertEqual(RecentSearches(items: (1...20).map { "search \($0)" }).items.first, "search 1", "a stored list is newest first already")
    }

    func testTheyLiveOnThePhoneInTheirOwnDefaults() throws {
        let suite = "mondrop-recent-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        let store = RecentSearchesStore(defaults: defaults)
        XCTAssertTrue(store.load().isEmpty)
        var recent = store.load()
        recent.record("bassi maestro")
        recent.record("kavinsky")
        store.save(recent)
        XCTAssertEqual(RecentSearchesStore(defaults: defaults).load().items, ["kavinsky", "bassi maestro"])
    }
}

/// «Aggiungi a playlist»
@MainActor
final class PlaylistPickerTests: XCTestCase {
    private final class FakePicker: PlaylistPickerTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var _playlists: [MondropPlaylist]
        private var _listFailure: Error?
        private var _addFailure: Error?
        private var _added: [(String, String)] = []

        init(playlists: [MondropPlaylist]) { _playlists = playlists }

        func failList(_ error: Error?) { lock.withLock { _listFailure = error } }
        func failAdd(_ error: Error?) { lock.withLock { _addFailure = error } }
        var added: [(songKey: String, playlist: String)] { lock.withLock { _added.map { ($0.0, $0.1) } } }

        func listPlaylists() async throws -> [MondropPlaylist] {
            let (list, failure) = lock.withLock { (_playlists, _listFailure) }
            if let failure { throw failure }
            return list
        }

        func addSong(songKey: String, toPlaylist id: String) async throws -> PlaylistAddAck {
            let failure = lock.withLock { () -> Error? in
                _added.append((songKey, id))
                return _addFailure
            }
            if let failure { throw failure }
            return PlaylistAddAck(playlistId: id, name: "Server name", songs: 1)
        }
    }

    private let mine = MondropPlaylist(id: "p1", name: "Rap", songCount: 3, kind: "static", canEdit: true)
    private let shared = MondropPlaylist(id: "p2", name: "Di Sara", songCount: 9, kind: "static", canEdit: false)
    private let dynamic = MondropPlaylist(id: "p3", name: "Più ascoltate", songCount: 5, kind: "dynamic", canEdit: false)
    private let older = MondropPlaylist(id: "p4", name: "Vecchia", songCount: 1)

    func testOnlyTheUsersOwnStaticPlaylistsAreOffered() async {
        let model = PlaylistPickerModel(api: FakePicker(playlists: [mine, shared, dynamic, older]), songKey: "a::b")
        await model.load()
        XCTAssertEqual(model.playlists.map(\.id), ["p1"], "an older backend does not say canEdit: better no choice than a refused one")
        XCTAssertEqual(model.phase, .ready)
    }

    func testAddingPutsTheSongInThePlaylistAndSaysSo() async {
        let api = FakePicker(playlists: [mine])
        let model = PlaylistPickerModel(api: api, songKey: "bassi maestro::capirai")
        await model.load()
        let done = await model.add(to: mine)
        XCTAssertTrue(done)
        XCTAssertEqual(api.added.map { $0.songKey }, ["bassi maestro::capirai"])
        XCTAssertEqual(api.added.map { $0.playlist }, ["p1"])
        XCTAssertEqual(model.phase, .added("Aggiunto a «Server name»"))
    }

    func testTheNameShownIsTheOneWeKnowWhenTheServerSendsNone() async {
        let model = PlaylistPickerModel(api: FakeSilentPicker(), songKey: "a::b")
        _ = await model.add(to: mine)
        XCTAssertEqual(model.phase, .added("Aggiunto a «Rap»"))
    }

    func testTheRefusalsOfTheServerAreSaidInPlainWords() async {
        let api = FakePicker(playlists: [mine])
        let model = PlaylistPickerModel(api: api, songKey: "a::b")

        api.failAdd(MondropAPIError.http(404, #"{"error":"playlist not found"}"#))
        let notMine = await model.add(to: mine)
        XCTAssertFalse(notMine)
        XCTAssertEqual(model.phase, .failed("Questa playlist non è tua o non esiste più: aggiorna l'elenco."))

        api.failAdd(MondropAPIError.http(404, #"{"error":"song not found"}"#))
        _ = await model.add(to: mine)
        XCTAssertEqual(model.phase, .failed("Il server non conosce questo brano."))

        api.failAdd(MondropAPIError.http(409, #"{"error":"playlist_is_dynamic"}"#))
        _ = await model.add(to: mine)
        XCTAssertEqual(model.phase, .failed("Questa playlist è dinamica: la decide una regola, non si aggiungono brani a mano."))

        api.failAdd(MondropAPIError.transport("Internet offline"))
        _ = await model.add(to: mine)
        XCTAssertEqual(model.phase, .failed("Internet offline"))
    }

    func testAListThatCannotBeLoadedSaysWhy() async {
        let api = FakePicker(playlists: [mine])
        api.failList(MondropAPIError.transport("timeout"))
        let model = PlaylistPickerModel(api: api, songKey: "a::b")
        await model.load()
        XCTAssertEqual(model.playlists.count, 0)
        XCTAssertEqual(model.phase, .failed("timeout"))
    }

    func testACancelledAddIsNotAnError() async {
        let api = FakePicker(playlists: [mine])
        api.failAdd(CancellationError())
        let model = PlaylistPickerModel(api: api, songKey: "a::b")
        let done = await model.add(to: mine)
        XCTAssertFalse(done)
        XCTAssertEqual(model.phase, .ready)
    }
}

/// An acknowledgement with no name in it.
private final class FakeSilentPicker: PlaylistPickerTransport, @unchecked Sendable {
    func listPlaylists() async throws -> [MondropPlaylist] { [] }
    func addSong(songKey: String, toPlaylist id: String) async throws -> PlaylistAddAck {
        PlaylistAddAck(playlistId: id, name: "", songs: 0)
    }
}
