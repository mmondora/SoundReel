import XCTest
@testable import Mondrop

/// What `GET /api/mondrop/home` sends (ADR-0020) and how the app reads it: leniently, because the SERVER decides what is on the Home and
/// a newer server may send what this app has never heard of.
final class HomeModelsTests: XCTestCase {
    /// A broken assertion stops the test: the next line indexes into what the broken one was about (a crash would hide the failure).
    override func setUp() { continueAfterFailure = false }

    private func decode(_ json: String) throws -> HomeResponse {
        try JSONDecoder().decode(HomeResponse.self, from: Data(json.utf8))
    }

    private let contract = """
    {
      "user": "mike",
      "displayName": "Michele",
      "sections": [
        { "id": "playlists", "title": "Le tue playlist", "kind": "playlists",
          "playlists": [
            { "id": "p1", "name": "Road trip", "songCount": 7, "kind": "static", "ruleSummary": null, "canEdit": true,
              "coverKeys": ["a::one", "b::two", "c::three", "d::four"], "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "p2", "name": "Più ascoltate", "songCount": 12, "kind": "dynamic", "ruleSummary": "Più ascoltate · ultimi 30 giorni", "canEdit": false, "coverKeys": [] }
          ] },
        { "id": "recent", "title": "Ascoltati di recente", "kind": "tracks",
          "tracks": [ { "songKey": "a::one", "title": "one", "artist": "a", "state": "ready", "mediaUrl": null,
                        "downloadPath": "/api/mondrop/songs/a%3A%3Aone/file", "coverPath": "/api/mondrop/songs/a%3A%3Aone/cover" } ] },
        { "id": "fresh", "title": "Nuovi dai tuoi reel", "kind": "tracks",
          "tracks": [ { "songKey": "e::five", "title": "five", "artist": "e", "state": "missing" } ] }
      ]
    }
    """

    func testReadsTheContract() throws {
        let home = try decode(contract)
        XCTAssertEqual(home.user, "mike")
        XCTAssertEqual(home.displayName, "Michele")
        XCTAssertEqual(home.sections.map(\.id), ["playlists", "recent", "fresh"])
        XCTAssertEqual(home.sections.map(\.title), ["Le tue playlist", "Ascoltati di recente", "Nuovi dai tuoi reel"])
        XCTAssertEqual(home.sections.map(\.kind), [.playlists, .tracks, .tracks])
        XCTAssertEqual(home.renderableSections.count, 3)
    }

    func testAPlaylistCardIsThePlaylistTheOtherScreensKnowPlusItsCoverKeys() throws {
        let cards = try decode(contract).sections[0].playlists
        XCTAssertEqual(cards[0].coverKeys, ["a::one", "b::two", "c::three", "d::four"])
        XCTAssertFalse(cards[0].isDynamic)
        XCTAssertTrue(cards[1].isDynamic)
        // The card opens the page the Playlist tab opens: same id, name, count, kind, rule and permission.
        XCTAssertEqual(
            cards[1].playlist,
            MondropPlaylist(id: "p2", name: "Più ascoltate", songCount: 12, kind: "dynamic", ruleSummary: "Più ascoltate · ultimi 30 giorni", canEdit: false)
        )
        XCTAssertEqual(cards[0].playlist.canEdit, true)
    }

    func testTheSongsAreTheSameObjectsAsEverywhereElse() throws {
        let recent = try decode(contract).sections[1].tracks
        XCTAssertEqual(recent.map(\.songKey), ["a::one"])
        XCTAssertEqual(recent[0].resolvedState, .ready)
        XCTAssertEqual(recent[0].coverPath, "/api/mondrop/songs/a%3A%3Aone/cover")
        XCTAssertEqual(recent[0].downloadPath, "/api/mondrop/songs/a%3A%3Aone/file")
    }

    func testASectionOfAKindThisAppDoesNotKnowIsKeptButNeverDrawn() throws {
        let home = try decode("""
        { "user": "mike", "sections": [
          { "id": "x", "title": "Novità", "kind": "carousel", "tracks": [ { "songKey": "a::b", "title": "b", "artist": "a" } ] },
          { "id": "recent", "title": "Recenti", "kind": "tracks", "tracks": [ { "songKey": "a::b", "title": "b", "artist": "a" } ] } ] }
        """)
        XCTAssertEqual(home.sections.count, 2)
        XCTAssertEqual(home.sections[0].kind, .unknown("carousel"))
        XCTAssertEqual(home.renderableSections.map(\.id), ["recent"])
    }

    func testAnEmptySectionIsNotDrawn() throws {
        let home = try decode("""
        { "user": "mike", "sections": [
          { "id": "playlists", "title": "P", "kind": "playlists", "playlists": [] },
          { "id": "recent", "title": "R", "kind": "tracks", "tracks": [] },
          { "id": "fresh", "title": "F", "kind": "tracks" } ] }
        """)
        XCTAssertEqual(home.sections.count, 3)
        XCTAssertTrue(home.renderableSections.isEmpty)
    }

    func testABadElementIsLeftOutAndItsSiblingsStay() throws {
        let home = try decode("""
        { "user": "mike", "sections": [
          "oops",
          { "id": "playlists", "title": "P", "kind": "playlists",
            "playlists": [ { "name": "no id" }, { "id": "ok", "name": "Ok", "songCount": 2 }, 42 ] },
          { "id": "recent", "title": "R", "kind": "tracks",
            "tracks": [ { "title": "no key" }, { "songKey": "a::b", "title": "b", "artist": "a" } ] } ] }
        """)
        XCTAssertEqual(home.sections.map(\.id), ["playlists", "recent"])
        XCTAssertEqual(home.sections[0].playlists.map(\.id), ["ok"])
        XCTAssertEqual(home.sections[1].tracks.map(\.songKey), ["a::b"])
    }

    func testAMissingFieldIsADefaultNotAFailedHome() throws {
        let home = try decode(#"{ "sections": [ { "id": "playlists", "kind": "playlists", "playlists": [ { "id": "p" } ] } ] }"#)
        XCTAssertEqual(home.user, "")
        XCTAssertNil(home.displayName)
        let card = home.sections[0].playlists[0]
        XCTAssertEqual(card.name, "")
        XCTAssertEqual(card.songCount, 0)
        XCTAssertEqual(card.coverKeys, [])
        XCTAssertNil(card.canEdit)
        XCTAssertEqual(home.sections[0].title, "")
    }

    func testSectionsThatAreNotAListAreNoSections() throws {
        XCTAssertTrue(try decode(#"{ "user": "mike", "sections": "oops" }"#).sections.isEmpty)
        XCTAssertTrue(try decode(#"{ "user": "mike" }"#).sections.isEmpty)
    }

    func testTheOrderIsTheServers() throws {
        let home = try decode("""
        { "user": "mike", "sections": [
          { "id": "fresh", "title": "F", "kind": "tracks", "tracks": [ { "songKey": "a::b", "title": "b", "artist": "a" } ] },
          { "id": "playlists", "title": "P", "kind": "playlists", "playlists": [ { "id": "p" } ] } ] }
        """)
        XCTAssertEqual(home.renderableSections.map(\.id), ["fresh", "playlists"])
    }

    /// A row of the Home is a named list of songs: the queue it starts is called what the row is.
    func testACollectionIsCalledWhatTheRowIs() {
        let choice = LibraryChoice.collection("Ascoltati di recente")
        XCTAssertEqual(choice.label, "Ascoltati di recente")
        XCTAssertNil(choice.playlistId)
        XCTAssertEqual(choice.filters, LibraryFilters.none)
    }
}
