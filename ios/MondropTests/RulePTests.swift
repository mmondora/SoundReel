import XCTest

/// Rule P (ADR-0018, spec 2026-11-08-mondrop-search-spotify-style-design.md S9/S10): the app talks ONLY to SoundReel. It has
/// no address of the media server, no path to it, and it never chooses where a file comes from by the network the phone is on.
/// Where the files live, and which of the stores holds one, is the server's business.
///
/// This is an architecture test: it reads the SOURCES of the app and fails the build if the rule is broken again. It is
/// deliberately blunt (a plain text scan): a comment that explains the rule has to say it in other words.
final class RulePTests: XCTestCase {

    // MARK: the rule, as a pure function (so the guard itself can be tested)

    struct Source {
        /// Path relative to `ios/`, e.g. `MondropKit/SyncEngine.swift`.
        let name: String
        let text: String
        var fileName: String { (name as NSString).lastPathComponent }
    }

    /// No source of the app may contain any of these (compared without case): the media server's addresses and ports, the
    /// protocols it is found with, and the field that carried the address of one of its files.
    static let bannedEverywhere = ["192.168.", "49152", "49200", "dlna", "upnp", "mediaurl"]

    /// The places where a source is chosen. The phone's network (`home`, `currentHome`) must never reach them.
    static let sourceChoosers = ["SyncEngine.swift", "SyncPlanner.swift", "FirstPlay.swift", "PlaylistSync.swift", "LocalAudioPlayer.swift"]

    static func violations(in sources: [Source]) -> [String] {
        var found: [String] = []
        let home = try! NSRegularExpression(pattern: "\\bhome\\b", options: [.caseInsensitive])
        for source in sources {
            for (index, line) in source.text.components(separatedBy: "\n").enumerated() {
                let lowered = line.lowercased()
                for word in bannedEverywhere where lowered.contains(word) {
                    found.append("\(source.name):\(index + 1): «\(word)» (the app never talks to the media server)")
                }
                if lowered.contains("currenthome") {
                    found.append("\(source.name):\(index + 1): «currentHome» (the network must not choose a source)")
                }
                if sourceChoosers.contains(source.fileName),
                   home.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil {
                    found.append("\(source.name):\(index + 1): «home» (the network must not reach where a file comes from)")
                }
            }
        }
        return found
    }

    // MARK: reading the sources

    /// `ios/` (this file is `ios/MondropTests/RulePTests.swift`).
    private static let iosRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    private static let sourceDirectories = ["Mondrop", "MondropKit", "MondropShare"]

    private func appSources() throws -> [Source] {
        var out: [Source] = []
        let root = Self.iosRoot.standardizedFileURL
        for directory in Self.sourceDirectories {
            let url = root.appendingPathComponent(directory, isDirectory: true)
            guard let walker = FileManager.default.enumerator(at: url, includingPropertiesForKeys: nil) else { continue }
            for case let file as URL in walker where file.pathExtension == "swift" {
                let relative = String(file.standardizedFileURL.path.dropFirst(root.path.count + 1))
                out.append(Source(name: relative, text: try String(contentsOf: file, encoding: .utf8)))
            }
        }
        return out.sorted { $0.name < $1.name }
    }

    // MARK: the tests

    func testTheAppSourcesNameNoStoreAndLetTheNetworkChooseNothing() throws {
        let violations = Self.violations(in: try appSources())
        XCTAssertTrue(violations.isEmpty, "rule P is broken:\n" + violations.joined(separator: "\n"))
    }

    /// The scan must really read the app: a moved directory would otherwise turn the test above into a test of nothing.
    func testTheScanReadsTheSourcesItGuards() throws {
        let names = Set(try appSources().map(\.fileName))
        for chooser in Self.sourceChoosers { XCTAssertTrue(names.contains(chooser), "\(chooser) was not scanned") }
        for expected in ["NetStatus.swift", "OfflineStore.swift", "SettingsView.swift", "ShareComposeView.swift", "HomeView.swift", "HomeModel.swift", "HomeModels.swift", "MiniPlayer.swift", "QueueSnapshot.swift"] {
            XCTAssertTrue(names.contains(expected), "\(expected) was not scanned")
        }
        XCTAssertGreaterThan(try appSources().count, 40)
    }

    /// The guard has to catch each violation it exists for, in the right place, and leave the allowed things alone.
    func testTheScannerCatchesEachViolationAndOnlyThose() {
        func check(_ file: String, _ text: String) -> [String] {
            Self.violations(in: [Source(name: "MondropKit/\(file)", text: text)])
        }
        XCTAssertEqual(check("X.swift", "let a = \"http://192.168.178.10/a.mp3\"").count, 1)
        XCTAssertEqual(check("X.swift", "let port = 49200").count, 1)
        XCTAssertEqual(check("X.swift", "let port = 49152").count, 1)
        XCTAssertEqual(check("X.swift", "// found over DLNA").count, 1)
        XCTAssertEqual(check("X.swift", "// found over UPnP").count, 1)
        XCTAssertEqual(check("X.swift", "let u = track.mediaUrl").count, 1)
        XCTAssertEqual(check("X.swift", "let u = track.mediaURL").count, 1)
        XCTAssertEqual(check("X.swift", "let h = await net.currentHome(api: api)").count, 1)
        // the phone's network in the places where a source is chosen
        for file in RulePTests.sourceChoosers {
            XCTAssertEqual(check(file, "enqueue(tracks, home: home)").count, 1, "\(file)")
            XCTAssertEqual(check(file, "// decide at home or away").count, 1, "\(file)")
        }
        // elsewhere the word is fine (NetInfo, the Settings row, and plain prose)
        XCTAssertTrue(check("NetStatus.swift", "public let home: Bool\ncase true?: return \"casa\"").isEmpty)
        XCTAssertTrue(check("X.swift", "let homeScreen = 1 // the home of the app").isEmpty)
        XCTAssertTrue(check("SyncEngine.swift", "let homework = 1; let whomever = 2").isEmpty, "only the whole word counts")
        // line numbers point at the offender
        XCTAssertTrue(check("X.swift", "ok\nok\nlet a = \"192.168.1.1\"").first?.contains(":3:") ?? false)
        // and a clean file is clean
        XCTAssertTrue(check("SyncEngine.swift", "let url = DownloadURLChooser.candidates(for: track, baseURL: base)").isEmpty)
    }

    /// The App Transport Security exception that let the app speak plain HTTP to the home network existed only for the media
    /// server. SoundReel is HTTPS.
    func testThereIsNoAtsExceptionForTheLocalNetwork() throws {
        let plist = try String(contentsOf: Self.iosRoot.appendingPathComponent("Mondrop/Info.plist"), encoding: .utf8)
        XCTAssertFalse(plist.contains("<key>NSAllowsLocalNetworking</key>"))
        XCTAssertFalse(plist.contains("<key>NSAllowsArbitraryLoads</key>\n\t\t<true/>"))
    }
}
