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

    // MARK: U3 — three states inside a playlist, the old marks everywhere else

    func testOnlyTheRowsOfAPlaylistShowTheThreeStates() throws {
        var users: [String] = []
        for file in try appFiles() where try code(file).contains("marks: .playlist") { users.append(file) }
        XCTAssertEqual(users, ["Mondrop/PlaylistsView.swift"], "the page of a playlist; Cerca, the library and the queue keep the marks they had")
        let rows = try code("Mondrop/SongRows.swift")
        XCTAssertTrue(rows.contains("case .playlist: SongStateMark(state: SongState(status))"))
        XCTAssertTrue(rows.contains("case .detailed: StatusAccessoryView(status: status)"))
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
        for words in ["question.allButtonTitle", "question.limitButtonTitle", "question.cancelButtonTitle", "sync.answer(.all)", "sync.answer(.limit)", "sync.answer(.cancel)"] {
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

    func testOnlyTheSyncOfThePlayingPlaylistBuildsAGatedSync() throws {
        // a gate is what turns «prepare and download» into «prepare, ask over the limit, download»: the «Sync» inside a playlist has none
        var users: [String] = []
        for file in try appFiles() + (try kitFiles()) where try code(file).contains("gate: gate") { users.append(file) }
        XCTAssertEqual(users, ["MondropKit/PlayingPlaylistSync.swift"])
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
