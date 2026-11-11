import XCTest
@testable import Mondrop

/// The shape of the screens after the request of 11 November, trying build 16 (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U10–U15): what is on the
/// phone comes first, the page of a playlist is the list and «Suona», no sync is in sight except the check in the Settings, the mini player is there only while something is in play
/// and says where the file is. Read from the SOURCES, like `HomeStructureTests`: these are decisions about how the screens are put together, which a unit test of one view cannot see.
/// A plain text scan of the code (line comments left out).
final class PhoneFirstStructureTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    private func code(_ relative: String) throws -> String {
        let text = try String(contentsOf: iosRoot.appendingPathComponent(relative), encoding: .utf8)
        return text.components(separatedBy: "\n").map { $0.components(separatedBy: "//")[0] }.joined(separator: "\n")
    }

    private func appFiles() throws -> [String] {
        let dir = iosRoot.appendingPathComponent("Mondrop")
        let found = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []
        return found.filter { $0.pathExtension == "swift" }.map { "Mondrop/" + $0.lastPathComponent }.sorted()
    }

    private func count(_ needle: String, in text: String) -> Int { text.components(separatedBy: needle).count - 1 }

    // MARK: U10 — the phone first

    func testTheHomeAndTheListsOfPlaylistsPutWhatIsOnThePhoneFirst() throws {
        let home = try code("Mondrop/HomeView.swift")
        XCTAssertTrue(home.contains("marks.ordered(section.playlists, id: \\.id, songCount: \\.songCount)"), "the cards of the playlists")
        XCTAssertTrue(home.contains("LocalFirst.songs(section.tracks)"), "the songs of a row")
        XCTAssertTrue(home.contains("tracks: orderedTracks(of: section)"), "and the queue made from a row follows the row as it is drawn")
        let playlists = try code("Mondrop/PlaylistsView.swift")
        XCTAssertTrue(playlists.contains("marks.ordered(model.items, id: \\.id, songCount: \\.songCount)"), "the whole list")
        let library = try code("Mondrop/LibraryView.swift")
        XCTAssertTrue(library.contains("marks.ordered(model.playlists, id: \\.id, songCount: \\.songCount)"), "«Sfoglia» → Playlist")
        XCTAssertTrue(library.contains("PlaylistStateMark(state: marks.state(id: playlist.id, songCount: playlist.songCount))"), "with the mark that explains the order")
    }

    func testTheSongsOfAPlaylistAreListedAndQueuedWithThePhoneFirst() throws {
        let page = try code("Mondrop/PlaylistsView.swift")
        XCTAssertTrue(page.contains("LocalFirst.songs(manifest.tracks)"))
        XCTAssertEqual(count("localFirst: true", in: page), 1, "the queue of a playlist: «Suona», «Mescola» and a tap on a song all go through the one call")
        let voice = try code("Mondrop/VoiceActions.swift")
        XCTAssertTrue(voice.contains("localFirst: true"), "«metti la playlist X»: the same rule, with no screen to show it")
    }

    func testSearchResultsAndTheLibraryByAlbumAreNotReorderedByWhatIsOnThePhone() throws {
        // relevance decides a search and the disc decides an album: the phone-first order is for the lists of the playlists and the songs of a playlist and of a row of the first page
        for file in ["Mondrop/SearchView.swift", "Mondrop/SearchPages.swift", "Mondrop/SearchActions.swift"] {
            XCTAssertFalse(try code(file).contains("LocalFirst"), file)
        }
        XCTAssertFalse(try code("Mondrop/LibraryView.swift").contains("LocalFirst.songs"))
    }

    // MARK: U11 — the page of a playlist is the list and «Suona»

    func testThePageOfAPlaylistHasItsListAtOnceAndSuonaOnTop() throws {
        let page = try code("Mondrop/PlaylistsView.swift")
        XCTAssertTrue(page.contains("cache: FilePlaylistManifestCache.shared"), "the list the phone kept the last time: in the first frame, offline too")
        XCTAssertTrue(page.contains(".refreshable { await model.load() }"))
        XCTAssertTrue(page.contains("Label(\"Suona\", systemImage: \"play.fill\")"))
        XCTAssertTrue(page.contains("Label(\"Mescola\", systemImage: \"shuffle\")"))
        let body = try XCTUnwrap(page.components(separatedBy: "struct PlaylistOfflineView: View {").last)
        let listAt = try XCTUnwrap(body.range(of: "Section {\n                    ForEach(arranged(manifest))"))
        let playAt = try XCTUnwrap(body.range(of: "playRow(manifest)"))
        XCTAssertLessThan(playAt.lowerBound, listAt.lowerBound, "«Suona» comes before the songs, nothing else in between")
    }

    func testTheKeptListsAreTidiedWhenAPlaylistIsDeletedOnTheServer() throws {
        XCTAssertTrue(try code("Mondrop/PlaylistsView.swift").contains("FilePlaylistManifestCache.shared.prune(keeping: Set(all.map(\\.id)))"))
    }

    func testTheSyncOfThePlayingPlaylistKeepsItsListForItsPage() throws {
        let host = try code("Mondrop/PlayingSyncHost.swift")
        XCTAssertEqual(count("cache: FilePlaylistManifestCache.shared", in: host), 2, "the playlist that plays and the check keep what they read")
    }

    // MARK: U12 — no sync in sight

    func testNoPageShowsTheSyncAndOnlyTheSettingsSayTheWord() throws {
        for file in try appFiles() {
            let source = try code(file)
            XCTAssertFalse(source.contains("SyncStatusBar"), "\(file): the line at the top of the pages is gone")
            for gone in ["Riprova errori", "Preparo la playlist", "summaryLine", "Button(model.isBusy", "In attesa del Wi-Fi: la rete cellulare è disattivata per i download (Impostazioni → Sync)"] {
                XCTAssertFalse(source.contains(gone), "\(file): «\(gone)»")
            }
            if file == "Mondrop/SettingsView.swift" || file == "Mondrop/DemoData.swift" { continue }
            XCTAssertFalse(source.contains("\"Rete: "), "\(file): the line about the network is information for the Settings, not for the pages")
            // the word between quotes: a label, a title, a sentence the user reads
            let words = try NSRegularExpression(pattern: #""[^"\n]*\bSync\b[^"\n]*""#)
            let found = words.matches(in: source, range: NSRange(source.startIndex..., in: source)).compactMap { Range($0.range, in: source).map { String(source[$0]) } }
            XCTAssertTrue(found.isEmpty, "\(file): the sync is automatic and quiet; the Settings are the one place that names it: \(found)")
        }
    }

    func testThePlaylistPageHasNoSyncButtonAndNoNetworkLine() throws {
        let page = try code("Mondrop/PlaylistsView.swift")
        let body = try XCTUnwrap(page.components(separatedBy: "struct PlaylistOfflineView: View {").last)
        for gone in ["model.sync()", "model.isBusy", "NetStatus", "net.label", "WifiHint", "model.message", "Label(\"Sync\""] {
            XCTAssertFalse(body.contains(gone), gone)
        }
    }

    // MARK: U13 — the mini player

    func testTheMiniPlayerIsThereOnlyWhileSomethingIsInPlayAndSaysWhereTheFileIs() throws {
        let mini = try code("Mondrop/MiniPlayer.swift")
        XCTAssertTrue(mini.contains("MiniPlayerPresence.isShown(title: player.title, inPlay: player.inPlay)"))
        XCTAssertTrue(mini.contains("MiniPlayerPresence.location(of: player.playbackStatus)"))
        XCTAssertTrue(mini.contains("SongStateMark(state: location)"), "the same three marks as the lists")
        XCTAssertFalse(mini.contains("if !player.title.isEmpty"), "a song that is only loaded is not in play")
        // tucked away by sliding and fading, never by leaving the layout: a page that changes its height under the finger moves, and at the end of a short list the bar would hide
        // and show over and over
        XCTAssertTrue(mini.contains(".offset(y: tucked ? 96 : 0)"))
        XCTAssertTrue(mini.contains(".opacity(tucked ? 0 : 1)"))
        XCTAssertTrue(mini.contains(".allowsHitTesting(!tucked)"), "a bar that is not there cannot be touched")
        XCTAssertFalse(mini.contains("&& !tucked"), "the bar is not taken out of the layout when it is tucked")
    }

    func testEveryPageWithAListLeavesRoomForTheMiniPlayerAndTellsItHowFarItIsScrolled() throws {
        // «E comunque non deve sovrapporre le cose sotto, oppure deve sparire/nascondersi se navigo» (Michele, 11 November): the bar slides away while a page is scrolled down
        let pages: [(String, Int)] = [
            ("Mondrop/PlaylistsView.swift", 2), ("Mondrop/SearchView.swift", 1), ("Mondrop/SearchPages.swift", 1), ("Mondrop/LibraryView.swift", 2),
            ("Mondrop/InboxView.swift", 1), ("Mondrop/SettingsView.swift", 1), ("Mondrop/SpaceView.swift", 1),
        ]
        for (file, expected) in pages {
            XCTAssertEqual(count(".withMiniPlayer()", in: try code(file)), expected, "\(file): one for each list or form it draws")
        }
        let mini = try code("Mondrop/MiniPlayer.swift")
        XCTAssertTrue(mini.contains(".environment(\\.miniPlayerScroll, scroll)"), "the bar of a tab hears the pages of that tab")
        // the room after the last row: an inset on the navigation stack does not reach the lists of the pages pushed on it (seen on the simulator: at the end of a long list the
        // last row was under the bar), so every page makes it itself, from the height of the bar as it is drawn
        XCTAssertTrue(mini.contains(".contentMargins(.bottom, reserve, for: .scrollContent)"))
        XCTAssertTrue(mini.contains(".environment(\\.miniPlayerReserve, visible ? barHeight : 0)"), "no bar, no room")
        XCTAssertTrue(mini.contains("MiniPlayerBarHeightKey.self"), "the height is the one the bar has, not a number")
        XCTAssertTrue(mini.contains("preference(key: MiniPlayerBarHeightKey.self, value: $0.size.height)"), "measured where the bar is drawn")
        XCTAssertTrue(mini.contains(".onPreferenceChange(MiniPlayerBarHeightKey.self) { barHeight = $0 }"), "and handed to the pages")
        XCTAssertTrue(mini.contains("let roomy = content.contentMargins(.bottom, reserve, for: .scrollContent)"))
        XCTAssertEqual(count("roomy\n", in: mini), 2, "both branches (iOS 18 and later, and before) draw the page that has the room")
        XCTAssertTrue(mini.contains("onScrollGeometryChange(for: Double.self)"))
        XCTAssertTrue(mini.contains("scroll?.reset()"), "a page that appears brings the bar back")
        XCTAssertTrue(mini.contains("MiniPlayerScrollRule()"), "what decides is the pure rule")
    }

    // MARK: U15 — the check of the playlists, in the Settings

    func testTheSettingsHaveTheCheckAndItsQuestion() throws {
        let settings = try code("Mondrop/SettingsView.swift")
        XCTAssertTrue(settings.contains("Controlla le playlist sul telefono"))
        XCTAssertTrue(settings.contains("check.start()"))
        XCTAssertTrue(settings.contains(".syncSizeDialog(check)"), "the question over the limit comes up on the Settings")
        XCTAssertTrue(settings.contains("PlaylistConsistencyCheck.shared"))
        XCTAssertTrue(settings.contains("check.cancel()"), "it can be stopped")
        XCTAssertTrue(settings.contains("Download in corso: ancora"), "and the row says how many downloads are left, the one place where the sync is shown")
        let host = try code("Mondrop/PlayingSyncHost.swift")
        XCTAssertTrue(host.contains("static let shared = PlaylistConsistencyCheck("))
        XCTAssertTrue(host.contains("limit: { Settings.shared.syncWarnLimit }"), "the limit is the one of the Settings")
    }

    func testOnlyTheCheckAndTheRowsOfASongStartASyncTheUserCanBeToldAbout() throws {
        // `.sync` is the origin that ends with «Sync finito»: the coordinator's default (a «Riprova» on a song) and the check; the playlist that plays says `.automatic`
        let kit = iosRoot.appendingPathComponent("MondropKit")
        var users: [String] = []
        for file in (FileManager.default.enumerator(at: kit, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []) where file.pathExtension == "swift" {
            if try code("MondropKit/" + file.lastPathComponent).contains("origin: .automatic") { users.append(file.lastPathComponent) }
        }
        XCTAssertEqual(users, ["PlayingPlaylistSync.swift"])
    }
}
