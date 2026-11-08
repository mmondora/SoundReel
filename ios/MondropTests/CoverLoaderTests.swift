import XCTest
@testable import Mondrop

/// The cover of the song playing (ADR-0019): SoundReel finds it, the app asks SoundReel only and keeps what it has seen.
final class CoverLoaderTests: XCTestCase {
    private let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 2, 3, 4, 5, 0xFF, 0xD9])
    private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4, 5, 6])
    private var dir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        StubURLProtocol.reset()
        dir = try TestSupport.tempDir("covers")
    }

    override func tearDown() {
        StubURLProtocol.reset()
        try? FileManager.default.removeItem(at: dir)
        super.tearDown()
    }

    private func loader(base: String = "https://soundreel.test/", key: String = "sr_test_key_0123456789abcdef") -> CoverLoader {
        CoverLoader(
            session: StubURLProtocol.session(),
            config: { MondropAPIConfig(baseURL: base, apiKey: key, user: "mike") },
            directory: dir
        )
    }

    private func answer(_ status: Int, _ body: Data = Data()) {
        StubURLProtocol.handler = { _ in (status, body) }
    }

    private var requests: [URLRequest] { StubURLProtocol.captured.map(\.request) }

    // MARK: asking SoundReel

    func testItAsksSoundReelForTheCoverWithTheKeyAndNothingElse() async throws {
        answer(200, jpeg)
        let data = await loader().data(songKey: "bassi maestro::capirai", coverPath: "/api/mondrop/songs/bassi%20maestro%3A%3Acapirai/cover")
        XCTAssertEqual(data, jpeg)
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.absoluteString, "https://soundreel.test/api/mondrop/songs/bassi%20maestro%3A%3Acapirai/cover")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-SoundReel-Key"), "sr_test_key_0123456789abcdef")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-SoundReel-User"), "mike")
        XCTAssertEqual(requests.count, 1, "one request; never a provider's address")
    }

    func testWithoutAPathFromTheServerItAsksTheCanonicalOne() async throws {
        answer(200, png)
        _ = await loader().data(songKey: "a::b/c", coverPath: nil)
        XCTAssertEqual(requests.first?.url?.absoluteString, "https://soundreel.test/api/mondrop/songs/a%3A%3Ab%2Fc/cover", "the key cannot break out of its path segment")
    }

    func testAnAbsoluteAddressInThePathIsIgnoredSoTheKeyNeverLeavesSoundReel() async throws {
        answer(200, jpeg)
        let hostile = ["https://evil.test/cover.jpg", "//evil.test/cover.jpg", "http://192.0.2.1/x"]
        for (n, path) in hostile.enumerated() {
            _ = await loader().data(songKey: "a::b\(n)", coverPath: path)      // another song each time: the phone's copy would answer otherwise
        }
        XCTAssertEqual(requests.count, 3)
        for (n, request) in requests.enumerated() {
            XCTAssertEqual(request.url?.host, "soundreel.test")
            XCTAssertEqual(request.url?.path, "/api/mondrop/songs/a::b\(n)/cover")
        }
    }

    func testAPathWithoutALeadingSlashIsFixed() async {
        answer(200, jpeg)
        _ = await loader().data(songKey: "a::b", coverPath: "api/mondrop/songs/a%3A%3Ab/cover")
        XCTAssertEqual(requests.first?.url?.absoluteString, "https://soundreel.test/api/mondrop/songs/a%3A%3Ab/cover")
    }

    func testNoKeyNoRequest() async {
        answer(200, jpeg)
        let data = await loader(key: "  ").data(songKey: "a::b", coverPath: nil)
        XCTAssertNil(data)
        XCTAssertTrue(requests.isEmpty)
    }

    // MARK: what the phone keeps

    func testTheCoverIsKeptOnThePhone_ASecondAskNeedsNoNetwork() async {
        answer(200, jpeg)
        let first = loader()
        _ = await first.data(songKey: "a::b", coverPath: nil)
        XCTAssertEqual(first.cached(songKey: "a::b"), jpeg)

        _ = await first.data(songKey: "a::b", coverPath: nil)
        XCTAssertEqual(requests.count, 1, "from memory")

        // a new start of the app: only the disk is left, and the network is gone
        StubURLProtocol.handler = nil
        let restarted = loader()
        XCTAssertEqual(restarted.cached(songKey: "a::b"), jpeg, "offline: the downloaded song still has its cover")
        let again = await restarted.data(songKey: "a::b", coverPath: nil)
        XCTAssertEqual(again, jpeg)
        XCTAssertEqual(requests.count, 1)
    }

    func testEverySongHasItsOwnCopy() async {
        answer(200, jpeg)
        let l = loader()
        _ = await l.data(songKey: "a::one", coverPath: nil)
        answer(200, png)
        _ = await l.data(songKey: "a::two", coverPath: nil)
        XCTAssertEqual(l.cached(songKey: "a::one"), jpeg)
        XCTAssertEqual(l.cached(songKey: "a::two"), png)
        XCTAssertNotEqual(CoverLoader.fileName("a::one"), CoverLoader.fileName("a::two"))
        XCTAssertEqual(CoverLoader.fileName("a::one"), CoverLoader.fileName("a::one"))
        XCTAssertFalse(CoverLoader.fileName("../../etc/passwd").contains("/"))
    }

    func testOnlyTheLastCoversStayInMemory() async {
        answer(200, jpeg)
        let l = loader()
        for n in 0..<(CoverLoader.memoryLimit + 6) { _ = await l.data(songKey: "a::\(n)", coverPath: nil) }
        // the oldest ones are not in memory any more but the disk still has them: no network needed
        StubURLProtocol.handler = nil
        let before = requests.count
        XCTAssertEqual(l.cached(songKey: "a::0"), jpeg)
        XCTAssertEqual(requests.count, before)
    }

    // MARK: when there is no cover

    func testNoCoverOnTheServerIsAskedOnceAndThenLeftAlone() async {
        answer(404, Data(#"{"error":"no cover"}"#.utf8))
        let l = loader()
        let first = await l.data(songKey: "a::b", coverPath: nil)
        let second = await l.data(songKey: "a::b", coverPath: nil)
        XCTAssertNil(first)
        XCTAssertNil(second)
        XCTAssertEqual(requests.count, 1, "not asked again in the same session")

        // a new start asks again: the server may have found one since (and answers fast: it remembers «no cover» itself)
        answer(200, jpeg)
        let restarted = loader()
        let found = await restarted.data(songKey: "a::b", coverPath: nil)
        XCTAssertEqual(found, jpeg)
    }

    func testAnAnswerThatIsNotAnImageIsNotACover() async {
        answer(200, Data("<html>Accedi per continuare</html>".utf8))
        let l = loader()
        let awaited = await l.data(songKey: "a::b", coverPath: nil)
        XCTAssertNil(awaited)
        XCTAssertNil(l.cached(songKey: "a::b"))
        // not remembered as «none»: the next ask goes out again
        answer(200, jpeg)
        let again = await l.data(songKey: "a::b", coverPath: nil)
        XCTAssertEqual(again, jpeg)
    }

    func testAHiccupOfTheServerOrTheNetworkIsNotRememberedAsNoCover() async {
        let l = loader()
        for status in [500, 502, 401, 429] {
            answer(status)
            let awaited = await l.data(songKey: "a::b", coverPath: nil)
            XCTAssertNil(awaited, "\(status)")
        }
        answer(200, jpeg)
        let awaited = await l.data(songKey: "a::b", coverPath: nil)
        XCTAssertEqual(awaited, jpeg, "and it works as soon as the server does")
    }

    func testTwoAsksAtTheSameTimeMakeOneRequest() async {
        answer(200, jpeg)
        let l = loader()
        async let a = l.data(songKey: "a::b", coverPath: nil)
        async let b = l.data(songKey: "a::b", coverPath: nil)
        let (first, second) = await (a, b)
        XCTAssertEqual(first, jpeg)
        XCTAssertEqual(second, jpeg)
        XCTAssertEqual(requests.count, 1)
    }

    func testAFileOnTheDiskThatIsNotAnImageIsIgnored() async throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("garbage".utf8).write(to: dir.appendingPathComponent(CoverLoader.fileName("a::b")))
        XCTAssertNil(loader().cached(songKey: "a::b"))
    }

    // MARK: what is an image

    func testItKnowsAnImageByItsFirstBytes() {
        XCTAssertTrue(CoverLoader.looksLikeImage(jpeg))
        XCTAssertTrue(CoverLoader.looksLikeImage(png))
        XCTAssertTrue(CoverLoader.looksLikeImage(Data("GIF89a......".utf8)))
        XCTAssertTrue(CoverLoader.looksLikeImage(Data("RIFF....WEBPVP8 ".utf8)))
        XCTAssertFalse(CoverLoader.looksLikeImage(Data("{\"error\":\"no cover\"}".utf8)))
        XCTAssertFalse(CoverLoader.looksLikeImage(Data()))
    }

    // MARK: the contract

    func testATrackCarriesTheCoverPathAndAnOlderServerSendsNone() throws {
        let with = try JSONDecoder().decode(
            OfflineTrack.self,
            from: Data(#"{"songKey":"a::b","title":"B","artist":"A","coverUrl":"https://cdn.test/x.jpg","coverPath":"/api/mondrop/songs/a%3A%3Ab/cover"}"#.utf8)
        )
        XCTAssertEqual(with.coverPath, "/api/mondrop/songs/a%3A%3Ab/cover")
        XCTAssertEqual(QueueItem(track: with).coverPath, "/api/mondrop/songs/a%3A%3Ab/cover")

        let without = try JSONDecoder().decode(OfflineTrack.self, from: Data(#"{"songKey":"a::b","title":"B","artist":"A"}"#.utf8))
        XCTAssertNil(without.coverPath)

        // it survives the queue file (the download queue and the offline index are JSON)
        let again = try JSONDecoder().decode(OfflineTrack.self, from: JSONEncoder().encode(with))
        XCTAssertEqual(again.coverPath, with.coverPath)
    }
}
