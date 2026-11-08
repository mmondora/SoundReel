import XCTest
@testable import Mondrop

/// The words of a song (ADR-0021, spec 2026-11-08-lyrics-from-the-internet-design.md L2, L8): the app asks SoundReel and nothing else,
/// keeps what it has seen (so a song shows its words offline), remembers «no words» for a day, and does not mistake an unreachable
/// server for an answer.
final class LyricsLoaderTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        continueAfterFailure = false
        dir = try TestSupport.tempDir("lyrics")
        StubURLProtocol.reset()
    }

    override func tearDown() {
        StubURLProtocol.reset()
        try? FileManager.default.removeItem(at: dir)
    }

    private final class Clock: @unchecked Sendable {
        var now = Date(timeIntervalSince1970: 1_800_000_000)
    }

    private let words = SongLyrics(text: "Prima riga\nSeconda riga", source: .internet)

    private func loader(_ script: [Result<SongLyrics?, Error>], clock: Clock = Clock()) -> (LyricsLoader, FakeLyricsTransport) {
        let transport = FakeLyricsTransport(script)
        return (LyricsLoader(transport: transport, directory: dir, now: { clock.now }), transport)
    }

    // MARK: asking and keeping

    func testTheWordsComeFromSoundReelAndAreKeptOnThePhone() async {
        let (first, transport) = loader([.success(words)])
        let found = await first.fetch(songKey: "a::b")
        XCTAssertEqual(found, words)
        XCTAssertEqual(transport.asked, ["a::b"])

        // A new loader (the app was closed) finds them without asking: the song shows its words offline.
        let (reopened, again) = loader([.failure(MondropAPIError.transport("offline"))])
        XCTAssertEqual(reopened.cached(songKey: "a::b"), words)
        let second = await reopened.fetch(songKey: "a::b")
        XCTAssertEqual(second, words)
        XCTAssertEqual(again.asked, [])
    }

    func testWhatIsKeptIsNeverAskedAgainHoweverOld() async {
        let clock = Clock()
        let (l, transport) = loader([.success(words)], clock: clock)
        _ = await l.fetch(songKey: "a::b")
        clock.now = clock.now.addingTimeInterval(400 * 24 * 3600)
        let found = await l.fetch(songKey: "a::b")
        XCTAssertEqual(found, words)
        XCTAssertEqual(transport.asked.count, 1)
    }

    func testAnInstrumentalIsKeptToo() async {
        let instrumental = SongLyrics(text: "", source: .internet, instrumental: true)
        let (l, transport) = loader([.success(instrumental)])
        _ = await l.fetch(songKey: "a::b")
        XCTAssertEqual(l.cached(songKey: "a::b"), instrumental)
        _ = await l.fetch(songKey: "a::b")
        XCTAssertEqual(transport.asked.count, 1)
    }

    // Spec L12: an answer «the transcript of the post» can be only a fragment, and the Internet may have the text tomorrow: it is not kept.
    func testATranscriptAnswerIsGivenButNotKeptSoItIsAskedAgain() async {
        let transcript = SongLyrics(text: "quello che dice il video", source: .transcript)
        let (l, transport) = loader([.success(transcript), .success(words)])
        let first = await l.fetch(songKey: "a::b")
        XCTAssertEqual(first, transcript, "the answer itself is given")
        XCTAssertNil(l.cached(songKey: "a::b"), "…but not kept: it can be a fragment")
        let second = await l.fetch(songKey: "a::b")
        XCTAssertEqual(second, words, "asked again: by now the server may have the text")
        XCTAssertEqual(transport.asked.count, 2)
        XCTAssertEqual(l.cached(songKey: "a::b"), words, "a text found is kept")
    }

    func testATranscriptKeptByAnEarlierBuildIsNotBelieved() async throws {
        // Build 10 kept every answer, transcripts included: such a file must not stop the app from asking.
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let old = SongLyrics(text: "frammento del post", source: .transcript)
        try JSONEncoder().encode(old).write(to: dir.appendingPathComponent(LyricsLoader.fileStem("a::b") + ".json"))
        let (l, transport) = loader([.success(words)])
        XCTAssertNil(l.cached(songKey: "a::b"))
        let found = await l.fetch(songKey: "a::b")
        XCTAssertEqual(found, words)
        XCTAssertEqual(transport.asked.count, 1)
    }

    // MARK: «no words»

    func testNoWordsIsRememberedForADayAndThenAskedAgain() async {
        let clock = Clock()
        let (l, transport) = loader([.success(nil), .success(words)], clock: clock)
        let first = await l.fetch(songKey: "a::b")
        XCTAssertNil(first)
        let sameDay = await l.fetch(songKey: "a::b")
        XCTAssertNil(sameDay)
        XCTAssertEqual(transport.asked.count, 1, "asked once: a song without words is not asked at every play")

        clock.now = clock.now.addingTimeInterval(LyricsLoader.missingTTL - 60)
        let almost = await l.fetch(songKey: "a::b")
        XCTAssertNil(almost)
        XCTAssertEqual(transport.asked.count, 1)

        clock.now = clock.now.addingTimeInterval(120)
        let nextDay = await l.fetch(songKey: "a::b")
        XCTAssertEqual(nextDay, words, "a day later the server may have found them")
        XCTAssertEqual(transport.asked.count, 2)
    }

    func testAnUnreachableServerIsNotAnAnswer() async {
        let (l, transport) = loader([.failure(MondropAPIError.transport("offline")), .success(words)])
        let offline = await l.fetch(songKey: "a::b")
        XCTAssertNil(offline)
        let back = await l.fetch(songKey: "a::b")
        XCTAssertEqual(back, words, "nothing was remembered about the failure: the next play asks again")
        XCTAssertEqual(transport.asked.count, 2)
    }

    func testAServerErrorIsNotAnAnswerEither() async {
        let (l, transport) = loader([.failure(MondropAPIError.http(500, "boom")), .success(words)])
        let broken = await l.fetch(songKey: "a::b")
        XCTAssertNil(broken)
        let fixed = await l.fetch(songKey: "a::b")
        XCTAssertEqual(fixed, words)
        XCTAssertEqual(transport.asked.count, 2)
    }

    func testANoWordsMarkFromTheFutureIsNotBelieved() async throws {
        let clock = Clock()
        let (l, transport) = loader([.success(nil), .success(words)], clock: clock)
        _ = await l.fetch(songKey: "a::b")
        clock.now = clock.now.addingTimeInterval(-3 * 24 * 3600)      // the phone's clock was set back
        let found = await l.fetch(songKey: "a::b")
        XCTAssertEqual(found, words)
        XCTAssertEqual(transport.asked.count, 2)
    }

    func testFindingWordsLaterClearsTheNoWordsMark() async {
        let clock = Clock()
        let (l, _) = loader([.success(nil), .success(words)], clock: clock)
        _ = await l.fetch(songKey: "a::b")
        clock.now = clock.now.addingTimeInterval(LyricsLoader.missingTTL + 1)
        _ = await l.fetch(songKey: "a::b")
        XCTAssertEqual(l.cached(songKey: "a::b"), words)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent(LyricsLoader.fileStem("a::b") + ".none").path))
    }

    func testTwoScreensAskingForTheSameSongShareOneQuestion() async {
        let transport = FakeLyricsTransport([.success(words)], held: true)
        let l = LyricsLoader(transport: transport, directory: dir, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        async let one = l.fetch(songKey: "a::b")
        for _ in 0..<200 where transport.asked.isEmpty { await Task.yield() }          // the first question is on its way, held
        async let two = l.fetch(songKey: "a::b")
        for _ in 0..<50 { await Task.yield() }                                          // the second arrives while the first waits
        transport.release()
        let both = await [one, two]
        XCTAssertEqual(both, [words, words])
        XCTAssertEqual(transport.asked, ["a::b"], "the second caller waited for the first one's answer: one question, not two")
    }

    func testEachSongHasItsOwnWords() async {
        let other = SongLyrics(text: "Altro testo ancora più lungo", source: .internet)
        let (l, _) = loader([.success(words), .success(other)])
        _ = await l.fetch(songKey: "a::b")
        _ = await l.fetch(songKey: "c::d")
        XCTAssertEqual(l.cached(songKey: "a::b"), words)
        XCTAssertEqual(l.cached(songKey: "c::d"), other)
    }

    func testAKeyThatIsNotAFileNameIsStillAFile() async {
        let (l, _) = loader([.success(words)])
        _ = await l.fetch(songKey: "ac/dc::back in black ../../etc?#")
        XCTAssertEqual(l.cached(songKey: "ac/dc::back in black ../../etc?#"), words)
        XCTAssertFalse(LyricsLoader.fileStem("ac/dc::x").contains("/"))
    }

    func testAnUnreadableFileIsNoWordsNotACrash() async throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: dir.appendingPathComponent(LyricsLoader.fileStem("a::b") + ".json"))
        let (l, transport) = loader([.success(words)])
        XCTAssertNil(l.cached(songKey: "a::b"))
        let found = await l.fetch(songKey: "a::b")
        XCTAssertEqual(found, words)
        XCTAssertEqual(transport.asked.count, 1)
    }

    // MARK: the call itself

    private func api() -> MondropAPI {
        MondropAPI(session: StubURLProtocol.session(), config: { MondropAPIConfig(baseURL: "https://soundreel.test/", apiKey: "sr_test_key_0123456789abcdef", user: "mike") })
    }

    private func json(_ text: String, status: Int = 200) -> (Int, Data) { (status, Data(text.utf8)) }

    func testTheCallAsksSoundReelForThePathOfThatSongAndReadsTheAnswer() async throws {
        StubURLProtocol.handler = { _ in self.json(#"{"songKey":"bishop briggs::white flag","lyrics":"I'm burning","source":"internet","instrumental":false}"#) }
        let found = try await api().lyrics(songKey: "bishop briggs::white flag")
        XCTAssertEqual(found, SongLyrics(text: "I'm burning", source: .internet))
        let request = try XCTUnwrap(StubURLProtocol.captured.last?.request)
        XCTAssertEqual(request.httpMethod, "GET")
        let url = try XCTUnwrap(request.url)
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath, "/api/mondrop/songs/bishop%20briggs%3A%3Awhite%20flag/lyrics")
        XCTAssertEqual(url.host, "soundreel.test", "only SoundReel is asked")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-SoundReel-Key"), "sr_test_key_0123456789abcdef")
    }

    func testTheTranscriptAndTheInstrumentalAreReadToo() async throws {
        StubURLProtocol.handler = { _ in self.json(#"{"songKey":"a::b","lyrics":"quello che dice il video","source":"transcript","instrumental":false}"#) }
        let transcript = try await api().lyrics(songKey: "a::b")
        XCTAssertEqual(transcript?.source, .transcript)
        StubURLProtocol.handler = { _ in self.json(#"{"songKey":"a::b","lyrics":"","source":"internet","instrumental":true}"#) }
        let instrumental = try await api().lyrics(songKey: "a::b")
        XCTAssertEqual(instrumental, SongLyrics(text: "", source: .internet, instrumental: true))
    }

    func testBothKindsOf404AreNoWordsAndAnythingElseIsAnError() async throws {
        StubURLProtocol.handler = { _ in self.json(#"{"error":"no lyrics"}"#, status: 404) }
        let none = try await api().lyrics(songKey: "a::b")
        XCTAssertNil(none)
        StubURLProtocol.handler = { _ in self.json(#"{"error":"song not found"}"#, status: 404) }
        let unknown = try await api().lyrics(songKey: "a::b")
        XCTAssertNil(unknown)
        StubURLProtocol.handler = { _ in self.json(#"{"error":"lyrics failed"}"#, status: 500) }
        do {
            _ = try await api().lyrics(songKey: "a::b")
            XCTFail("a server error is an error, not «no words»")
        } catch let error as MondropAPIError {
            XCTAssertEqual(error, .http(500, #"{"error":"lyrics failed"}"#))
        }
    }

    func testAnAnswerWithNoWordsAndNotInstrumentalIsNoWords() async throws {
        StubURLProtocol.handler = { _ in self.json(#"{"songKey":"a::b","lyrics":"  \n ","source":"internet","instrumental":false}"#) }
        let blank = try await api().lyrics(songKey: "a::b")
        XCTAssertNil(blank)
        StubURLProtocol.handler = { _ in self.json(#"{"songKey":"a::b"}"#) }
        let missing = try await api().lyrics(songKey: "a::b")
        XCTAssertNil(missing)
    }

    func testAnUnknownSourceIsReadAsTheInternet() async throws {
        StubURLProtocol.handler = { _ in self.json(#"{"songKey":"a::b","lyrics":"parole parole parole","source":"something new"}"#) }
        let found = try await api().lyrics(songKey: "a::b")
        XCTAssertEqual(found?.source, .internet)
    }
}

/// Rule P (ADR-0018, ADR-0021): the app asks SoundReel for the words of a song and never an archive of lyrics. A plain text scan of the sources.
final class LyricsRuleTests: XCTestCase {
    func testTheAppNeverNamesAnArchiveOfLyrics() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        var scanned = 0
        for directory in ["Mondrop", "MondropKit", "MondropShare"] {
            guard let walker = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil) else { continue }
            for case let file as URL in walker where file.pathExtension == "swift" {
                scanned += 1
                let text = try String(contentsOf: file, encoding: .utf8).lowercased()
                for banned in ["lrclib", "genius.com", "musixmatch", "lyrics.ovh", "azlyrics"] {
                    XCTAssertFalse(text.contains(banned), "\(file.lastPathComponent): «\(banned)» — the SERVER finds the words, the app asks SoundReel")
                }
            }
        }
        XCTAssertGreaterThan(scanned, 40, "the scan must really read the sources")
    }
}
