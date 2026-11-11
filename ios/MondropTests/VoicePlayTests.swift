import XCTest
@testable import Mondrop

/// Choosing from the car by voice (spec 2026-11-10-mondrop-like-and-repeat-design.md L10; Michele: «manca la lista canzoni o playlist», «1»):
/// the Tesla shows no list over Bluetooth, so «metti la playlist X su Mondrop» and «metti un brano su Mondrop» are how he picks. What is
/// matched, said and started is plain code, tested here without a network; Siri itself is not testable on a simulator.

// MARK: - A spoken name, matched to the playlists

final class PlaylistMatcherTests: XCTestCase {
    private let lists = [
        KnownPlaylist(id: "1", name: "Road trip"),
        KnownPlaylist(id: "2", name: "Jazz da ascoltare"),
        KnownPlaylist(id: "3", name: "Jazz anni 60"),
        KnownPlaylist(id: "4", name: "Più ascoltate"),
        KnownPlaylist(id: "5", name: "Anni '80"),
        KnownPlaylist(id: "6", name: "Rap"),
        KnownPlaylist(id: "7", name: "Rap italiano"),
        KnownPlaylist(id: "8", name: "Rockabilly"),
    ]

    private func ids(_ spoken: String, in list: [KnownPlaylist]? = nil) -> [String] {
        PlaylistMatcher.candidates(for: spoken, in: list ?? lists).map(\.id)
    }

    func testTheNameAsItIsWrittenIsOneNameWhateverTheCase() {
        XCTAssertEqual(ids("Road trip"), ["1"])
        XCTAssertEqual(ids("ROAD TRIP"), ["1"])
        XCTAssertEqual(ids("  road   trip "), ["1"], "spaces do not count")
    }

    func testAccentsAndPunctuationDoNotCount() {
        XCTAssertEqual(ids("piu ascoltate"), ["4"])
        XCTAssertEqual(ids("PIÙ ASCOLTATE"), ["4"])
        XCTAssertEqual(ids("anni 80"), ["5"], "Siri hears «anni ottanta» as words and digits, never the apostrophe")
        XCTAssertEqual(ids("Anni ’80"), ["5"])
    }

    func testTheWordsInAnyOrderAreTheName() {
        XCTAssertEqual(ids("trip road"), ["1"])
        XCTAssertEqual(ids("ascoltare jazz"), ["2"])
    }

    func testAPartOfTheNameIsEnoughWhenItIsOnlyOne() {
        XCTAssertEqual(ids("jazz da"), ["2"], "the beginning")
        XCTAssertEqual(ids("ascoltare"), ["2"], "a whole word of the name")
        XCTAssertEqual(ids("road tri"), ["1"], "the beginning of the last word")
        XCTAssertEqual(ids("rock"), ["8"], "the beginning of a word")
    }

    func testAnExactNameBeatsTheOnesThatOnlyStartWithIt() {
        XCTAssertEqual(ids("rap"), ["6"], "«Rap» is «Rap», not «Rap italiano»: no question asked")
        XCTAssertEqual(ids("rap italiano"), ["7"])
    }

    func testWhenTwoNamesFitEquallySiriGetsBothAndAsks() {
        XCTAssertEqual(ids("jazz"), ["3", "2"], "«Jazz anni 60» and «Jazz da ascoltare», in the order of their names")
        let twins = [KnownPlaylist(id: "a", name: "Estate"), KnownPlaylist(id: "b", name: "Estate")]
        XCTAssertEqual(ids("estate", in: twins), ["a", "b"], "the same name twice is a question too")
    }

    func testWhatFitsNothingFindsNothing() {
        XCTAssertEqual(ids("metal"), [])
        XCTAssertEqual(ids(""), [])
        XCTAssertEqual(ids("   "), [])
        XCTAssertEqual(ids("???"), [])
        XCTAssertEqual(ids("road", in: []), [])
    }

    func testTheNormalFormIsPlainLowerCaseWords() {
        XCTAssertEqual(PlaylistMatcher.normalize("  Più   Ascoltate! "), "piu ascoltate")
        XCTAssertEqual(PlaylistMatcher.normalize("Anni '80"), "anni 80")
        XCTAssertEqual(PlaylistMatcher.normalize("ÀÈÌÒÙ"), "aeiou")
    }
}

// MARK: - The names Siri learns

final class PlaylistCatalogTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = try TestSupport.tempDir("siri-playlists")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: dir)
    }

    private func catalog() -> PlaylistCatalog { PlaylistCatalog(url: dir.appendingPathComponent("siri-playlists.json")) }

    private func playlist(_ id: String, _ name: String, kind: String? = nil, canEdit: Bool? = nil, origin: String? = nil) -> MondropPlaylist {
        MondropPlaylist(id: id, name: name, songCount: 3, kind: kind, canEdit: canEdit, origin: origin)
    }

    func testEveryPlaylistTheAppKnowsIsKeptTheDynamicAndTheAutomaticOnesToo() {
        let c = catalog()
        let changed = c.remember(
            [playlist("a", "Road trip", kind: "static", canEdit: true), playlist("b", "Più ascoltate", kind: "dynamic"), playlist("c", "Jazz da ascoltare", origin: "auto"), playlist("d", "Di Sara", canEdit: false)],
            user: "mike"
        )
        XCTAssertTrue(changed)
        XCTAssertEqual(Set(c.playlists(forUser: "mike").map(\.name)), ["Road trip", "Più ascoltate", "Jazz da ascoltare", "Di Sara"], "not only the ones the share sheet offers")
    }

    func testTheSameNamesAgainChangeNothingAndTellNobody() {
        let c = catalog()
        let told = ToldCounter()
        c.onChange = { told.bump() }
        XCTAssertTrue(c.remember([playlist("a", "Road trip")], user: "mike"))
        XCTAssertEqual(told.count, 1, "Siri is asked to learn the names")
        XCTAssertFalse(c.remember([playlist("a", "Road trip")], user: "mike"))
        XCTAssertEqual(told.count, 1, "nothing changed: Siri is not asked again")
        XCTAssertTrue(c.remember([playlist("a", "Road trip"), playlist("b", "Jazz")], user: "mike"))
        XCTAssertEqual(told.count, 2, "a new playlist")
        XCTAssertTrue(c.remember([playlist("a", "Viaggio"), playlist("b", "Jazz")], user: "mike"), "a renamed one")
        XCTAssertEqual(told.count, 3)
        XCTAssertTrue(c.remember([playlist("b", "Jazz")], user: "mike"), "a deleted one")
        XCTAssertEqual(told.count, 4)
    }

    func testTheOrderTheServerSendsThemInIsNotAChange() {
        let c = catalog()
        c.remember([playlist("a", "A"), playlist("b", "B")], user: "mike")
        XCTAssertFalse(c.remember([playlist("b", "B"), playlist("a", "A")], user: "mike"))
    }

    func testItIsKeptOnTheDiskForTheIntentThatRunsInAnotherMoment() {
        catalog().remember([playlist("a", "Road trip")], user: "mike")
        XCTAssertEqual(catalog().playlists(forUser: "mike"), [KnownPlaylist(id: "a", name: "Road trip")])
    }

    func testAnotherPersonNeverHearsThePlaylistsOfTheFirst() {
        let c = catalog()
        c.remember([playlist("a", "Road trip")], user: "mike")
        XCTAssertEqual(c.playlists(forUser: "sara"), [])
        XCTAssertEqual(c.playlists(forUser: " MIKE "), [KnownPlaylist(id: "a", name: "Road trip")], "case and spaces of the name do not matter")
    }

    func testAFileThatCannotBeReadIsAnEmptyCatalog() throws {
        try Data("not json".utf8).write(to: dir.appendingPathComponent("siri-playlists.json"))
        XCTAssertEqual(catalog().playlists(forUser: "mike"), [])
    }

    func testItCanBeForgotten() {
        let c = catalog()
        c.remember([playlist("a", "Road trip")], user: "mike")
        c.clear()
        XCTAssertEqual(catalog().playlists(forUser: "mike"), [])
    }

    func testAPlaylistWithoutANameIsNotKept() {
        let c = catalog()
        c.remember([playlist("a", "  "), playlist("b", "Jazz")], user: "mike")
        XCTAssertEqual(c.playlists(forUser: "mike").map(\.id), ["b"], "Siri cannot be asked for a name nobody can say")
    }
}

final class ToldCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    var count: Int { lock.withLock { n } }
    func bump() { lock.withLock { n += 1 } }
}

// MARK: - What Siri says

final class VoicePlayOutcomeTests: XCTestCase {
    func testWhatSiriSaysIsShortAndItalian() {
        XCTAssertEqual(VoicePlayOutcome.playlistStarted(name: "Road trip").spoken, "Metto la playlist «Road trip».")
        XCTAssertEqual(VoicePlayOutcome.playlistNotFound.spoken, "Non trovo nessuna playlist che si chiama così.")
        XCTAssertEqual(VoicePlayOutcome.playlistEmpty(name: "Road trip").spoken, "La playlist «Road trip» non ha brani da ascoltare.")
        XCTAssertEqual(VoicePlayOutcome.playlistUnreachable(name: "Road trip").spoken, "Non riesco a leggere la playlist «Road trip»: il server non risponde.")
        XCTAssertEqual(VoicePlayOutcome.songStarted(title: "Billie Jean", artist: "Michael Jackson").spoken, "Metto «Billie Jean» di Michael Jackson.")
        XCTAssertEqual(VoicePlayOutcome.songStarted(title: "Africa", artist: "").spoken, "Metto «Africa».", "a song with no artist is not «di »")
        XCTAssertEqual(VoicePlayOutcome.songNotFound.spoken, "Non ho trovato niente.")
        XCTAssertEqual(VoicePlayOutcome.nothingAsked.spoken, "Non ho capito che brano vuoi.")
    }

    func testTheRequestsAreWrittenDownInTheListOfTheSettings() {
        XCTAssertEqual(VoicePlayRequest.playlist("Road trip").logName, "Siri: playlist Road trip")
        XCTAssertEqual(VoicePlayRequest.song("billie jean").logName, "Siri: brano billie jean")
        XCTAssertEqual(VoicePlayRequest.song("  billie jean \n").logName, "Siri: brano billie jean", "trimmed")
    }
}

// MARK: - Starting what was asked, the way the app does

@MainActor
final class VoicePlayActionsTests: XCTestCase {
    private var dir: URL!
    private var defaults: UserDefaults!
    private var suite = ""

    override func setUpWithError() throws {
        continueAfterFailure = false
        dir = try TestSupport.tempDir("voice-play")
        suite = "mondrop.test.voiceplay.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    private struct Rig {
        let player: LocalAudioPlayer
        let store: OfflineStore
        let log: RemoteCommandLog
        let started: StartedQueues
    }

    final class StartedQueues {
        var queues: [PlayQueue] = []
    }

    private func make() -> Rig {
        let offline = OfflineStore(root: dir.appendingPathComponent("offline"))
        let log = RemoteCommandLog(defaults: defaults, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        let player = LocalAudioPlayer(
            store: offline, api: FakeAPI(),
            recorder: PlayRecorder(queue: EventQueue(directory: dir.appendingPathComponent("events")), store: offline, uploader: nil, journal: MemoryJournal()),
            snapshots: QueueSnapshotStore(directory: dir, defaults: defaults, positionKey: "position"),
            lyricsLoader: LyricsLoader(transport: FakeLyricsTransport([.success(nil)]), directory: dir.appendingPathComponent("lyrics")),
            repeatStore: MemoryRepeatModeStore(),
            likes: LikesStore(directory: dir.appendingPathComponent("likes"), transport: FakeLikesTransport(), currentUser: { "mike" }, clock: SleepLog().clock, autoFlush: false),
            commandLog: log
        )
        return Rig(player: player, store: offline, log: log, started: StartedQueues())
    }

    private func installLocal(_ rig: Rig, _ key: String) throws {
        let staged = rig.store.stagingURL()
        try Data(repeating: 1, count: 100).write(to: staged)
        _ = try rig.store.install(stagedFile: staged, songKey: key, metadata: InstallMetadata(title: key, artist: "X", version: "1-1"))
    }

    // MARK: a playlist

    func testAPlaylistStartsAsTheQueueOfThePlaylistLikeATapOnIt() async {
        let rig = make()
        let api = FakeAPI()
        api.scriptManifests("pl1", [.success(TestSupport.manifest("pl1", [TestSupport.track("a::one"), TestSupport.track("b::two"), TestSupport.track("c::three")]))])
        let spoken = await VoiceActions.playPlaylist(id: "pl1", name: "Road trip", api: api, store: rig.store, player: rig.player) { rig.started.queues.append($0) }
        XCTAssertEqual(spoken, "Metto la playlist «Road trip».")
        let queue = try! XCTUnwrap(rig.started.queues.first)
        XCTAssertEqual(queue.items.map(\.songKey), ["a::one", "b::two", "c::three"])
        XCTAssertEqual(queue.startIndex, 0)
        XCTAssertEqual(queue.label, "Playlist · Road trip", "the label the builder gives, as when the playlist is tapped (the name of the list Siri matched)")
        XCTAssertEqual(queue.playlistId, "pl1", "the listens are credited to the playlist")
        XCTAssertEqual(rig.log.entries.first?.name, "Siri: playlist Road trip")
    }

    func testASongTheServerFoundNoSourceForIsLeftOutUnlessItIsAlreadyOnThePhone() async throws {
        let rig = make()
        try installLocal(rig, "b::on the phone")
        let api = FakeAPI()
        api.scriptManifests("pl1", [.success(TestSupport.manifest("pl1", [
            TestSupport.track("a::ready"),
            TestSupport.track("b::on the phone", state: "no_source"),
            TestSupport.track("c::nowhere", state: "no_source"),
        ]))])
        _ = await VoiceActions.playPlaylist(id: "pl1", name: "X", api: api, store: rig.store, player: rig.player) { rig.started.queues.append($0) }
        XCTAssertEqual(rig.started.queues.first?.items.map(\.songKey), ["b::on the phone", "a::ready"], "the file on the phone is played whatever the server says, and first")
    }

    func testTheSongsOnThePhoneComeBeforeTheOnesThatAreOnlyOnline() async throws {
        // «Vanno privilegiati i file già scaricati» (Michele, 11 November; spec ...-simplify-playlists-and-song-states-design.md U10): there is no screen to show an order,
        // so the queue Siri starts has the songs on the phone first and the playlist's own order inside each group
        let rig = make()
        try installLocal(rig, "c::three")
        try installLocal(rig, "e::five")
        let api = FakeAPI()
        api.scriptManifests("pl1", [.success(TestSupport.manifest("pl1", ["a::one", "b::two", "c::three", "d::four", "e::five"].map { TestSupport.track($0) }))])
        _ = await VoiceActions.playPlaylist(id: "pl1", name: "Road trip", api: api, store: rig.store, player: rig.player) { rig.started.queues.append($0) }
        XCTAssertEqual(rig.started.queues.first?.items.map(\.songKey), ["c::three", "e::five", "a::one", "b::two", "d::four"])
        XCTAssertEqual(rig.started.queues.first?.playlistId, "pl1")
    }

    func testAPlaylistWithNothingToPlayIsSaidSoAndNothingStarts() async {
        let rig = make()
        let api = FakeAPI()
        api.scriptManifests("pl1", [.success(TestSupport.manifest("pl1", []))])
        let spoken = await VoiceActions.playPlaylist(id: "pl1", name: "Vuota", api: api, store: rig.store, player: rig.player) { rig.started.queues.append($0) }
        XCTAssertEqual(spoken, "La playlist «Vuota» non ha brani da ascoltare.")
        XCTAssertTrue(rig.started.queues.isEmpty)
    }

    func testAServerThatDoesNotAnswerIsSaidSoAndNothingStarts() async {
        let rig = make()
        let api = FakeAPI()
        api.scriptManifests("pl1", [.failure(MondropAPIError.transport("offline"))])
        let spoken = await VoiceActions.playPlaylist(id: "pl1", name: "Road trip", api: api, store: rig.store, player: rig.player) { rig.started.queues.append($0) }
        XCTAssertEqual(spoken, "Non riesco a leggere la playlist «Road trip»: il server non risponde.")
        XCTAssertTrue(rig.started.queues.isEmpty)
        XCTAssertEqual(rig.log.entries.first?.name, "Siri: playlist Road trip", "it arrived: it is written down whatever came of it")
    }

    // MARK: a song

    private func page(_ tracks: [OfflineTrack]) -> SearchPage { SearchPage(tracks: tracks, total: tracks.count) }

    func testASongIsSearchedLikeInCercaAndTheBestMatchStartsWithTheFollowingOnesAfterIt() async {
        let rig = make()
        let transport = FakeSearch()
        let found = page([
            TestSupport.track("michael jackson::billie jean", title: "Billie Jean", artist: "Michael Jackson"),
            TestSupport.track("michael jackson::beat it", title: "Beat It", artist: "Michael Jackson"),
            TestSupport.track("michael jackson::thriller", title: "Thriller", artist: "Michael Jackson"),
        ])
        transport.script { _ in found }
        let spoken = await VoiceActions.playSong(spoken: "billie jean", transport: transport, store: rig.store, player: rig.player) { rig.started.queues.append($0) }
        XCTAssertEqual(spoken, "Metto «Billie Jean» di Michael Jackson.")
        let queue = try! XCTUnwrap(rig.started.queues.first)
        XCTAssertEqual(queue.items.map(\.songKey), ["michael jackson::billie jean", "michael jackson::beat it", "michael jackson::thriller"], "this song and the ones that follow it in the list: a tap in Cerca")
        XCTAssertEqual(queue.label, "Ricerca · «billie jean»")
        XCTAssertNil(queue.playlistId)
        XCTAssertEqual(transport.queries.first?.text, "billie jean", "the words the person said go to SoundReel's search and nowhere else")
        XCTAssertEqual(rig.log.entries.first?.name, "Siri: brano billie jean")
    }

    func testTheFirstMatchThatCannotPlayIsSkippedForTheNextOne() async {
        let rig = make()
        let transport = FakeSearch()
        let found = page([
            TestSupport.track("a::nosource", state: "no_source", title: "Senza sorgente", artist: "A"),
            TestSupport.track("b::playable", title: "Si ascolta", artist: "B"),
        ])
        transport.script { _ in found }
        let spoken = await VoiceActions.playSong(spoken: "brano", transport: transport, store: rig.store, player: rig.player) { rig.started.queues.append($0) }
        XCTAssertEqual(spoken, "Metto «Si ascolta» di B.")
        XCTAssertEqual(rig.started.queues.first?.items.map(\.songKey), ["b::playable"])
    }

    func testAMatchThePhoneAlreadyHoldsPlaysWhateverTheServerSaysOfItsSource() async throws {
        let rig = make()
        try installLocal(rig, "a::on the phone")
        let transport = FakeSearch()
        let found = page([
            TestSupport.track("a::on the phone", state: "no_source", title: "Sul telefono", artist: "A"),
            TestSupport.track("b::playable", title: "Si ascolta", artist: "B"),
        ])
        transport.script { _ in found }
        let spoken = await VoiceActions.playSong(spoken: "sul telefono", transport: transport, store: rig.store, player: rig.player) { rig.started.queues.append($0) }
        XCTAssertEqual(spoken, "Metto «Sul telefono» di A.", "the file on the phone is a source: the same rule as the playlist and as a tap in Cerca")
        XCTAssertEqual(rig.started.queues.first?.items.map(\.songKey), ["a::on the phone", "b::playable"])
    }

    func testNothingFoundIsSaidSoAndNothingStarts() async {
        let rig = make()
        let transport = FakeSearch()
        let found = page([])
        transport.script { _ in found }
        let spoken = await VoiceActions.playSong(spoken: "xyzzy", transport: transport, store: rig.store, player: rig.player) { rig.started.queues.append($0) }
        XCTAssertEqual(spoken, "Non ho trovato niente.")
        XCTAssertTrue(rig.started.queues.isEmpty)
    }

    func testAnEmptyAnswerAsksNothingOfTheServer() async {
        let rig = make()
        let transport = FakeSearch()
        let spoken = await VoiceActions.playSong(spoken: "   ", transport: transport, store: rig.store, player: rig.player) { rig.started.queues.append($0) }
        XCTAssertEqual(spoken, "Non ho capito che brano vuoi.")
        XCTAssertTrue(transport.queries.isEmpty, "the server refuses a search with nothing to look for")
        XCTAssertTrue(rig.started.queues.isEmpty)
    }

    func testWithoutTheServerTheSongsOnThePhoneAnswerLikeCercaDoes() async throws {
        let rig = make()
        try installLocal(rig, "toto::africa")
        let transport = FakeSearch()
        transport.fail(MondropAPIError.transport("offline"))
        let spoken = await VoiceActions.playSong(spoken: "africa", transport: transport, store: rig.store, player: rig.player) { rig.started.queues.append($0) }
        XCTAssertTrue(spoken.hasPrefix("Metto «"), spoken)
        XCTAssertEqual(rig.started.queues.first?.items.first?.songKey, "toto::africa", "in a tunnel the search falls back to the songs on the phone: the same fallback as the screen")
    }

    // MARK: the one way to start

    func testTheQueueStartsThroughThePlayersOwnEntryPoint() throws {
        let rig = make()
        let queue = PlayQueue(
            items: [QueueItem(songKey: "a::one", title: "One", artist: "A"), QueueItem(songKey: "b::two", title: "Two", artist: "B")],
            startIndex: 1, label: "Playlist · X", playlistId: "pl1"
        )
        rig.player.start(queue)
        XCTAssertEqual(rig.player.queue.map(\.songKey), ["a::one", "b::two"])
        XCTAssertEqual(rig.player.index, 1)
        XCTAssertEqual(rig.player.queueLabel, "Playlist · X")
        XCTAssertEqual(rig.player.queuePlaylistId, "pl1")
    }
}
