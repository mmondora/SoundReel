import XCTest
@testable import Mondrop

/// The HTTP layer of the sync contract, against a URLProtocol stub (no network).
final class MondropAPITests: XCTestCase {
    private func api(key: String = "sr_test_key_0123456789abcdef", user: String = "mike") -> MondropAPI {
        MondropAPI(session: StubURLProtocol.session(), config: { MondropAPIConfig(baseURL: "https://soundreel.test/", apiKey: key, user: user) })
    }

    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    private func json(_ text: String, status: Int = 200) -> (Int, Data) { (status, Data(text.utf8)) }

    private var captured: StubURLProtocol.Captured { StubURLProtocol.captured.last! }

    /// `URL.path` is percent-DECODED; what goes on the wire is the encoded form.
    private func wirePath(_ request: URLRequest) -> String? {
        request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedPath }
    }

    // MARK: paths

    func testSongKeysAreEncodedSoColonsAndSlashesCannotBreakThePath() {
        XCTAssertEqual(MondropAPI.songPath("bishop briggs::white flag"), "/api/mondrop/songs/bishop%20briggs%3A%3Awhite%20flag")
        XCTAssertEqual(MondropAPI.songPath("ac/dc::back in black", suffix: "/file"), "/api/mondrop/songs/ac%2Fdc%3A%3Aback%20in%20black/file")
        XCTAssertEqual(MondropAPI.songPath("là::città?#"), "/api/mondrop/songs/l%C3%A0%3A%3Acitt%C3%A0%3F%23")
    }

    // MARK: prepare

    func testPrepareSendsAnEmptyBodyByDefaultAndRetryFailedWhenAsked() async throws {
        StubURLProtocol.handler = { _ in self.json(#"{"playlistId":"pl 1","name":"N","tracks":[{"songKey":"a","state":"preparing"}]}"#) }

        let manifest = try await api().prepare(playlistId: "pl 1", retryFailed: false)
        XCTAssertEqual(manifest.preparingCount, 1)
        var request = captured.request
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(wirePath(request), "/api/mondrop/playlists/pl%201/prepare")
        XCTAssertEqual(String(data: try XCTUnwrap(captured.body), encoding: .utf8), "{}")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")

        _ = try await api().prepare(playlistId: "pl 1", retryFailed: true)
        request = captured.request
        XCTAssertEqual(String(data: try XCTUnwrap(captured.body), encoding: .utf8), #"{"retryFailed":true}"#)
    }

    func testEveryCallCarriesTheAuthHeadersAndTheUserHint() async throws {
        StubURLProtocol.handler = { _ in self.json(#"{"playlists":[]}"#) }
        _ = try await api().listPlaylists()
        let request = captured.request
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-SoundReel-Key"), "sr_test_key_0123456789abcdef")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-SoundReel-User"), "mike")
        XCTAssertEqual(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "user" }?.value, "mike")
        XCTAssertEqual(request.url?.host, "soundreel.test")
    }

    func testManifestOfAnOldServerDecodes() async throws {
        StubURLProtocol.handler = { _ in (200, Data(ManifestFixtures.old.utf8)) }
        let manifest = try await api().offlineManifest(playlistId: "pl-old")
        XCTAssertEqual(manifest.tracks.count, 4)
        XCTAssertEqual(captured.request.httpMethod, "GET")
        XCTAssertEqual(captured.request.url?.path, "/api/mondrop/playlists/pl-old/offline")
    }

    // MARK: per-song endpoints

    func testRequestDownloadSendsThePriorityAndDecodesTheAck() async throws {
        StubURLProtocol.handler = { _ in self.json(#"{"ok":true,"state":"preparing","track":{"songKey":"bishop briggs::white flag","state":"preparing"}}"#) }
        let ack = try await api().requestDownload(songKey: "bishop briggs::white flag", priority: .play)
        XCTAssertEqual(ack.state, "preparing")
        XCTAssertEqual(ack.track?.songKey, "bishop briggs::white flag")
        XCTAssertEqual(captured.request.httpMethod, "POST")
        XCTAssertEqual(wirePath(captured.request), "/api/mondrop/songs/bishop%20briggs%3A%3Awhite%20flag/download")
        XCTAssertEqual(String(data: try XCTUnwrap(captured.body), encoding: .utf8), #"{"priority":"play"}"#)

        _ = try await api().requestDownload(songKey: "k", priority: .sync)
        XCTAssertEqual(String(data: try XCTUnwrap(captured.body), encoding: .utf8), #"{"priority":"sync"}"#)
    }

    func testTrackAcceptsABareObjectOrAnEnvelope() async throws {
        StubURLProtocol.handler = { _ in self.json(#"{"songKey":"k","state":"ready","version":"1-1"}"#) }
        let bare = try await api().track(songKey: "k")
        XCTAssertEqual(bare.version, "1-1")
        XCTAssertEqual(captured.request.url?.path, "/api/mondrop/songs/k")

        StubURLProtocol.handler = { _ in self.json(#"{"track":{"songKey":"k","state":"ready","version":"2-2"}}"#) }
        let wrapped = try await api().track(songKey: "k")
        XCTAssertEqual(wrapped.version, "2-2")
    }

    func testSetSourceIsAPutWithTheYouTubeLink() async throws {
        StubURLProtocol.handler = { _ in self.json(#"{"ok":true}"#) }
        try await api().setSource(songKey: "a::b", youtubeUrl: "https://www.youtube.com/watch?v=abc")
        XCTAssertEqual(captured.request.httpMethod, "PUT")
        XCTAssertEqual(wirePath(captured.request), "/api/mondrop/songs/a%3A%3Ab/source")
        let body = try JSONSerialization.jsonObject(with: try XCTUnwrap(captured.body)) as? [String: String]
        XCTAssertEqual(body, ["youtubeUrl": "https://www.youtube.com/watch?v=abc"])
    }

    func testNetReadsHomeAndHasAShortTimeout() async throws {
        StubURLProtocol.handler = { _ in self.json(#"{"viaCloudflare":false,"home":true}"#) }
        let info = try await api().net()
        XCTAssertTrue(info.home)
        XCTAssertEqual(captured.request.url?.path, "/api/mondrop/net")
        XCTAssertLessThanOrEqual(captured.request.timeoutInterval, 5, "playing a track must not wait long for this")
    }

    // MARK: errors

    func testHttpErrorsCarryTheStatusAndBody() async {
        StubURLProtocol.handler = { _ in self.json(#"{"error":"song_not_found"}"#, status: 404) }
        do {
            _ = try await api().track(songKey: "k")
            XCTFail("should have thrown")
        } catch {
            XCTAssertEqual(error as? MondropAPIError, .http(404, #"{"error":"song_not_found"}"#))
        }
    }

    func testMissingKeyOrUserFailsBeforeAnyRequest() async {
        for (key, user, expected) in [("", "mike", MondropAPIError.missingApiKey), ("sr_x", " ", MondropAPIError.missingUser)] {
            do {
                _ = try await api(key: key, user: user).net()
                XCTFail("should have thrown")
            } catch {
                XCTAssertEqual(error as? MondropAPIError, expected)
            }
        }
        XCTAssertTrue(StubURLProtocol.captured.isEmpty, "nothing is sent without credentials")
    }

    func testGarbageResponseIsADecodeError() async {
        StubURLProtocol.handler = { _ in self.json("<html>proxy error</html>") }
        do {
            _ = try await api().offlineManifest(playlistId: "p")
            XCTFail("should have thrown")
        } catch {
            guard case .decode? = error as? MondropAPIError else { return XCTFail("\(error)") }
        }
    }
}
