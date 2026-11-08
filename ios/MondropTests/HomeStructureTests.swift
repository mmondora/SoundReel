import XCTest
@testable import Mondrop

/// The shape of the app after the Home (spec 2026-11-08-mondrop-home-spotify-design.md H1–H3, H7): read from the SOURCES, like `RulePTests`,
/// because these are decisions about how the screens are put together, which a unit test of one view cannot see. A plain text scan: a comment
/// that explains a rule has to say it in other words.
final class HomeStructureTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    /// The code of a file, without its line comments.
    private func code(_ relative: String) throws -> String {
        let text = try String(contentsOf: iosRoot.appendingPathComponent(relative), encoding: .utf8)
        return text.components(separatedBy: "\n").map { $0.components(separatedBy: "//")[0] }.joined(separator: "\n")
    }

    /// Every Swift file the app is made of: (path relative to `ios/`, code without comments).
    private func allSources() throws -> [(name: String, code: String)] {
        var out: [(String, String)] = []
        for directory in ["Mondrop", "MondropKit", "MondropShare"] {
            let url = iosRoot.appendingPathComponent(directory, isDirectory: true)
            guard let walker = FileManager.default.enumerator(at: url, includingPropertiesForKeys: nil) else { continue }
            for case let file as URL in walker where file.pathExtension == "swift" {
                let relative = directory + "/" + String(file.standardizedFileURL.path.dropFirst(url.standardizedFileURL.path.count + 1))
                out.append((relative, try code(relative)))
            }
        }
        return out.sorted { $0.0 < $1.0 }
    }

    private func count(_ needle: String, in text: String) -> Int {
        text.components(separatedBy: needle).count - 1
    }

    // MARK: the tabs (H3)

    func testTheTabsAreHomeSearchPlaylistsInboxShareSettings() {
        XCTAssertEqual(RootTab.allCases, [.home, .search, .playlists, .inbox, .share, .settings])
    }

    func testTheTabBarDeclaresThemInThatOrderAndTheFirstOneIsTheHome() throws {
        let source = try code("Mondrop/RootTabView.swift")
        let regex = try NSRegularExpression(pattern: #"\.tag\(RootTab\.(\w+)\)"#)
        let tags = regex.matches(in: source, range: NSRange(source.startIndex..., in: source)).compactMap { match -> String? in
            Range(match.range(at: 1), in: source).map { String(source[$0]) }
        }
        XCTAssertEqual(tags, ["home", "search", "playlists", "inbox", "share", "settings"])
        XCTAssertTrue(source.contains("@State private var selection: RootTab = .home"), "the app opens on the Home")
    }

    func testThePlayerIsNotATab() throws {
        let source = try code("Mondrop/RootTabView.swift")
        XCTAssertFalse(source.contains("RootTab.player"))
        XCTAssertFalse(source.contains("case player"))
        XCTAssertFalse(source.contains("tabItem { Label(\"Player\""))
    }

    // MARK: the Player opens from the mini player (H2)

    func testThePlayerOpensAtFullScreenFromTheRootAndClosesWithItsArrow() throws {
        let root = try code("Mondrop/RootTabView.swift")
        XCTAssertTrue(root.contains("fullScreenCover"))
        XCTAssertTrue(root.contains("WinampPlayerView(onClose:"))
        let player = try code("Mondrop/WinampPlayerView.swift")
        XCTAssertTrue(player.contains("chevron.down"))
        XCTAssertTrue(player.contains("Chiudi il Player"))
        XCTAssertFalse(player.contains("onChoose"), "the Player does not send the user anywhere to look for music")
    }

    func testEveryTabCarriesTheMiniPlayerOnItsNavigationStack() throws {
        let source = try code("Mondrop/RootTabView.swift")
        XCTAssertEqual(count("NavigationStack {", in: source), 6)
        XCTAssertEqual(count(".miniPlayer(open: openPlayer)", in: source), 6, "every tab, so that it is on every page of every tab")
    }

    func testThereIsOneMiniPlayerForTheWholeApp() throws {
        var drawn: [String] = []
        var asked: [String] = []
        for source in try allSources() {
            if source.code.contains("MiniPlayerBar(") { drawn.append(source.name) }
            if source.code.contains(".miniPlayer(") { asked.append(source.name) }
        }
        XCTAssertEqual(drawn, ["Mondrop/MiniPlayer.swift"], "no page draws its own mini player")
        XCTAssertEqual(asked, ["Mondrop/RootTabView.swift"], "only the tabs ask for it")
    }

    func testTheQueueDoesNotSendTheUserToSearchEither() throws {
        XCTAssertFalse(try code("Mondrop/SongRows.swift").contains("onChooseMore"))
    }

    // MARK: no «Cerca musica» (the request that started all of this)

    func testNothingInTheAppSaysCercaMusica() throws {
        for source in try allSources() {
            let lowered = source.code.lowercased()
            XCTAssertFalse(lowered.contains("cerca musica"), "\(source.name): «No aspetta, non mi piace il \"cerca musica\"» (Michele, 8 November)")
            XCTAssertFalse(lowered.contains("cerca cosa suonare"), source.name)
        }
    }

    // MARK: the field of the Home (H1)

    func testTheFieldOfTheHomeOpensCercaWithTheKeyboard() throws {
        XCTAssertTrue(try code("Mondrop/HomeView.swift").contains("RootRouter.shared.requestSearch()"))
        XCTAssertTrue(try code("Mondrop/RootTabView.swift").contains(".onChange(of: root.searchRequests)"))
        let search = try code("Mondrop/SearchView.swift")
        XCTAssertTrue(search.contains("isPresented: $searchPresented"))
        XCTAssertTrue(search.contains("takeSearchRequest()"))
    }

    // MARK: the Home draws what the server sent and reads nothing else (H5, rule P)

    func testTheHomeNeverReadsTheNetworkNorNamesAStore() throws {
        for file in ["Mondrop/HomeView.swift", "MondropKit/HomeModel.swift", "MondropKit/HomeModels.swift", "Mondrop/MiniPlayer.swift", "MondropKit/QueueSnapshot.swift"] {
            let source = try code(file)
            for banned in ["NetStatus", "onExpensivePath", "viaCloudflare", "currentHome", "SettingsView"] {
                XCTAssertFalse(source.contains(banned), "\(file): «\(banned)» — what is shown and where a file comes from are the server's business")
            }
        }
    }

    func testTheHomeIsNeverABlankPage() throws {
        let source = try code("Mondrop/HomeView.swift")
        XCTAssertTrue(source.contains("Cosa vuoi ascoltare?"), "the field is there whatever the server says")
        XCTAssertTrue(source.contains("Brani sul telefono"), "so is the way to what is on the phone, when the server does not answer")
        XCTAssertTrue(source.contains("Riprova"))
        XCTAssertTrue(source.contains("ResumeSection(onOpen:"), "«Riprendi» is the phone's own: it does not wait for the server")
    }

    func testTheHomeAsksForNothingButTheHomeRoute() throws {
        let source = try code("MondropKit/MondropAPI.swift")
        XCTAssertTrue(source.contains("/api/mondrop/home"))
        XCTAssertEqual(count("\"/api/mondrop/home\"", in: source), 1)
    }
}
