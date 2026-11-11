import XCTest
@testable import Mondrop

/// Where a song is deleted from the phone. First rule (Michele, 8 November: «su mondrop la cancellazione è una opzione speciale e deve stare in impostazione»):
/// the Settings, «Spazio e brani scaricati». It changed on 10 November: «La canzone viene cancellata solo con uno swipe della canzone in ricerca, non nel
/// browser di una playlist» (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U8, which replaces D1 and D2 of
/// 2026-11-08-mondrop-deletion-in-settings-design.md). So a song is deleted in two places only: the Settings (a lot at once) and the swipe on a song of
/// «Cerca» (one, with the SAME confirmation and the SAME entry in the activity trail). Never in a playlist (there the swipe takes the song out of the
/// list and deletes nothing), never on the first page, never from the Player. The sources are read, like RulePTests does: a screen that offers it from
/// the wrong place fails the build.
final class DeletionPlacesTests: XCTestCase {
    /// `ios/` as found from this file: it sits at `ios/MondropTests/`.
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    private func swiftFiles(in folder: String) throws -> [URL] {
        let dir = iosRoot.appendingPathComponent(folder)
        let found = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []
        return found.filter { $0.pathExtension == "swift" }.sorted { $0.path < $1.path }
    }

    private func text(_ url: URL) throws -> String { try String(contentsOf: url, encoding: .utf8) }

    /// The code of a file without its line comments.
    private func code(_ relative: String) throws -> String {
        try text(iosRoot.appendingPathComponent(relative)).components(separatedBy: "\n").map { $0.components(separatedBy: "//")[0] }.joined(separator: "\n")
    }

    /// The code of every file of the app that has `needle` in it.
    private func filesWithCode(containing needles: [String]) throws -> [String] {
        var found: [String] = []
        for file in try swiftFiles(in: "Mondrop") {
            let name = file.lastPathComponent
            let source = try code("Mondrop/" + name)
            if needles.contains(where: { source.contains($0) }) { found.append(name) }
        }
        return found
    }

    // MARK: the screen of the Settings

    func testTheScreenWhereManySongsAreDeletedIsReachedFromTheSettingsAndOnlyFromThere() throws {
        let files = try swiftFiles(in: "Mondrop")
        XCTAssertGreaterThan(files.count, 10, "the sources were not found: the test would prove nothing")
        let builders = try files.filter { try text($0).contains("SpaceView()") }.map(\.lastPathComponent)
        XCTAssertEqual(builders, ["SettingsView.swift"], "«Spazio e brani scaricati» has ONE way in: the Settings (found in \(builders))")
    }

    func testTheSettingsHaveADeletionSectionOfTheirOwn() throws {
        let settings = try text(iosRoot.appendingPathComponent("Mondrop/SettingsView.swift"))
        XCTAssertTrue(settings.contains("deletionSection"))
        XCTAssertTrue(settings.contains("Text(\"Cancellazione\")"))
    }

    // MARK: the swipe of «Cerca» — and only that

    func testOnlyTheSearchRowsOfferTheSwipeThatDeletesASongFromThePhone() throws {
        XCTAssertEqual(try filesWithCode(containing: ["Cancella dal telefono"]), ["SearchActions.swift"],
                       "the swipe «Cancella dal telefono» exists on the songs of «Cerca» and nowhere else")
        XCTAssertEqual(try filesWithCode(containing: ["askDelete("]), ["SearchActions.swift"])
        XCTAssertEqual(try filesWithCode(containing: [".searchDeletion("]).sorted(), ["SearchPages.swift", "SearchView.swift"],
                       "the confirmation is hosted by the screens of «Cerca» only")
    }

    func testTheSwipeOfCercaIsOnlyOnASongThatIsOnThePhoneAndNeverATapAwayFromAConfirmation() throws {
        let actions = try code("Mondrop/SearchActions.swift")
        guard let swipe = actions.range(of: ".swipeActions(edge: .trailing, allowsFullSwipe: false)") else { return XCTFail("the swipe is not there") }
        let block = String(actions[swipe.lowerBound...].prefix(420))
        XCTAssertTrue(block.contains("if isLocal"), "nothing to delete from a song that is not on the phone")
        XCTAssertTrue(block.contains("Button(role: .destructive)"))
        XCTAssertTrue(block.contains("actions.askDelete(track)"), "it only ASKS: the confirmation comes first")
        XCTAssertFalse(actions.contains("allowsFullSwipe: true"), "a full swipe never deletes by itself")
    }

    func testTheSwipeOfCercaAsksTheSameConfirmationAndWritesTheSameTrailAsTheSettings() throws {
        let actions = try code("Mondrop/SearchActions.swift")
        XCTAssertTrue(actions.contains("SpaceModel(store: .shared, queue: .shared, uploader: .shared"), "the model of «Spazio e brani scaricati»: the durable `delete_songs` event")
        XCTAssertTrue(actions.contains("model.requestDelete(songKey:"))
        XCTAssertTrue(actions.contains("DeletionDialogs.first(plan)"), "its words, its one confirmation for one song")
        // nothing in the screens deletes by itself: the files go only through the model that writes the event first
        XCTAssertEqual(try filesWithCode(containing: ["removeSongs(", "SongDeleter("]), [], "the screens never delete files themselves")
    }

    // MARK: no other row of songs offers anything like it

    func testNoOtherScreenOfSongsOffersToDeleteThem() throws {
        // the rows of songs: the player, the first page, the library, the playlists, the queue and their shared pieces
        let songScreens = ["SearchView.swift", "SearchPages.swift", "LibraryView.swift", "PlaylistsView.swift", "HomeView.swift",
                           "WinampPlayerView.swift", "MiniPlayer.swift", "SongRows.swift", "PlaylistPickerView.swift", "StateMarks.swift"]
        let files = try swiftFiles(in: "Mondrop").filter { songScreens.contains($0.lastPathComponent) }
        XCTAssertEqual(Set(files.map(\.lastPathComponent)), Set(songScreens), "a screen was renamed: update this list")
        for file in files {
            let lines = try text(file).components(separatedBy: "\n")
            for (n, line) in lines.enumerated() {
                let code = line.components(separatedBy: "//")[0]
                // the only destructive gesture these screens may have is the recent searches of «Cerca»: it deletes no song
                let isRecentSearch = file.lastPathComponent == "SearchView.swift" && code.contains("forget(")
                XCTAssertFalse(code.contains("role: .destructive") && !isRecentSearch,
                               "\(file.lastPathComponent):\(n + 1) offers a deletion on a screen of songs: it belongs in the Settings or in the swipe of «Cerca»")
                XCTAssertFalse(code.contains("\"Elimina") || code.contains("\"Rimuovi dal telefono") || code.contains("Cancella dal telefono"),
                               "\(file.lastPathComponent):\(n + 1) offers a deletion on a screen of songs")
            }
        }
    }

    func testThePlayerTheFirstPageAndTheQueueHaveNoSwipeAtAll() throws {
        for file in ["Mondrop/WinampPlayerView.swift", "Mondrop/HomeView.swift", "Mondrop/MiniPlayer.swift", "Mondrop/SongRows.swift"] {
            XCTAssertFalse(try code(file).contains(".swipeActions"), "\(file): no swipe on the Player, the first page or the queue")
        }
    }

    // MARK: inside a playlist the swipe only takes the song out of the list

    func testTheSwipeInAPlaylistOffersOnlyTogliDallaPlaylistAndNothingElse() throws {
        let playlists = try code("Mondrop/PlaylistsView.swift")
        XCTAssertEqual(playlists.components(separatedBy: ".swipeActions").count - 1, 1, "one swipe, on the songs of the page of a playlist")
        guard let swipe = playlists.range(of: ".swipeActions(edge: .trailing, allowsFullSwipe: true)") else { return XCTFail("the swipe is not there") }
        let block = String(playlists[swipe.lowerBound...].prefix(380))
        XCTAssertTrue(block.contains("if canRemoveSongs"), "only the user's own static playlists (PlaylistRowActions)")
        XCTAssertTrue(block.contains("Togli dalla playlist"))
        XCTAssertTrue(block.contains("remove(track)"))
        XCTAssertFalse(playlists.contains("askDelete"))
        XCTAssertFalse(playlists.contains("requestDelete"))
        XCTAssertFalse(playlists.contains("Cancella dal telefono"))
        XCTAssertFalse(playlists.contains("role: .destructive"), "taking a song out of a list is not a deletion")
    }

    func testNothingStillSaysTheFilesComeFromTheMediaServer() throws {
        for file in try swiftFiles(in: "Mondrop") {
            XCTAssertFalse(try text(file).lowercased().contains("direttamente dal media server"),
                           "\(file.lastPathComponent): the app downloads only from SoundReel (rule P)")
        }
    }
}
