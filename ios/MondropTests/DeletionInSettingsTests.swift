import XCTest
@testable import Mondrop

/// Deletion is a special option and lives in the Settings (Michele, 8 November: «su mondrop la cancellazione è una opzione
/// speciale e deve stare in impostazione»; spec 2026-11-08-mondrop-deletion-in-settings-design.md). The sources are read, like
/// RulePTests does: a screen that is reached from the wrong place fails the build.
final class DeletionInSettingsTests: XCTestCase {
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

    func testTheScreenWhereSongsAreDeletedIsReachedFromTheSettingsAndOnlyFromThere() throws {
        let files = try swiftFiles(in: "Mondrop")
        XCTAssertGreaterThan(files.count, 10, "the sources were not found: the test would prove nothing")
        let builders = try files.filter { try text($0).contains("SpaceView()") }.map(\.lastPathComponent)
        XCTAssertEqual(builders, ["SettingsView.swift"], "«Spazio e brani scaricati» has ONE way in: the Settings (found in \(builders))")
    }

    func testNoScreenThatListsSongsOffersToDeleteThem() throws {
        // the rows of songs: the player, the search and its pages, the library, the playlists, the queue and their shared pieces
        let songScreens = ["SearchView.swift", "SearchPages.swift", "SearchActions.swift", "LibraryView.swift", "PlaylistsView.swift",
                           "WinampPlayerView.swift", "SongRows.swift", "PlaylistPickerView.swift"]
        let files = try swiftFiles(in: "Mondrop").filter { songScreens.contains($0.lastPathComponent) }
        XCTAssertEqual(Set(files.map(\.lastPathComponent)), Set(songScreens), "a screen was renamed: update this list")
        for file in files {
            let lines = try text(file).components(separatedBy: "\n")
            for (n, line) in lines.enumerated() {
                let code = line.components(separatedBy: "//")[0]
                // the only destructive gesture a song screen may have is the recent searches of «Cerca»: it deletes no song
                let isRecentSearch = file.lastPathComponent == "SearchView.swift" && code.contains("forget(")
                XCTAssertFalse(code.contains("role: .destructive") && !isRecentSearch,
                               "\(file.lastPathComponent):\(n + 1) offers a deletion on a screen of songs: it belongs in the Settings")
                XCTAssertFalse(code.contains("\"Elimina") || code.contains("\"Rimuovi dal telefono"),
                               "\(file.lastPathComponent):\(n + 1) says «Elimina»: deleting songs belongs in the Settings")
            }
        }
    }

    func testTheSettingsHaveADeletionSectionOfTheirOwn() throws {
        let settings = try text(iosRoot.appendingPathComponent("Mondrop/SettingsView.swift"))
        XCTAssertTrue(settings.contains("deletionSection"))
        XCTAssertTrue(settings.contains("Text(\"Cancellazione\")"))
    }

    func testNothingStillSaysTheFilesComeFromTheMediaServer() throws {
        for file in try swiftFiles(in: "Mondrop") {
            XCTAssertFalse(try text(file).lowercased().contains("direttamente dal media server"),
                           "\(file.lastPathComponent): the app downloads only from SoundReel (rule P)")
        }
    }
}
