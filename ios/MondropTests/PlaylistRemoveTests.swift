import XCTest
@testable import Mondrop

/// «il remove è in swipe sulla playlist» (Michele, 10 November; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U7): the swipe
/// «Togli dalla playlist» on a song inside a playlist, and the new route `DELETE /api/mondrop/playlists/:id/songs/:songKey` it calls.
final class PlaylistRemoveRulesTests: XCTestCase {
    private func playlist(canEdit: Bool?, kind: String? = "static", origin: String? = nil) -> MondropPlaylist {
        MondropPlaylist(id: "p", name: "P", songCount: 3, kind: kind, canEdit: canEdit, origin: origin)
    }

    func testOnlyTheUsersOwnStaticPlaylistsOfferTheSwipe() {
        XCTAssertTrue(PlaylistRowActions.canRemoveSongs(from: playlist(canEdit: true), dynamicManifest: false))
    }

    func testAPlaylistTheServerDoesNotSayIsEditableOffersNothing() {
        XCTAssertFalse(PlaylistRowActions.canRemoveSongs(from: playlist(canEdit: false), dynamicManifest: false), "shared with the user: read only")
        XCTAssertFalse(PlaylistRowActions.canRemoveSongs(from: playlist(canEdit: nil), dynamicManifest: false), "an older server does not say: better no choice than a refused one")
    }

    func testADynamicPlaylistOffersNothingWhateverTheListSaid() {
        XCTAssertFalse(PlaylistRowActions.canRemoveSongs(from: playlist(canEdit: true, kind: "dynamic"), dynamicManifest: false))
        XCTAssertFalse(PlaylistRowActions.canRemoveSongs(from: playlist(canEdit: true), dynamicManifest: true), "the manifest says it is a rule")
    }

    func testAnAutomaticPlaylistOffersNothingItsSongsAreTheRulesBusiness() {
        XCTAssertFalse(PlaylistRowActions.canRemoveSongs(from: playlist(canEdit: true, origin: "auto"), dynamicManifest: false))
    }

    func testACardOfTheFirstPageCarriesTheOriginWhenTheServerSendsItAndOtherwiseIsTakenForOneMadeByHand() throws {
        let sent = try JSONDecoder().decode(HomePlaylist.self, from: Data(#"{"id":"p","name":"Jazz da ascoltare","songCount":5,"kind":"static","canEdit":true,"origin":"auto"}"#.utf8))
        XCTAssertEqual(sent.playlist.origin, "auto")
        XCTAssertFalse(PlaylistRowActions.canRemoveSongs(from: sent.playlist, dynamicManifest: false))
        let silent = try JSONDecoder().decode(HomePlaylist.self, from: Data(#"{"id":"p","name":"Mia","songCount":5,"kind":"static","canEdit":true}"#.utf8))
        XCTAssertNil(silent.origin)
        XCTAssertTrue(PlaylistRowActions.canRemoveSongs(from: silent.playlist, dynamicManifest: false), "the route does not say: a playlist made by hand until it does")
    }
}

/// The call itself, against a URLProtocol stub.
final class PlaylistRemoveAPITests: XCTestCase {
    private func api() -> MondropAPI {
        MondropAPI(session: StubURLProtocol.session(), config: { MondropAPIConfig(baseURL: "https://soundreel.test/", apiKey: "sr_test_key_0123456789abcdef", user: "mike") })
    }

    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testItIsADeleteOfTheSongUnderThePlaylistWithBothPartsEscapedAndTheKey() async throws {
        StubURLProtocol.handler = { _ in (200, Data(#"{"ok":true,"playlist":{"id":"p 1","name":"Road trip","songs":4},"user":"mike"}"#.utf8)) }
        let ack = try await api().removeSong(songKey: "daft punk::one more time/live?", fromPlaylist: "p 1")
        let request = StubURLProtocol.captured.last!.request
        XCTAssertEqual(request.httpMethod, "DELETE")
        let path = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedPath }
        XCTAssertEqual(path, "/api/mondrop/playlists/p%201/songs/daft%20punk%3A%3Aone%20more%20time%2Flive%3F")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-SoundReel-Key"), "sr_test_key_0123456789abcdef")
        XCTAssertNil(StubURLProtocol.captured.last!.body, "no body: the song is in the address")
        XCTAssertEqual(ack, PlaylistAddAck(playlistId: "p 1", name: "Road trip", songs: 4))
    }

    func testAnAnswerThatCannotBeReadStillMeansRemoved() async throws {
        StubURLProtocol.handler = { _ in (200, Data("<html>".utf8)) }
        let ack = try await api().removeSong(songKey: "a::b", fromPlaylist: "p")
        XCTAssertEqual(ack.playlistId, "p")
        XCTAssertEqual(ack.name, "")
    }

    func testARefusalIsAnHTTPError() async throws {
        StubURLProtocol.handler = { _ in (404, Data(#"{"error":"playlist not found"}"#.utf8)) }
        do {
            _ = try await api().removeSong(songKey: "a::b", fromPlaylist: "p")
            XCTFail("a 404 is an error")
        } catch let error as MondropAPIError {
            guard case .http(404, let body?) = error else { return XCTFail("expected a 404 with its body, got \(error)") }
            XCTAssertTrue(body.contains("playlist not found"))
        }
    }
}

/// What the page of a playlist does around the call: the song goes at once, and comes back if the server says no.
@MainActor
final class PlaylistRemoveFlowTests: XCTestCase {
    private final class FakeRemover: PlaylistSongRemoving, @unchecked Sendable {
        var result: Result<PlaylistAddAck, Error> = .success(PlaylistAddAck(playlistId: "pl", name: "Playlist pl", songs: 2))
        private(set) var calls: [(songKey: String, playlist: String)] = []
        /// Called while the request is in the air, to look at what the page shows meanwhile.
        var whileInFlight: (() -> Void)?

        func removeSong(songKey: String, fromPlaylist id: String) async throws -> PlaylistRemoveAck {
            calls.append((songKey, id))
            whileInFlight?()
            return try result.get()
        }
    }

    private func make(keys: [String] = ["a", "b", "c"]) async throws -> (PlaylistSyncCoordinator, EngineRig) {
        let rig = try EngineRig()
        let api = FakeAPI()
        api.scriptManifests("pl", [.success(TestSupport.manifest("pl", keys.map { TestSupport.track($0) }))])
        let coordinator = PlaylistSyncCoordinator(playlist: MondropPlaylist(id: "pl", name: "Playlist pl", songCount: keys.count, canEdit: true), api: api, engine: rig.engine)
        await coordinator.load()
        return (coordinator, rig)
    }

    private func keys(_ c: PlaylistSyncCoordinator) -> [String] { c.manifest?.tracks.map(\.songKey) ?? [] }

    func testTheSongLeavesThePageAtOnceAndTheServerIsToldWhichOne() async throws {
        let (coordinator, _) = try await make()
        let remover = FakeRemover()
        var shownMeanwhile: [String] = []
        remover.whileInFlight = { shownMeanwhile = self.keys(coordinator) }
        let outcome = await coordinator.removeSong(songKey: "b", using: remover)
        XCTAssertEqual(shownMeanwhile, ["a", "c"], "optimistic: gone before the answer")
        XCTAssertEqual(keys(coordinator), ["a", "c"])
        XCTAssertEqual(remover.calls.map(\.songKey), ["b"])
        XCTAssertEqual(remover.calls.map(\.playlist), ["pl"])
        XCTAssertEqual(outcome, .removed("Tolto da «Playlist pl»"))
    }

    func testThePhoneRemembersWhatThePlaylistHoldsNow() async throws {
        let (coordinator, rig) = try await make()
        _ = await coordinator.removeSong(songKey: "a", using: FakeRemover())
        XCTAssertEqual(rig.store.playlistRecords()["pl"]?.songKeys, ["b", "c"])
    }

    func testARefusalPutsTheSongBackWhereItWasAndSaysWhy() async throws {
        let (coordinator, rig) = try await make()
        let remover = FakeRemover()
        remover.result = .failure(MondropAPIError.http(404, #"{"error":"playlist not found"}"#))
        let outcome = await coordinator.removeSong(songKey: "b", using: remover)
        XCTAssertEqual(keys(coordinator), ["a", "b", "c"], "back in its place")
        XCTAssertEqual(outcome, .failed("Questa playlist non è tua o non esiste più: aggiorna l'elenco."))
        XCTAssertEqual(rig.store.playlistRecords()["pl"]?.songKeys, ["a", "b", "c"], "the phone did not learn a removal that did not happen")
    }

    func testAServerThatDoesNotKnowTheRouteIsQuietAndKeepsTheSong() async throws {
        let (coordinator, _) = try await make()
        let remover = FakeRemover()
        // what an older Fastify answers to a route it does not have
        remover.result = .failure(MondropAPIError.http(404, #"{"message":"Route DELETE:/api/mondrop/playlists/pl/songs/b not found","error":"Not Found","statusCode":404}"#))
        let outcome = await coordinator.removeSong(songKey: "b", using: remover)
        XCTAssertEqual(outcome, .unavailable)
        XCTAssertEqual(keys(coordinator), ["a", "b", "c"])
        XCTAssertEqual(PlaylistRemoveOutcome.unavailable.message, "Non disponibile con questo server")
    }

    func testAMethodNotAllowedIsTheSameAsAMissingRoute() async throws {
        let (coordinator, _) = try await make()
        let remover = FakeRemover()
        remover.result = .failure(MondropAPIError.http(405, nil))
        let outcome = await coordinator.removeSong(songKey: "b", using: remover)
        XCTAssertEqual(outcome, .unavailable)
        XCTAssertEqual(keys(coordinator), ["a", "b", "c"])
    }

    func testADynamicPlaylistIsRefusedWithItsOwnWordsAndTheSongStays() async throws {
        let (coordinator, _) = try await make()
        let remover = FakeRemover()
        remover.result = .failure(MondropAPIError.http(409, #"{"error":"playlist_is_dynamic"}"#))
        let outcome = await coordinator.removeSong(songKey: "b", using: remover)
        XCTAssertEqual(outcome, .failed("Questa playlist è dinamica: la decide una regola, non si tolgono brani a mano."))
        XCTAssertEqual(keys(coordinator), ["a", "b", "c"])
    }

    func testAnyOtherFailureAlsoPutsItBack() async throws {
        let (coordinator, _) = try await make()
        let remover = FakeRemover()
        remover.result = .failure(MondropAPIError.http(500, nil))
        let outcome = await coordinator.removeSong(songKey: "c", using: remover)
        guard case .failed(let words) = outcome else { return XCTFail("expected a failure, got \(outcome)") }
        XCTAssertFalse(words.isEmpty)
        XCTAssertEqual(keys(coordinator), ["a", "b", "c"])
    }

    func testASongThatIsNotInThePlaylistIsNotAskedAbout() async throws {
        let (coordinator, _) = try await make()
        let remover = FakeRemover()
        let outcome = await coordinator.removeSong(songKey: "zzz", using: remover)
        XCTAssertTrue(remover.calls.isEmpty)
        guard case .failed = outcome else { return XCTFail("expected a failure, got \(outcome)") }
        XCTAssertEqual(keys(coordinator), ["a", "b", "c"])
    }

    func testRemovingTheLastSongLeavesAnEmptyPlaylistNotNothing() async throws {
        let (coordinator, _) = try await make(keys: ["only"])
        _ = await coordinator.removeSong(songKey: "only", using: FakeRemover())
        XCTAssertNotNil(coordinator.manifest)
        XCTAssertEqual(keys(coordinator), [])
    }
}
