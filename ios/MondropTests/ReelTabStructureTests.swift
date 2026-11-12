import XCTest
@testable import Mondrop

/// How the pieces of build 20 are put together (spec 2026-11-12-mondrop-home-play-loop-reels-design.md M1–M5), read from the SOURCES like `HomeStructureTests`: these are decisions about how
/// screens are assembled, which a unit test of one view cannot see. A plain text scan of the code without its line comments, so a comment that explains a rule must say it in other words.
final class ReelTabStructureTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    private func code(_ relative: String) throws -> String {
        let text = try String(contentsOf: iosRoot.appendingPathComponent(relative), encoding: .utf8)
        return text.components(separatedBy: "\n").map { $0.components(separatedBy: "//")[0] }.joined(separator: "\n")
    }

    // MARK: the Reel tab (M5)

    func testTheReelTabTakesThePlaceOfShareAndTheFormOpensFromAPlus() throws {
        let root = try code("Mondrop/RootTabView.swift")
        XCTAssertTrue(root.contains("ReelsView()"))
        XCTAssertTrue(root.contains("Label(\"Reel\""))
        XCTAssertFalse(root.contains("RootTab.share"), "five tabs: a sixth folds the rest into «Altro» and hides the badge of the Posta")
        XCTAssertFalse(root.contains("Label(\"Share\""))
        let reels = try code("Mondrop/ReelsView.swift")
        XCTAssertTrue(reels.contains("ContentView()"), "the manual share form, from the «+» of this tab")
        XCTAssertTrue(reels.contains(".sheet("))
        XCTAssertTrue(reels.contains("systemImage: \"plus\""))
    }

    func testTheReelScreensHaveNoLinkToTheReelAndOpenNoAddress() throws {
        let words = ["sourceUrl", "mediaUrl", "imdbUrl", "openURL", "UIApplication", "NSWorkspace", "URL(string", "ShareLink"]
        let link = try NSRegularExpression(pattern: #"\bLink\("#)
        for file in ["Mondrop/ReelsView.swift", "Mondrop/ReelDetailView.swift", "MondropKit/ReelModels.swift", "MondropKit/ReelsModel.swift"] {
            let source = try code(file)
            for word in words {
                XCTAssertFalse(source.contains(word), "\(file): «\(word)» — «non il link al reel ma la sua scomposizione e spiegazione»")
            }
            XCTAssertEqual(link.numberOfMatches(in: source, range: NSRange(source.startIndex..., in: source)), 0, "\(file): no Link(…) to anywhere")
        }
    }

    func testTheReelModelsHaveNoFieldThatIsAnAddress() throws {
        let models = try code("MondropKit/ReelModels.swift")
        let field = try NSRegularExpression(pattern: #"\b(let|var)\s+\w*(url|link|href)\w*\s*:"#, options: [.caseInsensitive])
        let hits = field.matches(in: models, range: NSRange(models.startIndex..., in: models)).compactMap { Range($0.range, in: models).map { String(models[$0]) } }
        XCTAssertEqual(hits, [], "a reel is described, not linked: the only path is the one of its picture (`imagePath`)")
    }

    func testTheReelTabReadsOnlyTheNetworkAndKeepsNothingOfAReelOnThePhone() throws {
        for file in ["MondropKit/ReelsModel.swift", "MondropKit/ReelModels.swift", "Mondrop/ReelsView.swift", "Mondrop/ReelDetailView.swift"] {
            let source = try code(file)
            for word in ["UserDefaults", "FileManager", "write(to", "OfflineStore", "FilePlaylistManifestCache"] {
                XCTAssertFalse(source.contains(word), "\(file): «\(word)» — «l'unica cosa che viene portata sulla device è la musica»")
            }
        }
    }

    func testTheMusicOfAReelIsPlayedAndDownloadedLikeAnyOtherSong() throws {
        let detail = try code("Mondrop/ReelDetailView.swift")
        XCTAssertTrue(detail.contains("SongRowView"), "the songs have the three marks, like every list of songs")
        XCTAssertTrue(detail.contains("LocalAudioPlayer.shared.start"))
        XCTAssertTrue(detail.contains("SearchPlayback.queue"), "a tap plays this song and the ones after it, like every list")
        XCTAssertTrue(detail.contains("trackActions"), "the long press offers what Cerca offers")
    }

    func testEveryAnswerOfTheTabIsExplainedAsGeneratedByTheModelWhereItIs() throws {
        let detail = try code("Mondrop/ReelDetailView.swift")
        XCTAssertTrue(detail.contains("Generato dall'IA"), "the insights are written by a local model and can be wrong")
        XCTAssertTrue(detail.contains("Di cosa parla"))
        XCTAssertTrue(detail.contains("Slide per slide"))
        XCTAssertTrue(detail.contains("Approfondimenti"))
    }

    // MARK: the play on the card, the loop on the play (M1, M2)

    func testTheHomeHasThePlayOnEveryPlaylistCardAndTheMenuOfALongPress() throws {
        let home = try code("Mondrop/HomeView.swift")
        XCTAssertTrue(home.contains("PlaylistQuickPlay"))
        XCTAssertTrue(home.contains("play.fill"))
        XCTAssertTrue(home.contains(".contextMenu"))
        for item in ["\"Suona\"", "\"Mescola\"", "\"Suona in loop\""] {
            XCTAssertTrue(home.contains(item), item)
        }
        // no sync or check on the Home (12 November, «se è il controllo di consistenza lo voglio in impostazioni»): the Settings are the only place that names them
        XCTAssertFalse(home.contains("syncAll"))
        XCTAssertFalse(home.contains("Text(\"Sync"))
        XCTAssertFalse(home.contains("Label(\"Sync"))
        XCTAssertFalse(home.contains("PlaylistConsistencyCheck"))
    }

    func testTheCardPlayDoesNotStartASyncByItself() throws {
        let quick = try code("MondropKit/PlaylistQuickPlay.swift")
        for word in ["prepare(", "PlaylistSyncCoordinator", "engine.enqueue", "PlayingPlaylistSync"] {
            XCTAssertFalse(quick.contains(word), "«\(word)»: the play only builds the queue; the playlist that plays syncs by itself (U2)")
        }
    }

    func testThePlayOfThePageOfAPlaylistOffersTheLoopToo() throws {
        let page = try code("Mondrop/PlaylistsView.swift")
        XCTAssertTrue(page.contains("\"Suona in loop\""), "a long press on «Suona»")
        XCTAssertTrue(page.contains("if loop { player.setRepeatMode(.all) }"), "the loop is set before the queue starts")
        XCTAssertEqual(page.components(separatedBy: "player.setRepeatMode(").count - 1, 1, "only «Suona in loop» touches the loop on that page")
    }

    func testTheLoopIsOnThePlayOfTheMiniPlayerAndOfRiprendi() throws {
        for file in ["Mondrop/MiniPlayer.swift", "Mondrop/HomeView.swift"] {
            let source = try code(file)
            XCTAssertTrue(source.contains("RepeatMenuItems"), "\(file): the long press on the play")
            XCTAssertTrue(source.contains("RepeatIndicator"), "\(file): the mark when the loop is on")
        }
        let views = try code("Mondrop/LikeButton.swift")
        XCTAssertTrue(views.contains("struct RepeatMenuItems"))
        XCTAssertTrue(views.contains("struct RepeatIndicator"))
        XCTAssertTrue(views.contains("RepeatChoice.all"))
        XCTAssertTrue(views.contains("setRepeatMode"))
    }

    // MARK: the Home composed by the server, the downloads one at a time (M3, M4)

    func testTheAppDoesNotFilterTheSectionsOfTheHomeItself() throws {
        // «gli Ascoltati di recente non mi interessano in homepage»: the server stops sending the row (SoundReel 2.27.0, ADR-0020); the app draws what comes
        for file in ["Mondrop/HomeView.swift", "MondropKit/HomeModels.swift", "MondropKit/HomeModel.swift"] {
            let source = try code(file)
            XCTAssertFalse(source.contains("\"recent\""), "\(file): the app does not decide which sections exist")
        }
    }

    func testTheEngineRunsOneDownloadAtATime() throws {
        let engine = try code("MondropKit/SyncEngine.swift")
        XCTAssertTrue(engine.contains("public var maxParallel = 1"))
        XCTAssertFalse(engine.contains("maxParallel = 2"))
    }
}
