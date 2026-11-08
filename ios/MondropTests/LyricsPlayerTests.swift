import XCTest
@testable import Mondrop

/// The player and the words of a song (ADR-0021, spec 2026-11-08-lyrics-from-the-internet-design.md L1, L8): what the user typed wins, then
/// what the phone has, then what SoundReel finds; a song that changed meanwhile never takes the words of another.
@MainActor
final class LyricsPlayerTests: XCTestCase {
    private var dir: URL!
    private var defaults: UserDefaults!
    private var suite = ""
    private let words = SongLyrics(text: "Prima riga del testo\nSeconda riga del testo", source: .internet)

    override func setUpWithError() throws {
        continueAfterFailure = false
        dir = try TestSupport.tempDir("lyrics-player")
        suite = "mondrop.test.lyrics.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    private func make(_ transport: FakeLyricsTransport, store: OfflineStore? = nil) -> (player: LocalAudioPlayer, loader: LyricsLoader, store: OfflineStore) {
        let offline = store ?? OfflineStore(root: dir.appendingPathComponent("offline"))
        let loader = LyricsLoader(transport: transport, directory: dir.appendingPathComponent("lyrics"))
        let player = LocalAudioPlayer(
            store: offline, api: FakeAPI(), recorder: nil,
            snapshots: QueueSnapshotStore(directory: dir, defaults: defaults, positionKey: "position"), lyricsLoader: loader
        )
        return (player, loader, offline)
    }

    private func item(_ key: String, lyrics: String? = nil) -> QueueItem {
        QueueItem(songKey: key, title: "t-\(key)", artist: "a", lyrics: lyrics)
    }

    /// Lets the asking tasks run: until the condition holds (or a second has passed).
    private func settle(_ condition: @MainActor () -> Bool) async {
        for _ in 0..<500 where !condition() {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }

    // MARK: what SoundReel finds

    func testASongWithoutWordsAsksSoundReelAndShowsWhatItFinds() async {
        let transport = FakeLyricsTransport([.success(words)])
        let (player, _, _) = make(transport)
        player.setQueue([item("a::b")], startAt: 0, autoplay: false)
        await settle { player.lyricsOrigin == .internet }
        XCTAssertEqual(player.lyrics, words.text)
        XCTAssertEqual(player.lyricsOrigin, .internet)
        XCTAssertFalse(player.lyricsSearching)
        XCTAssertEqual(transport.asked, ["a::b"])
    }

    func testWhileItAsksTheSheetCanSaySo() async {
        let transport = FakeLyricsTransport([.success(words)], held: true)
        let (player, _, _) = make(transport)
        player.setQueue([item("a::b")], startAt: 0, autoplay: false)
        XCTAssertTrue(player.lyricsSearching, "«Cerco il testo…» while SoundReel is being asked")
        XCTAssertEqual(player.lyrics, "")
        XCTAssertEqual(player.lyricsOrigin, .none)
        transport.release()
        await settle { player.lyricsOrigin == .internet }
        XCTAssertFalse(player.lyricsSearching)
    }

    func testTheTranscriptSoundReelHasIsSaidToBeTheTranscript() async {
        let transport = FakeLyricsTransport([.success(SongLyrics(text: "quello che dice il video", source: .transcript))])
        let (player, _, _) = make(transport)
        player.setQueue([item("a::b")], startAt: 0, autoplay: false)
        await settle { player.lyricsOrigin == .transcript }
        XCTAssertEqual(player.lyrics, "quello che dice il video")
    }

    func testAnInstrumentalIsSaidAndHasNoWords() async {
        let transport = FakeLyricsTransport([.success(SongLyrics(text: "", source: .internet, instrumental: true))])
        let (player, _, _) = make(transport)
        player.setQueue([item("a::b")], startAt: 0, autoplay: false)
        await settle { player.lyricsOrigin == .instrumental }
        XCTAssertEqual(player.lyrics, "")
        XCTAssertFalse(player.lyricsSearching)
    }

    func testNoWordsLeavesNothingAndStopsSearching() async {
        let transport = FakeLyricsTransport([.success(nil)])
        let (player, _, _) = make(transport)
        player.setQueue([item("a::b")], startAt: 0, autoplay: false)
        await settle { !player.lyricsSearching && !transport.asked.isEmpty }
        XCTAssertEqual(player.lyricsOrigin, .none)
        XCTAssertEqual(player.lyrics, "")
    }

    func testAnUnreachableServerLeavesNoWordsAndTheNextPlayAsksAgain() async {
        let transport = FakeLyricsTransport([.failure(MondropAPIError.transport("offline")), .success(words)])
        let (player, _, _) = make(transport)
        player.setQueue([item("a::b")], startAt: 0, autoplay: false)
        await settle { !player.lyricsSearching && !transport.asked.isEmpty }
        XCTAssertEqual(player.lyricsOrigin, .none)
        player.setQueue([item("a::b")], startAt: 0, autoplay: false)        // the song comes up again
        await settle { player.lyricsOrigin == .internet }
        XCTAssertEqual(player.lyrics, words.text)
        XCTAssertEqual(transport.asked.count, 2)
    }

    // MARK: what the phone already has

    func testWhatTheUserTypedWinsAndNothingIsAsked() async {
        let transport = FakeLyricsTransport([.success(words)])
        let (player, _, store) = make(transport)
        store.saveLyrics(songKey: "a::b", text: "il mio testo")
        player.setQueue([item("a::b")], startAt: 0, autoplay: false)
        XCTAssertEqual(player.lyrics, "il mio testo")
        XCTAssertEqual(player.lyricsOrigin, .typed)
        XCTAssertFalse(player.lyricsSearching)
        await settle { !transport.asked.isEmpty }
        XCTAssertEqual(transport.asked, [])
    }

    func testTheWordsTheSyncBroughtAreTheTranscriptAndNothingIsAsked() async {
        let transport = FakeLyricsTransport([.success(words)])
        let (player, _, _) = make(transport)
        player.setQueue([item("a::b", lyrics: "la trascrizione del post")], startAt: 0, autoplay: false)
        XCTAssertEqual(player.lyrics, "la trascrizione del post")
        XCTAssertEqual(player.lyricsOrigin, .transcript)
        await settle { !transport.asked.isEmpty }
        XCTAssertEqual(transport.asked, [])
    }

    func testWhatThePhoneKeptOfAnEarlierFindIsThereAtOnceAndOffline() async {
        let first = FakeLyricsTransport([.success(words)])
        let (_, loader, _) = make(first)
        _ = await loader.fetch(songKey: "a::b")                                   // an earlier find, kept in Caches
        let offline = FakeLyricsTransport([.failure(MondropAPIError.transport("offline"))])
        let (player, _, _) = make(offline)
        player.setQueue([item("a::b")], startAt: 0, autoplay: false)
        XCTAssertEqual(player.lyrics, words.text, "no waiting: the song starts with its words")
        XCTAssertEqual(player.lyricsOrigin, .internet)
        XCTAssertFalse(player.lyricsSearching)
        XCTAssertEqual(offline.asked, [])
    }

    // MARK: races

    func testASongThatChangedMeanwhileNeverTakesTheWordsOfAnother() async {
        let other = SongLyrics(text: "Le parole dell'altra canzone", source: .internet)
        let transport = FakeLyricsTransport([.success(words), .success(other)], held: true)
        let (player, _, _) = make(transport)
        player.setQueue([item("a::b"), item("c::d")], startAt: 0, autoplay: false)       // asks for a::b, held
        player.setQueue([item("a::b"), item("c::d")], startAt: 1, autoplay: false)       // the user skipped: asks for c::d, held
        transport.release()
        await settle { !player.lyricsSearching && player.lyricsOrigin != .none }
        XCTAssertEqual(player.currentSongKey, "c::d")
        XCTAssertEqual(player.lyrics, other.text)
        XCTAssertNotEqual(player.lyrics, words.text)
    }

    func testWordsTypedWhileSoundReelIsBeingAskedStay() async {
        let transport = FakeLyricsTransport([.success(words)], held: true)
        let (player, _, _) = make(transport)
        player.setQueue([item("a::b")], startAt: 0, autoplay: false)
        player.setLyrics("scritto mentre aspettavo")
        XCTAssertFalse(player.lyricsSearching)
        transport.release()
        for _ in 0..<50 { await Task.yield() }
        XCTAssertEqual(player.lyrics, "scritto mentre aspettavo")
        XCTAssertEqual(player.lyricsOrigin, .typed)
    }

    func testTypingAndClearingTheWordsChangesTheOrigin() {
        let (player, _, store) = make(FakeLyricsTransport([.success(nil)]))
        player.setQueue([item("a::b")], startAt: 0, autoplay: false)
        player.setLyrics("scritto")
        XCTAssertEqual(player.lyricsOrigin, .typed)
        XCTAssertEqual(store.lyrics(for: "a::b"), "scritto")
        XCTAssertTrue(store.hasTypedLyrics(for: "a::b"))
        player.setLyrics("")
        XCTAssertEqual(player.lyricsOrigin, .none)
        XCTAssertFalse(store.hasTypedLyrics(for: "a::b"))
    }
}
