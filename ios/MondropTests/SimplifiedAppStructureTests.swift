import XCTest
@testable import Mondrop

/// The shape of the screens after the request of 10 November (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md): read from the SOURCES,
/// like `RulePTests` and `HomeStructureTests`, because these are decisions about how the screens are put together. A plain text scan of the code
/// (line comments left out): a comment that explains a rule has to say it in other words.
final class SimplifiedAppStructureTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    private func code(_ relative: String) throws -> String {
        let text = try String(contentsOf: iosRoot.appendingPathComponent(relative), encoding: .utf8)
        return text.components(separatedBy: "\n").map { $0.components(separatedBy: "//")[0] }.joined(separator: "\n")
    }

    private func count(_ needle: String, in text: String) -> Int { text.components(separatedBy: needle).count - 1 }

    private func kitFiles() throws -> [String] {
        let dir = iosRoot.appendingPathComponent("MondropKit")
        let found = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []
        return found.filter { $0.pathExtension == "swift" }.map { "MondropKit/" + $0.lastPathComponent }.sorted()
    }

    private func appFiles() throws -> [String] {
        let dir = iosRoot.appendingPathComponent("Mondrop")
        let found = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []
        return found.filter { $0.pathExtension == "swift" }.map { "Mondrop/" + $0.lastPathComponent }.sorted()
    }

    // MARK: U3, U14 — the three states on every row of every list of songs

    func testEveryRowOfSongsShowsTheThreeStatesAndThereAreNoOtherMarks() throws {
        // «Non è chiaro dove sono i file ( locali o remoto )» (Michele, 11 November): from build 17 Cerca, the library and the queue show the same three marks the page of a
        // playlist does (before, they kept the eight of old)
        let rows = try code("Mondrop/SongRows.swift")
        XCTAssertTrue(rows.contains("SongStateMark(state: state)"))
        XCTAssertTrue(rows.contains("private var state: SongState { SongState(status) }"))
        for gone in ["StatusAccessoryView", ".detailed", "enum Marks", "marks: .playlist"] {
            for file in try appFiles() {
                XCTAssertFalse(try code(file).contains(gone), "\(file): «\(gone)» — one set of marks for every list of songs")
            }
        }
    }

    func testTheMarksAreDrawnWithTheColoursOfThePalette() throws {
        let marks = try code("Mondrop/StateMarks.swift")
        XCTAssertTrue(marks.contains("MondropPalette.accent"))
        XCTAssertTrue(marks.contains("MondropPalette.error"))
        for banned in [".green", ".red", ".blue", ".orange", "Color.white", "Color(.system"] {
            XCTAssertFalse(marks.contains(banned), "the app is all dark: «\(banned)» is not a colour of the palette")
        }
    }

    // MARK: U9 — the playlist has its mark too

    func testThePlaylistMarkIsOnTheCardsOfTheHomeTheRowsOfTheListAndTheHeaderOfThePage() throws {
        let home = try code("Mondrop/HomeView.swift")
        XCTAssertTrue(home.contains("PlaylistStateMark(state: state, font: .caption)"))
        XCTAssertTrue(home.contains("marks.state(id: playlist.id, songCount: playlist.songCount)"))
        let playlists = try code("Mondrop/PlaylistsView.swift")
        XCTAssertTrue(playlists.contains("PlaylistRow(playlist: p, state: marks.state(id: p.id, songCount: p.songCount))"))
        XCTAssertTrue(playlists.contains("PlaylistStateSummary(songs:"))
        XCTAssertTrue(playlists.contains("PlaylistStateMark(state: summary.state"))
        XCTAssertTrue(playlists.contains("summary.headerText"), "«12 di 20 sul telefono» in the header of the page, and only there")
        XCTAssertFalse(home.contains("headerText"))
    }

    func testTheListsKeepTheFilesOnThePhoneInsteadOfReadingThemAtEveryDrawing() throws {
        // a download ticks many times a second and each tick draws the lists again: looking at every file of the phone at each tick is wasted work
        for file in ["Mondrop/HomeView.swift", "Mondrop/PlaylistsView.swift"] {
            let text = try code(file)
            XCTAssertTrue(text.contains("PlaylistMarks.current(store: engine.store, local: localKeys, progress: engine.progress)"), file)
            XCTAssertFalse(text.contains("PlaylistMarks.current(store: engine.store, progress:"), "\(file) reads every file at every drawing")
            XCTAssertGreaterThanOrEqual(count("localKeys = engine.store.localSongKeys()", in: text), 2, "\(file) reads them when it appears AND when the phone's files change")
            XCTAssertTrue(text.contains(".onChange(of: engine.revision)"), file)
        }
    }

    // MARK: U6 — the plus button on a song found in Cerca

    func testASongFoundInCercaHasAVisiblePlusButtonBesideTheLongPress() throws {
        let actions = try code("Mondrop/SearchActions.swift")
        XCTAssertTrue(actions.contains("Image(systemName: \"plus.circle\")"))
        XCTAssertTrue(actions.contains(".accessibilityLabel(\"Aggiungi a playlist\")"))
        XCTAssertEqual(count("actions.askPlaylist(for: track)", in: actions), 2, "the «+» and the long press: both open the same list of playlists")
    }

    // MARK: U2 — the sync of the playlist that PLAYS, with its limit

    func testNothingSyncsAtTheFirstAccessNorFromAButtonOfTheFirstPage() throws {
        // «Il sync deve girare solo per playlist che sto suonando. Non di tutti in assoluto.» (Michele, 11 November, build 15)
        for file in try appFiles() + (try kitFiles()) {
            let source = try code(file)
            for gone in ["runFirstSyncIfNeeded", "firstSyncDone", "isFirstSyncDone", "markFirstSyncDone", "LibrarySyncCoordinator", "syncAll("] {
                XCTAssertFalse(source.contains(gone), "\(file): «\(gone)» — no sync of every playlist, at the first access or from a button")
            }
        }
    }

    func testTheSyncFollowsThePlayerAndItsQuestionIsAskedOverTheScreen() throws {
        let app = try code("Mondrop/MondropApp.swift")
        XCTAssertTrue(app.contains("LocalAudioPlayer.sharedPlaybackObserver"), "set at launch, before the player exists: the player is not created for it")
        XCTAssertTrue(app.contains("PlayingPlaylistSync.shared.playbackChanged"))

        let root = try code("Mondrop/RootTabView.swift")
        XCTAssertTrue(root.contains(".syncSizeDialog(playingSync, suppressed: showPlayer)"), "the question waits while the Player covers the screen")

        let host = try code("Mondrop/PlayingSyncHost.swift")
        for words in ["question.allButtonTitle", "question.limitButtonTitle", "question.cancelButtonTitle", "answer(.all)", "answer(.limit)", "answer(.cancel)", "sync.question", "sync.answer($0)"] {
            XCTAssertTrue(host.contains(words), words)
        }
        XCTAssertTrue(host.contains("Settings.shared.syncWarnLimit"), "the limit is the one of the Settings")

        let player = try code("MondropKit/LocalAudioPlayer.swift")
        let declarations = player.components(separatedBy: "\n")
        for property in ["var playing: Bool", "var queuePlaylistId: String?"] {
            let line = try XCTUnwrap(declarations.first { $0.contains(property) }, property)
            XCTAssertTrue(line.contains("reportPlayback()"), "«\(property)» tells the observer when it changes")
        }
        XCTAssertTrue(player.contains("player.observePlayback { context in LocalAudioPlayer.sharedPlaybackObserver?(context) }"), "the shared player, and only it, forwards to the app")
    }

    func testTheDownloadsFollowTheQueueOfThePlayer() throws {
        // «Sync scarica i brani in ordine di stanno per suonare.» (Michele, 11 November, U16): the player says what is about to play, the engine orders what waits
        let app = try code("Mondrop/MondropApp.swift")
        XCTAssertTrue(app.contains("LocalAudioPlayer.sharedUpcomingObserver = { SyncEngine.shared.setUpcoming($0) }"), "set at launch, before the player exists")

        let player = try code("MondropKit/LocalAudioPlayer.swift")
        XCTAssertTrue(player.contains("player.observeUpcoming { LocalAudioPlayer.sharedUpcomingObserver?($0) }"), "the shared player, and only it, forwards to the app")
        let declarations = player.components(separatedBy: "\n")
        for property in ["var inPlay: Bool", "var index: Int", "var queue: [QueueItem]"] {
            let line = try XCTUnwrap(declarations.first { $0.contains(property) }, property)
            XCTAssertTrue(line.contains("reportUpcoming()"), "«\(property)» tells the observer of the order when it changes")
        }

        // every place that decides which songs go down asks the engine for the order they play in
        let sync = try code("MondropKit/PlaylistSync.swift")
        XCTAssertTrue(sync.contains("gate.admit(engine.inPlayOrder(plan.download), in: manifest)"), "the size gate sees the songs in the order they are about to play")
        let check = try code("MondropKit/PlaylistConsistency.swift")
        XCTAssertTrue(check.contains("engine.inPlayOrder(wanted)"), "the check of the Settings too")
    }

    func testTheSettingsSayInWhichOrderTheSongsComeDown() throws {
        let settings = try code("Mondrop/SettingsView.swift")
        XCTAssertTrue(settings.contains("nell'ordine in cui stanno per suonare"))
    }

    func testOnlyThePlayingPlaylistAndTheDownloadAllButtonBuildAGatedSync() throws {
        // a gate is what turns «prepare and download» into «prepare, ask over the limit, download»: the playlist that plays has one, and so has the «Scarica tutta» that the person
        // presses on a playlist (§12, U20: Michele, 11 November, «il bottone 'scarica tutta'»); nothing else asks
        var users: [String] = []
        for file in try appFiles() + (try kitFiles()) where try code(file).contains("gate: gate") { users.append(file) }
        XCTAssertEqual(users.sorted(), ["MondropKit/PlayingPlaylistSync.swift", "MondropKit/PlaylistDownloadAll.swift"])
    }

    func testTheSettingsSayThatTheSyncIsTheOneOfThePlaylistThatPlays() throws {
        let settings = try code("Mondrop/SettingsView.swift")
        XCTAssertTrue(settings.contains("Quando suoni una playlist, Mondrop scarica in background i brani che mancano sul telefono"))
        XCTAssertTrue(settings.contains("annulla: per quella playlist non lo richiede finché non riapri l'app"))
        XCTAssertTrue(settings.contains("Non scarica niente per le playlist che non suoni, né per i brani messi in coda da Cerca"))
        XCTAssertFalse(settings.contains("Al primo accesso"), "nothing downloads at the first access any more")
        XCTAssertFalse(settings.contains("dalla prima pagina, «Sync»"))
        let space = try code("Mondrop/SpaceView.swift")
        XCTAssertFalse(space.contains("Dalla prima pagina"), "the first page has no «Sync» to send the user to")
    }

    func testTheLimitIsAnOptionOfTheSettingsInTheSyncSection() throws {
        let settings = try code("Mondrop/SettingsView.swift")
        XCTAssertTrue(settings.contains("Picker(\"Avvisa sopra\", selection: $syncWarn)"))
        XCTAssertTrue(settings.contains("ForEach(SyncWarnLimit.allCases)"))
        XCTAssertTrue(settings.contains("Settings.shared.syncWarnLimit = newValue"))
    }

    // MARK: rule P — the new code does not look at where the phone is

    func testTheNewCodeNamesNoNetworkAndChoosesNoSource() throws {
        let home = try NSRegularExpression(pattern: "\\bhome\\b", options: [.caseInsensitive])
        for file in ["MondropKit/PlayingPlaylistSync.swift", "MondropKit/PlayingPlaylist.swift", "MondropKit/SyncSizeGuard.swift", "MondropKit/SongState.swift", "MondropKit/PlaylistRemove.swift", "Mondrop/PlayingSyncHost.swift"] {
            let source = try code(file)
            for banned in ["NetStatus", "onExpensivePath", "viaCloudflare", "currentHome", "192.168."] {
                XCTAssertFalse(source.contains(banned), "\(file): «\(banned)» — the warning is the same wherever the phone is")
            }
            XCTAssertNil(home.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)), "\(file): the word «home» does not belong in code that moves files")
        }
        let tests = ["MondropTests/PlayingPlaylistSyncTests.swift", "MondropTests/PlayingSyncGateTests.swift", "MondropTests/PlaylistSyncTriggerTests.swift", "MondropTests/PlaybackContextTests.swift", "MondropTests/SyncSizeGuardTests.swift", "MondropTests/SongStateTests.swift"]
        for file in tests {
            let source = try code(file)
            XCTAssertNil(home.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)), "\(file)")
        }
    }
}
