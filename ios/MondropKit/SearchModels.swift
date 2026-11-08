// SearchModels.swift — «Cerca» (ADR-0018, docs/mondrop-sync.md "GET /api/mondrop/search"): ONE search over everything
// that can be played. The SERVER answers it (rule P): the app asks, shows tracks, artists and albums, and never knows how
// many stores there are or where a file sits.
//
// Decoded defensively like the library: an older server has no such route (404), a newer one may add fields. Nothing here
// ever crashes on a surprise.

import Foundation

/// `GET /api/mondrop/search?q&artist&album&limit&offset&sections`
public struct SearchQuery: Equatable, Sendable {
    public static let defaultLimit = 30
    public static let maxLimit = 200

    public var text: String
    public var artist: String
    public var album: String
    public var limit: Int
    public var offset: Int
    /// `false` → `sections=0`: only the next page of tracks is wanted, not the artists and the albums again.
    public var withSections: Bool

    public init(
        text: String = "", artist: String = "", album: String = "",
        limit: Int = SearchQuery.defaultLimit, offset: Int = 0, withSections: Bool = true
    ) {
        self.text = text
        self.artist = artist
        self.album = album
        self.limit = limit
        self.offset = offset
        self.withSections = withSections
    }

    /// The server refuses a search with nothing to look for (400): an empty box asks nothing.
    public var isEmpty: Bool { text.isBlank && artist.isBlank && album.isBlank }

    /// `name=value` pairs, in a fixed order, trimmed and cut to what the server accepts (never half a character).
    func pairs() -> [(String, String)] {
        var out: [(String, String)] = []
        if let q = LibraryQuery.clean(text) { out.append(("q", q)) }
        if let artist = LibraryQuery.clean(artist) { out.append(("artist", artist)) }
        if let album = LibraryQuery.clean(album) { out.append(("album", album)) }
        out.append(("limit", String(min(max(limit, 1), Self.maxLimit))))
        out.append(("offset", String(max(offset, 0))))
        if !withSections { out.append(("sections", "0")) }
        return out
    }

    /// The percent-encoded query string (RFC 3986 unreserved only: a `+` or an `&` inside «AC+DC» or «R&B» must arrive as
    /// itself). `user`, the hint every Mondrop call carries, goes last.
    public func queryString(user: String? = nil) -> String {
        var all = pairs()
        if let user, !user.isBlank { all.append(("user", user.trimmingCharacters(in: .whitespacesAndNewlines))) }
        return all.map { "\($0.0)=\(LibraryQuery.encode($0.1))" }.joined(separator: "&")
    }
}

/// An artist among the results: how many of the songs found are his.
public struct SearchArtistHit: Identifiable, Equatable, Sendable, Decodable {
    public var id: String { name }
    public let name: String
    public let tracks: Int

    public init(name: String, tracks: Int) {
        self.name = name
        self.tracks = tracks
    }

    private enum CodingKeys: String, CodingKey { case name, tracks }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let decoded = try c.decode(String.self, forKey: .name)
        guard !decoded.isBlank else {
            throw DecodingError.dataCorruptedError(forKey: .name, in: c, debugDescription: "artist without a name")
        }
        name = decoded
        tracks = ((try? c.decodeIfPresent(Int.self, forKey: .tracks)) ?? nil) ?? 0
    }
}

/// An album among the results: where the songs found come from.
public struct SearchAlbumHit: Identifiable, Equatable, Sendable, Decodable {
    public var id: String { "\(artist)\u{1F}\(title)" }
    public let title: String
    public let artist: String
    public let tracks: Int

    public init(title: String, artist: String, tracks: Int) {
        self.title = title
        self.artist = artist
        self.tracks = tracks
    }

    private enum CodingKeys: String, CodingKey { case title, artist, tracks }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let decoded = try c.decode(String.self, forKey: .title)
        guard !decoded.isBlank else {
            throw DecodingError.dataCorruptedError(forKey: .title, in: c, debugDescription: "album without a title")
        }
        title = decoded
        artist = ((try? c.decodeIfPresent(String.self, forKey: .artist)) ?? nil) ?? ""
        tracks = ((try? c.decodeIfPresent(Int.self, forKey: .tracks)) ?? nil) ?? 0
    }
}

/// The answer: the tracks of ONE page, how many songs match in all, and the artists and albums (when asked).
public struct SearchPage: Equatable, Sendable, Decodable {
    public let q: String
    public let tracks: [OfflineTrack]
    public let artists: [SearchArtistHit]
    public let albums: [SearchAlbumHit]
    /// Every SONG that matches, not only this page (a song with two files counts once).
    public let total: Int
    public let offset: Int
    public let limit: Int
    public let user: String?

    public init(
        q: String = "", tracks: [OfflineTrack], artists: [SearchArtistHit] = [], albums: [SearchAlbumHit] = [],
        total: Int? = nil, offset: Int = 0, limit: Int = SearchQuery.defaultLimit, user: String? = nil
    ) {
        self.q = q
        self.tracks = tracks
        self.artists = artists
        self.albums = albums
        self.total = total ?? offset + tracks.count
        self.offset = offset
        self.limit = limit
        self.user = user
    }

    private enum CodingKeys: String, CodingKey { case q, tracks, artists, albums, total, offset, limit, user }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        q = ((try? c.decodeIfPresent(String.self, forKey: .q)) ?? nil) ?? ""
        let lossyTracks = ((try? c.decodeIfPresent([LossyDecodable<OfflineTrack>].self, forKey: .tracks)) ?? nil) ?? []
        tracks = lossyTracks.compactMap { $0.value }
        artists = (((try? c.decodeIfPresent([LossyDecodable<SearchArtistHit>].self, forKey: .artists)) ?? nil) ?? []).compactMap { $0.value }
        albums = (((try? c.decodeIfPresent([LossyDecodable<SearchAlbumHit>].self, forKey: .albums)) ?? nil) ?? []).compactMap { $0.value }
        let decodedOffset = ((try? c.decodeIfPresent(Int.self, forKey: .offset)) ?? nil) ?? 0
        offset = max(0, decodedOffset)
        limit = ((try? c.decodeIfPresent(Int.self, forKey: .limit)) ?? nil) ?? SearchQuery.defaultLimit
        // A server that forgot `total` still shows what it sent.
        let decodedTotal = (try? c.decodeIfPresent(Int.self, forKey: .total)) ?? nil
        total = max(decodedTotal ?? (offset + tracks.count), tracks.count)
        user = (try? c.decodeIfPresent(String.self, forKey: .user)) ?? nil
    }
}

/// What «Cerca» needs from the backend (a fake in tests).
public protocol SearchTransport: Sendable {
    func search(_ query: SearchQuery) async throws -> SearchPage
}

extension MondropAPI: SearchTransport {
    /// Read-only; queues and downloads nothing. An older server answers 404 (the caller falls back to the phone).
    public func search(_ query: SearchQuery) async throws -> SearchPage {
        let data = try await sendRequest(path: "/api/mondrop/search", timeout: 30, query: query.pairs())
        return try decodeBody(SearchPage.self, from: data)
    }
}
