import XCTest
@testable import Mondrop

/// The small picture of a reel (spec 2026-11-12-mondrop-home-play-loop-reels-design.md M5): the app asks SoundReel for it — only SoundReel — and keeps what it has seen in the system caches
/// (iOS empties them when it needs the room), so a list that scrolls does not ask again. Nothing of a reel is kept anywhere else on the phone.
final class ReelImageLoaderTests: XCTestCase {
    private let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 2, 3, 4, 5, 0xFF, 0xD9])
    private var dir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        StubURLProtocol.reset()
        dir = try TestSupport.tempDir("reel-images")
    }

    override func tearDown() {
        StubURLProtocol.reset()
        try? FileManager.default.removeItem(at: dir)
        super.tearDown()
    }

    private func loader(key: String = "sr_test_key_0123456789abcdef") -> ReelImageLoader {
        ReelImageLoader(
            session: StubURLProtocol.session(),
            config: { MondropAPIConfig(baseURL: "https://soundreel.test/", apiKey: key, user: "mike") },
            directory: dir
        )
    }

    private var requests: [URLRequest] { StubURLProtocol.captured.map(\.request) }

    // MARK: the path

    func testWithoutAPathFromTheServerItAsksTheRouteOfTheReel() {
        XCTAssertEqual(ReelImageLoader.path(reelId: "r1", imagePath: nil), "/api/mondrop/reels/r1/image")
        XCTAssertEqual(ReelImageLoader.path(reelId: "r1", imagePath: "  "), "/api/mondrop/reels/r1/image")
    }

    func testThePathTheServerSendsIsUsedAndFixedWhenItHasNoSlash() {
        XCTAssertEqual(ReelImageLoader.path(reelId: "r1", imagePath: "/api/mondrop/reels/r1/image"), "/api/mondrop/reels/r1/image")
        XCTAssertEqual(ReelImageLoader.path(reelId: "r1", imagePath: "api/mondrop/reels/r1/image"), "/api/mondrop/reels/r1/image")
    }

    func testAnAddressIsNeverFollowedSoTheKeyNeverLeavesSoundReel() {
        for hostile in ["https://evil.test/x.jpg", "//evil.test/x.jpg", "http://192.0.2.1/x"] {
            XCTAssertEqual(ReelImageLoader.path(reelId: "r1", imagePath: hostile), "/api/mondrop/reels/r1/image", hostile)
        }
    }

    func testAnIdCannotBreakOutOfItsSegment() {
        XCTAssertEqual(ReelImageLoader.path(reelId: "a/b?c", imagePath: nil), "/api/mondrop/reels/a%2Fb%3Fc/image")
    }

    // MARK: asking SoundReel

    func testItAsksSoundReelWithTheKeyAndKeepsTheAnswer() async throws {
        StubURLProtocol.handler = { [jpeg] _ in (200, jpeg) }
        let reels = loader()

        let first = await reels.data(reelId: "r1", imagePath: "/api/mondrop/reels/r1/image")
        XCTAssertEqual(first, jpeg)
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.absoluteString, "https://soundreel.test/api/mondrop/reels/r1/image")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-SoundReel-Key"), "sr_test_key_0123456789abcdef")

        let second = await reels.data(reelId: "r1", imagePath: "/api/mondrop/reels/r1/image")
        XCTAssertEqual(second, jpeg)
        XCTAssertEqual(requests.count, 1, "the second time it comes from the phone's cache")
    }

    func testAnotherLoaderOnTheSameFolderFindsWhatWasKept() async {
        StubURLProtocol.handler = { [jpeg] _ in (200, jpeg) }
        _ = await loader().data(reelId: "r1", imagePath: nil)
        StubURLProtocol.reset()

        let again = await loader().data(reelId: "r1", imagePath: nil)

        XCTAssertEqual(again, jpeg)
        XCTAssertTrue(requests.isEmpty, "read from the folder of the system caches, no network")
    }

    func testAReelWithoutAPictureIsNotAskedAgainThisSession() async {
        StubURLProtocol.handler = { _ in (404, Data()) }
        let reels = loader()

        let first = await reels.data(reelId: "r1", imagePath: nil)
        let second = await reels.data(reelId: "r1", imagePath: nil)

        XCTAssertNil(first)
        XCTAssertNil(second)
        XCTAssertEqual(requests.count, 1)
    }

    func testAnAnswerThatIsNotAnImageIsNotKept() async {
        StubURLProtocol.handler = { _ in (200, Data("<html>login</html>".utf8)) }
        let reels = loader()

        let data = await reels.data(reelId: "r1", imagePath: nil)

        XCTAssertNil(data, "a login page is not a picture")
        XCTAssertNil(reels.cached(reelId: "r1"))
    }

    func testAHiccupOfTheServerIsAskedAgainNextTime() async {
        StubURLProtocol.handler = { _ in (500, Data()) }
        let reels = loader()

        _ = await reels.data(reelId: "r1", imagePath: nil)
        _ = await reels.data(reelId: "r1", imagePath: nil)

        XCTAssertEqual(requests.count, 2)
    }

    func testNoKeyNoRequest() async {
        StubURLProtocol.handler = { [jpeg] _ in (200, jpeg) }

        let data = await loader(key: "").data(reelId: "r1", imagePath: nil)

        XCTAssertNil(data)
        XCTAssertTrue(requests.isEmpty)
    }
}
