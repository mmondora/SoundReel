import XCTest
@testable import Mondrop

/// What of Siri can be proved without Siri (spec 2026-11-10-mondrop-like-and-repeat-design.md L9, L10): the sentences and the intents are read
/// from the SOURCES, like `RulePTests` does, because a sentence that does not name the app, or an intent that makes a copy of the app's
/// state, is a defect no unit test of a function would see. A plain text scan. The sentences are not matched by Siri on a simulator: by hand
/// (see the report of the build).
final class SiriIntentsTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    private func text(_ relative: String) throws -> String {
        try String(contentsOf: iosRoot.appendingPathComponent(relative), encoding: .utf8)
    }

    /// The code of a file without its line comments.
    private func code(_ relative: String) throws -> String {
        try text(relative).components(separatedBy: "\n").map { $0.components(separatedBy: "//")[0] }.joined(separator: "\n")
    }

    /// Every shortcut declared in the provider: the intent it runs and the sentences of its `phrases: [ … ]`, as the literals say them.
    private func shortcuts() throws -> [(intent: String, phrases: [String])] {
        let source = try code("Mondrop/MondropShortcuts.swift")
        let blocks = try NSRegularExpression(pattern: #"AppShortcut\(\s*intent:\s*(\w+)\([^)]*\),\s*phrases:\s*\[(.*?)\]\s*,\s*shortTitle"#, options: [.dotMatchesLineSeparators])
        let literal = try NSRegularExpression(pattern: #""((?:[^"\\]|\\.)*)""#)
        var found: [(String, [String])] = []
        for block in blocks.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
            guard let intentRange = Range(block.range(at: 1), in: source), let range = Range(block.range(at: 2), in: source) else { continue }
            let inside = String(source[range])
            var phrases: [String] = []
            for match in literal.matches(in: inside, range: NSRange(inside.startIndex..., in: inside)) {
                if let r = Range(match.range(at: 1), in: inside) { phrases.append(String(inside[r])) }
            }
            found.append((String(source[intentRange]), phrases))
        }
        return found
    }

    private func phrases() throws -> [String] { try shortcuts().flatMap(\.phrases) }

    // MARK: the sentences

    func testEverySentenceNamesTheAppAndNoneIsDeclaredTwice() throws {
        let all = try phrases()
        XCTAssertGreaterThanOrEqual(all.count, 18, "the scan found the sentences: a moved file would turn this test into a test of nothing")
        for phrase in all {
            XCTAssertTrue(phrase.contains(#"\(.applicationName)"#), "«\(phrase)» does not name the app: Siri would not take it")
        }
        let normalized = all.map { $0.lowercased().trimmingCharacters(in: .whitespaces) }
        XCTAssertEqual(Set(normalized).count, normalized.count, "a sentence declared twice: \(normalized.filter { n in normalized.filter { $0 == n }.count > 1 })")
    }

    func testTheSentencesMicheleWillSayAreThere() throws {
        let all = try phrases().map { $0.lowercased() }
        for wanted in [
            "mi piace questa canzone su", "ripeti questo brano su", "non ripetere su", "non mi piace più questa canzone su", "ripeti tutto su",
            "metti la playlist", "metti un brano su",
        ] {
            XCTAssertTrue(all.contains { $0.hasPrefix(wanted) }, "«Ehi Siri, \(wanted) …» is not one of the sentences")
        }
    }

    func testTheSentencesCarryNoPunctuationAndOnlyTheNameOfTheAppOrAPlaylist() throws {
        for phrase in try phrases() {
            let plain = phrase.replacingOccurrences(of: #"\(.applicationName)"#, with: "").replacingOccurrences(of: #"\(\.$playlist)"#, with: "")
            XCTAssertFalse(plain.contains("\\("), "«\(phrase)»: only the name of the app and a playlist may be interpolated")
            XCTAssertFalse(plain.unicodeScalars.contains { "'’«»\"!?.,;:".unicodeScalars.contains($0) }, "«\(phrase)»: no punctuation in a sentence for Siri")
        }
    }

    func testOnlyThePlaylistSentencesCarryAParameterAndNeverFreeText() throws {
        // An App Shortcut sentence can carry an entity or an enum, never free text: a song is asked as an answer («Quale brano?»)
        for (intent, phrases) in try shortcuts() {
            for phrase in phrases where phrase.contains(#"\(\.$"#) {
                XCTAssertEqual(intent, "PlayPlaylistIntent", "«\(phrase)»: only a playlist, which Siri knows by name, may be in a sentence")
                XCTAssertEqual(phrase.components(separatedBy: #"\(\.$"#).count - 1, 1, "«\(phrase)»: one parameter at most in a sentence")
                XCTAssertTrue(phrase.contains(#"\(\.$playlist)"#), phrase)
            }
        }
        let playlistSentences = try shortcuts().first { $0.intent == "PlayPlaylistIntent" }?.phrases ?? []
        XCTAssertTrue(playlistSentences.allSatisfy { $0.contains(#"\(\.$playlist)"#) }, "a playlist sentence without the playlist would ask for it anyway")
        XCTAssertFalse(playlistSentences.isEmpty)
        let songSentences = try shortcuts().first { $0.intent == "PlaySongIntent" }?.phrases ?? []
        XCTAssertFalse(songSentences.isEmpty)
        XCTAssertTrue(songSentences.allSatisfy { !$0.replacingOccurrences(of: #"\(.applicationName)"#, with: "").contains(#"\("#) }, "the song is not in the sentence")
    }

    // MARK: where they run, and on what

    func testTheIntentsActOnTheInstancesTheAppUsesAndMakeNoCopy() throws {
        let intents = try code("Mondrop/MondropIntents.swift")
        for copy in ["LocalAudioPlayer(", "LikesStore(", "RemoteCommandLog(", "PlayRecorder(", "MPRemoteCommandCenter", "RepeatModeStore", "SearchModel(", "MondropAPI("] {
            XCTAssertFalse(intents.contains(copy), "the intents never make or touch their own «\(copy)»: the glue (VoiceActions) is the one place, with THE instances of the app")
        }
        XCTAssertGreaterThanOrEqual(intents.components(separatedBy: "VoiceActions.run(").count - 1, 3, "like, unlike and the loop")
        XCTAssertEqual(intents.components(separatedBy: "VoiceActions.playPlaylist(").count - 1, 1)
        XCTAssertEqual(intents.components(separatedBy: "VoiceActions.playSong(").count - 1, 1)
        let glue = try code("Mondrop/VoiceActions.swift")
        XCTAssertGreaterThanOrEqual(glue.components(separatedBy: "player: LocalAudioPlayer = .shared").count - 1, 2, "the default is THE player of the app")
        XCTAssertTrue(glue.contains("SearchModel("), "a song is searched with the model of Cerca")
        XCTAssertTrue(glue.contains("LibraryQueueBuilder.make("), "a playlist is queued by the builder the playlist screen uses")
        XCTAssertTrue(glue.contains("SearchPlayback.queue("), "a song is queued as a tap in Cerca queues it")
        XCTAssertFalse(glue.lowercased().contains("youtube"), "rule P: SoundReel only")
    }

    func testNoIntentOpensTheApp() throws {
        let intents = try code("Mondrop/MondropIntents.swift")
        let declared = try NSRegularExpression(pattern: #"struct \w+Intent: (AppIntent|AudioPlaybackIntent)"#).numberOfMatches(in: intents, range: NSRange(intents.startIndex..., in: intents))
        XCTAssertEqual(declared, 5, "like, unlike, the loop, a playlist, a song")
        XCTAssertEqual(intents.components(separatedBy: "openAppWhenRun = false").count - 1, declared, "Siri answers in the car, the app stays where it is")
        XCTAssertFalse(intents.contains("openAppWhenRun = true"))
    }

    func testThePlayIntentsStartAudioInTheBackgroundAndRunWithThePhoneLocked() throws {
        let intents = try code("Mondrop/MondropIntents.swift")
        XCTAssertTrue(intents.contains("struct PlayPlaylistIntent: AudioPlaybackIntent"), "iOS 17: the intent says it plays audio, so the system lets the app start it in the background")
        XCTAssertTrue(intents.contains("struct PlaySongIntent: AudioPlaybackIntent"))
        XCTAssertEqual(intents.components(separatedBy: "authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed").count - 1, 5,
                       "every intent runs without unlocking the phone: in the car it is locked")
        XCTAssertFalse(intents.contains("requiresAuthentication"))
        XCTAssertFalse(intents.contains("requiresLocalDeviceAuthentication"))
    }

    func testTheSongIsAskedAsAnAnswerAndTheSearchIsTheOneOfCerca() throws {
        let intents = try code("Mondrop/MondropIntents.swift")
        XCTAssertTrue(intents.contains(#"requestValueDialog: "Quale brano?""#))
        XCTAssertTrue(intents.contains(#"requestValueDialog: "Quale playlist?""#))
    }

    func testThePlaylistNamesComeFromWhatTheAppKnowsAndSiriIsToldWhenTheyChange() throws {
        let entity = try code("Mondrop/PlaylistEntity.swift")
        XCTAssertTrue(entity.contains("EntityStringQuery"), "Siri passes the spoken name to the query only for a string query")
        XCTAssertTrue(entity.contains("PlaylistCatalog.shared"))
        XCTAssertTrue(entity.contains("PlaylistMatcher.candidates("))
        XCTAssertTrue(try code("Mondrop/MondropApp.swift").contains("updateAppShortcutParameters()"), "Siri learns the names when the list changes")
        XCTAssertTrue(try code("Mondrop/InboxApp.swift").contains("PlaylistCatalog.shared.remember("), "fed where the app reads the whole list, at every opening")
        XCTAssertTrue(try code("Mondrop/PlaylistsView.swift").contains("PlaylistCatalog.shared.remember("))
    }

    func testOnlyTheAppTargetKnowsAppIntents() throws {
        // MondropKit and MondropShare are compiled into the Share extensions too: they must not pull the framework in
        for folder in ["MondropKit", "MondropShare"] {
            let dir = iosRoot.appendingPathComponent(folder)
            let files = (FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []).filter { $0.pathExtension == "swift" }
            XCTAssertFalse(files.isEmpty, folder)
            for file in files {
                XCTAssertFalse(try String(contentsOf: file, encoding: .utf8).contains("import AppIntents"), "\(folder)/\(file.lastPathComponent) imports AppIntents")
            }
        }
        for file in ["MondropIntents", "MondropShortcuts", "PlaylistEntity"] {
            XCTAssertTrue(try code("Mondrop/\(file).swift").contains("import AppIntents"), file)
        }
    }

    // MARK: the language

    func testItalianIsTheLanguageOfTheApp() throws {
        let project = try text("project.yml")
        XCTAssertTrue(project.contains("developmentLanguage: it"), "Siri takes the sentences of an app in the language the app is written in: the app is Italian")
        let plist = try text("Mondrop/Info.plist")
        XCTAssertTrue(plist.contains("<key>CFBundleLocalizations</key>"))
        XCTAssertTrue(plist.contains("<string>it</string>"))
    }

    // MARK: the loop asked as a parameter

    func testTheRepeatChoiceOfTheShortcutsMapsOneToOneToTheLoop() {
        XCTAssertEqual(RepeatModeOption.allCases.count, RepeatMode.allCases.count)
        XCTAssertEqual(RepeatModeOption.off.mode, .off)
        XCTAssertEqual(RepeatModeOption.all.mode, .all)
        XCTAssertEqual(RepeatModeOption.one.mode, .one)
        for option in RepeatModeOption.allCases { XCTAssertEqual(option.rawValue, option.mode.rawValue) }
    }

    func testEveryChoiceHasAWordForTheShortcutsApp() {
        for option in RepeatModeOption.allCases {
            XCTAssertNotNil(RepeatModeOption.caseDisplayRepresentations[option], "\(option)")
        }
    }

    // MARK: a playlist as Siri sees it

    func testAPlaylistEntityCarriesTheIdAndTheNameOfTheKnownPlaylist() {
        let entity = PlaylistEntity(KnownPlaylist(id: "pl9", name: "Road trip"))
        XCTAssertEqual(entity.id, "pl9")
        XCTAssertEqual(entity.name, "Road trip")
    }
}
