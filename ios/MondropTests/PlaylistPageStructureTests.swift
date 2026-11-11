import XCTest
@testable import Mondrop

/// The shape of the playlist screens after «Voglio in tutte le playlist anche degli ordinamenti tipo : data di creazione, nome, stato ( locali o online ). Inoltre su una playlist voglio
/// anche il bottone 'scarica tutta'» (Michele, 11 November, after build 18; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md §12, U17–U20). The logic is tested
/// where it lives (`SongSortTests`, `PlaylistStateSortTests`, `PlaylistDownloadStateTests`, `PlaylistDownloadAllTests`); this checks that the screens use it.
final class PlaylistPageStructureTests: XCTestCase {
    /// The source with the line comments left out (a comment that names a thing is not the thing).
    private func code(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let text = try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
        return text.components(separatedBy: "\n").map { $0.components(separatedBy: "//")[0] }.joined(separator: "\n")
    }

    private func count(_ needle: String, in text: String) -> Int { text.components(separatedBy: needle).count - 1 }

    private func pageBody() throws -> String {
        try XCTUnwrap(try code("Mondrop/PlaylistsView.swift").components(separatedBy: "struct PlaylistOfflineView: View {").last)
    }

    // MARK: U17 — the list of playlists

    func testTheListOfPlaylistsKeepsTheSortThatWasChosenAndOffersEveryOne() throws {
        let list = try code("Mondrop/PlaylistsView.swift")
        XCTAssertTrue(list.contains("PlaylistListModel(transport: transport, preferences: SortPreferences(defaults: Settings.shared.storage))"), "the choice is kept between launches")
        XCTAssertTrue(list.contains("ForEach(PlaylistSort.allCases) { Text($0.title).tag($0) }"), "the menu offers every sort, «Stato» included")
    }

    func testTheHomeStillPutsThePhoneFirstItsRowsAreNotSortable() throws {
        let home = try code("Mondrop/HomeView.swift")
        XCTAssertTrue(home.contains("marks.ordered("))
        XCTAssertFalse(home.contains("PlaylistSort"))
        XCTAssertFalse(home.contains("SongSort"))
    }

    // MARK: U18 — the songs of a playlist

    func testThePageOfAPlaylistHasTheMenuOfTheOrderOfItsSongsAndKeepsTheChoice() throws {
        let page = try pageBody()
        XCTAssertTrue(page.contains("Picker(\"Ordina per\""))
        XCTAssertTrue(page.contains("ForEach(SongSort.available(for: manifest.tracks))"), "«Data di aggiunta» only when SoundReel said when the songs were added")
        XCTAssertEqual(count("SortPreferences(defaults: Settings.shared.storage).songs = (songSort, songOrder)", in: page), 2, "choosing a sort and flipping its direction are both kept")
        XCTAssertTrue(page.contains("let saved = SortPreferences(defaults: Settings.shared.storage).songs"), "and the page opens on the choice that was kept")
        XCTAssertTrue(page.contains("manifest.tracks.count > 1"), "a list of one song has nothing to order")
    }

    // MARK: U20 — «Scarica tutta»

    func testThePageOfAPlaylistHasSuonaMescolaAndScaricaTuttaOnOneLineWithOnlyIcons() throws {
        // «I bottoni devono stare sulla strada riga. Piuttosto metti solo icona.» (Michele, 11 November, seeing build 19; «strada» is his typo for «stessa»)
        let page = try pageBody()
        let playAt = try XCTUnwrap(page.range(of: "playRow(manifest)"))
        let listAt = try XCTUnwrap(page.range(of: "Section {\n                    ForEach(arranged(manifest))"))
        XCTAssertLessThan(playAt.lowerBound, listAt.lowerBound, "the three buttons come before the songs")
        XCTAssertFalse(page.contains("downloadRow"), "no second row for «Scarica tutta»")
        let row = try XCTUnwrap(page.components(separatedBy: "private func playRow(").last?.components(separatedBy: "private func downloadButton(").first)
        XCTAssertTrue(row.contains("downloadButton(manifest)"), "«Scarica tutta» is in the same line as «Suona» and «Mescola»")
        XCTAssertEqual(count("HStack(", in: row), 1, "one line")
        XCTAssertEqual(count(".labelStyle(.iconOnly)", in: page), 3, "icons only: «Suona», «Mescola» and «Scarica tutta» keep their words for VoiceOver")
        XCTAssertFalse(page.contains(".labelStyle(.titleAndIcon)"))
        XCTAssertEqual(count("MondropIconPillStyle(prominent:", in: page), 3)
        XCTAssertTrue(page.contains("Button { download.start() }"))
        XCTAssertTrue(page.contains("PlaylistDownloadState.make("), "what it says, and whether it is there, is pure code")
        XCTAssertTrue(page.contains("if state.kind != .none {"), "no button when there is nothing that could come")
        XCTAssertTrue(page.contains(".accessibilityLabel([state.title, state.detail].compactMap { $0 }.joined(separator: \": \"))"), "what it would bring is said to VoiceOver, since the line has no room for it")
    }

    func testTheIconButtonsAreTheSizeOfAFingerAndKeepTheColoursOfThePills() throws {
        let buttons = try code("Mondrop/MondropButtons.swift")
        let icon = try XCTUnwrap(buttons.components(separatedBy: "struct MondropIconPillStyle: ButtonStyle {").last)
        XCTAssertTrue(icon.contains(".frame(minWidth: 64, minHeight: 44)"), "44 points: the smallest target a finger hits")
        XCTAssertTrue(icon.contains("Color(MondropPalette.onAccent)"), "black on the yellow, like the pills (a white icon on the yellow is 1.4:1)")
        XCTAssertTrue(icon.contains("Color(MondropPalette.accent)"))
    }

    func testTheQuestionOverTheLimitComesOverThePageAndGoesAwayWithIt() throws {
        let page = try pageBody()
        XCTAssertTrue(page.contains(".syncSizeDialog(questions)"))
        XCTAssertTrue(page.contains(".onDisappear { questions.withdraw() }"), "a question left open on a page that is gone would keep a sync waiting for ever")
        let host = try code("Mondrop/PlayingSyncHost.swift")
        XCTAssertTrue(host.contains("func syncSizeDialog(_ presenter: SizeQuestionPresenter) -> some View"))
    }

    func testThePageReadsTheListAgainWhenTheDownloadEnds() throws {
        let page = try pageBody()
        XCTAssertTrue(page.contains(".onChange(of: download.working) { _, working in"))
        XCTAssertTrue(page.contains("if !working { Task { await model.load() } }"))
    }

    func testTheDownloadAskedOnAPageIsAnnouncedBecauseThePersonAskedForIt() throws {
        let runner = try code("MondropKit/PlaylistDownloadAll.swift")
        XCTAssertTrue(runner.contains("origin: .sync"), "«Sync finito» with the app closed: the playlist that plays downloads in silence, this does not")
        XCTAssertTrue(runner.contains("declines: SyncDeclines()"), "an «Annulla» belongs to this press, not to the next ones")
    }

    func testTheSettingsSayWhatScaricaTuttaIs() throws {
        let settings = try code("Mondrop/SettingsView.swift")
        XCTAssertTrue(settings.contains("la freccia in giù («Scarica tutta») è la tua richiesta"), "the button is an icon: the Settings say which one it is")
        XCTAssertTrue(settings.contains("i brani che hai tolto dal telefono restano fuori e hanno «Riscarica»"))
    }

    func testThePageStillHasNoSyncButton() throws {
        // the sync is automatic; the one button on a page is «Scarica tutta», which says what it does
        let page = try pageBody()
        for gone in ["model.sync()", "Label(\"Sync\"", "Button(\"Sync\")"] {
            XCTAssertFalse(page.contains(gone), gone)
        }
    }
}
