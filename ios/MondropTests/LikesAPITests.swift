import XCTest
@testable import Mondrop

/// The three calls of docs/mondrop-likes.md, against a URLProtocol stub (no network): the set of the person's likes, and PUT / DELETE of one.
final class LikesAPITests: XCTestCase {
    private func api(user: String = "mike") -> MondropAPI {
        MondropAPI(session: StubURLProtocol.session(), config: { MondropAPIConfig(baseURL: "https://soundreel.test/", apiKey: "sr_test_key_0123456789abcdef", user: user) })
    }

    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    private var captured: StubURLProtocol.Captured { StubURLProtocol.captured.last! }

    private func wirePath(_ request: URLRequest) -> String? {
        request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedPath }
    }

    // MARK: GET /api/mondrop/likes

    func testTheSetIsReadFromItsRouteWithTheKeyAndKeepsTheOrderTheServerGaveIt() async throws {
        StubURLProtocol.handler = { _ in
            (200, Data(#"{"user":"mike","total":2,"likes":[{"songKey":"daft punk::one more time","likedAt":"2026-11-10T18:00:00.000Z"},{"songKey":"a::b","likedAt":"2026-11-09T08:00:00.000Z"}]}"#.utf8))
        }
        let snapshot = try await api().fetchLikes()
        XCTAssertEqual(snapshot.likes.map(\.songKey), ["daft punk::one more time", "a::b"], "newest like first, as the server sent it")
        XCTAssertEqual(snapshot.user, "mike")
        XCTAssertEqual(snapshot.total, 2)
        XCTAssertEqual(snapshot.likes.first?.likedAt, ISO.parse("2026-11-10T18:00:00.000Z"))
        XCTAssertEqual(captured.request.httpMethod, "GET")
        XCTAssertEqual(wirePath(captured.request), "/api/mondrop/likes")
        XCTAssertEqual(captured.request.value(forHTTPHeaderField: "X-SoundReel-Key"), "sr_test_key_0123456789abcdef")
    }

    func testAnElementThatCannotBeReadIsSkippedAndTheOthersCount() async throws {
        StubURLProtocol.handler = { _ in
            (200, Data(#"{"likes":[{"songKey":"a::b"},{"nope":1},{"songKey":""},{"songKey":"c::d","likedAt":"not a date"},42]}"#.utf8))
        }
        let snapshot = try await api().fetchLikes()
        XCTAssertEqual(snapshot.likes.map(\.songKey), ["a::b", "c::d"], "one bad element must not hide the rest; an empty key is no like")
        XCTAssertNil(snapshot.likes.last?.likedAt, "a date that cannot be read is no date")
        XCTAssertNil(snapshot.user)
        XCTAssertNil(snapshot.total)
    }

    func testASetWithoutTheListIsAnEmptySetAndGarbageIsAnError() async throws {
        StubURLProtocol.handler = { _ in (200, Data(#"{"user":"mike"}"#.utf8)) }
        let empty = try await api().fetchLikes()
        XCTAssertTrue(empty.likes.isEmpty)
        StubURLProtocol.handler = { _ in (200, Data("<html>".utf8)) }
        do {
            _ = try await api().fetchLikes()
            XCTFail("an answer that is not JSON cannot be a set of likes")
        } catch let error as MondropAPIError {
            if case .decode = error {} else { XCTFail("expected a decode error, got \(error)") }
        }
    }

    // MARK: PUT /api/mondrop/songs/:key/like

    func testALikeIsAPutOnTheSongsLikeRouteWithTheMomentInTheBody() async throws {
        StubURLProtocol.handler = { _ in (200, Data(#"{"songKey":"daft punk::one more time","liked":true,"likedAt":"2026-11-10T17:58:00.000Z"}"#.utf8)) }
        let moment = try XCTUnwrap(ISO.parse("2026-11-10T17:58:00Z"))
        let ack = try await api().putLike(songKey: "daft punk::one more time", at: moment)
        XCTAssertTrue(ack.liked)
        XCTAssertEqual(ack.songKey, "daft punk::one more time")
        XCTAssertEqual(captured.request.httpMethod, "PUT")
        XCTAssertEqual(wirePath(captured.request), "/api/mondrop/songs/daft%20punk%3A%3Aone%20more%20time/like", "the key is encoded like in every other song route")
        XCTAssertEqual(String(data: try XCTUnwrap(captured.body), encoding: .utf8), #"{"at":"2026-11-10T17:58:00Z"}"#)
        XCTAssertEqual(captured.request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(captured.request.value(forHTTPHeaderField: "X-SoundReel-Key"), "sr_test_key_0123456789abcdef")
    }

    func testAKeyThatTriesToLeaveItsPathSegmentCannot() async throws {
        StubURLProtocol.handler = { _ in (200, Data(#"{"songKey":"x","liked":true}"#.utf8)) }
        _ = try await api().putLike(songKey: "ac/dc::back in black?x=1#", at: Date())
        XCTAssertEqual(wirePath(captured.request), "/api/mondrop/songs/ac%2Fdc%3A%3Aback%20in%20black%3Fx%3D1%23/like")
    }

    func testAnAcceptedLikeWhoseAnswerCannotBeReadIsStillAccepted() async throws {
        StubURLProtocol.handler = { _ in (200, Data("ok".utf8)) }
        let ack = try await api().putLike(songKey: "a::b", at: Date())
        XCTAssertTrue(ack.liked, "a 200 means the server took it: sending it again because of a decode problem would be wrong")
        XCTAssertEqual(ack.songKey, "a::b")
    }

    // MARK: DELETE /api/mondrop/songs/:key/like

    func testAnUnlikeIsADeleteOnTheSameRouteWithNoBody() async throws {
        StubURLProtocol.handler = { _ in (200, Data(#"{"songKey":"a::b","liked":false}"#.utf8)) }
        let ack = try await api().deleteLike(songKey: "a::b")
        XCTAssertFalse(ack.liked)
        XCTAssertEqual(captured.request.httpMethod, "DELETE")
        XCTAssertEqual(wirePath(captured.request), "/api/mondrop/songs/a%3A%3Ab/like")
        XCTAssertNil(captured.body)
    }

    func testAnAcceptedUnlikeWhoseAnswerCannotBeReadIsStillAccepted() async throws {
        StubURLProtocol.handler = { _ in (200, Data()) }
        let ack = try await api().deleteLike(songKey: "a::b")
        XCTAssertFalse(ack.liked)
    }

    // MARK: what the server can answer

    func testTheStatusOfAnErrorReachesTheCaller() async {
        for status in [400, 401, 404, 500] {
            StubURLProtocol.handler = { _ in (status, Data(#"{"error":"x"}"#.utf8)) }
            do {
                _ = try await api().putLike(songKey: "a::b", at: Date())
                XCTFail("\(status) is an error")
            } catch let error as MondropAPIError {
                guard case .http(let code, _) = error else { return XCTFail("expected http, got \(error)") }
                XCTAssertEqual(code, status)
            } catch {
                XCTFail("unexpected \(error)")
            }
        }
    }

    func testWithoutAKeyNothingGoesOut() async {
        let noKey = MondropAPI(session: StubURLProtocol.session(), config: { MondropAPIConfig(baseURL: "https://soundreel.test", apiKey: " ", user: "mike") })
        do {
            _ = try await noKey.fetchLikes()
            XCTFail("no key, no call")
        } catch let error as MondropAPIError {
            XCTAssertEqual(error, .missingApiKey)
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertTrue(StubURLProtocol.captured.isEmpty)
    }
}
