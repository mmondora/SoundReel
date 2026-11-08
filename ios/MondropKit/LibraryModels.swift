// LibraryModels.swift — what the phone knows about «scegliere cosa suonare» (ADR-0013, docs/mondrop-sync.md
// "GET /api/mondrop/library"): the filters, the query string, the headings (facets) and the page the server answers.
//
// Everything is decoded defensively like the manifest: an older server has no `album` / `genres` / `year` and no
// library endpoint at all; a newer one may add fields. Nothing here ever crashes on a surprise.

import Foundation

// MARK: - Decade

/// «Anni 80» = 1980–1989, or «Senza anno» for the songs no provider could date.
public enum DecadeFilter: Hashable, Sendable {
    case decade(Int)
    case noYear

    /// What the query string and the facet entries call «no year».
    public static let noYearValue = "none"

    /// `"1980"` (a multiple of 10 in 1900…2090) or `"none"`; anything else is not a decade.
    public init?(value: String) {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if text == Self.noYearValue {
            self = .noYear
            return
        }
        guard text.allSatisfy({ $0.isASCII && $0.isNumber }), let decade = Int(text),
              (1900...2090).contains(decade), decade % 10 == 0 else { return nil }
        self = .decade(decade)
    }

    /// The decade of a year (1987 → 1980); no year → `.noYear`.
    public static func of(year: Int?) -> DecadeFilter {
        guard let year else { return .noYear }
        return .decade((year / 10) * 10)
    }

    /// The value sent as `decade=`.
    public var value: String {
        switch self {
        case .decade(let decade): return String(decade)
        case .noYear: return Self.noYearValue
        }
    }

    public func matches(year: Int?) -> Bool { self == Self.of(year: year) }

    /// The way people say it: 1980 is «Anni 80», 2010 is «Anni 2010» (and 1910 stays «Anni 1910») — same as the server.
    public var label: String {
        switch self {
        case .decade(let decade):
            return decade >= 1920 && decade < 2000 ? "Anni \(decade % 100)" : "Anni \(decade)"
        case .noYear:
            return "Senza anno"
        }
    }
}

// MARK: - Filters + query

/// What the user narrowed the library down to. A blank value is no filter.
public struct LibraryFilters: Hashable, Sendable {
    public var q: String
    public var genre: String
    public var album: String
    public var artist: String
    public var decade: DecadeFilter?

    public init(q: String = "", genre: String = "", album: String = "", artist: String = "", decade: DecadeFilter? = nil) {
        self.q = q
        self.genre = genre
        self.album = album
        self.artist = artist
        self.decade = decade
    }

    public static let none = LibraryFilters()

    public var isEmpty: Bool {
        q.isBlank && genre.isBlank && album.isBlank && artist.isBlank && decade == nil
    }
}

extension String {
    var isBlank: Bool { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

/// `GET /api/mondrop/library?q&genre&album&artist&decade&limit&offset&facets`
public struct LibraryQuery: Equatable, Sendable {
    public static let defaultLimit = 100
    public static let maxLimit = 500
    /// The server answers 400 for a text longer than this (JavaScript `.length`, i.e. UTF-16 units).
    public static let maxTextLength = 200

    public var filters: LibraryFilters
    public var limit: Int
    public var offset: Int
    /// `false` → `facets=0`: only the next page is wanted, not the headings again.
    public var withFacets: Bool

    public init(filters: LibraryFilters = .none, limit: Int = LibraryQuery.defaultLimit, offset: Int = 0, withFacets: Bool = true) {
        self.filters = filters
        self.limit = limit
        self.offset = offset
        self.withFacets = withFacets
    }

    /// Trimmed and cut to what the server accepts; never splits a character in half. Blank → nil.
    static func clean(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        var out = ""
        var units = 0
        for character in trimmed {
            let n = String(character).utf16.count
            if units + n > maxTextLength { break }
            out.append(character)
            units += n
        }
        return out
    }

    /// The percent-encoded query string, `name=value` pairs joined by `&`, in a fixed order.
    ///
    /// Encoded by hand with the RFC 3986 unreserved set: `URLComponents.queryItems` leaves `+` and `&`-adjacent
    /// characters alone, and the server reads a `+` as a space, so «AC+DC» and «R&B/Soul» would arrive as other
    /// strings. `user` (the hint every Mondrop call carries) is appended last when given.
    public func queryString(user: String? = nil) -> String {
        var pairs: [(String, String)] = []
        if let q = Self.clean(filters.q) { pairs.append(("q", q)) }
        if let genre = Self.clean(filters.genre) { pairs.append(("genre", genre)) }
        if let album = Self.clean(filters.album) { pairs.append(("album", album)) }
        if let artist = Self.clean(filters.artist) { pairs.append(("artist", artist)) }
        if let decade = filters.decade { pairs.append(("decade", decade.value)) }
        pairs.append(("limit", String(min(max(limit, 1), Self.maxLimit))))
        pairs.append(("offset", String(max(offset, 0))))
        if !withFacets { pairs.append(("facets", "0")) }
        if let user, !user.isBlank { pairs.append(("user", user.trimmingCharacters(in: .whitespacesAndNewlines))) }
        return pairs.map { "\($0.0)=\(Self.encode($0.1))" }.joined(separator: "&")
    }

    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    )

    static func encode(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? text
    }
}

// MARK: - Facets

/// One heading to choose from: «Thriller (9)». For the decades `value` is `"1980"` or `"none"`.
public struct LibraryFacetEntry: Identifiable, Equatable, Sendable, Decodable {
    public var id: String { value }
    /// What to send back as the filter.
    public let value: String
    /// What to show.
    public let label: String
    public let count: Int

    public init(value: String, label: String? = nil, count: Int) {
        self.value = value
        self.label = label ?? value
        self.count = count
    }

    private enum CodingKeys: String, CodingKey { case value, label, count }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // The decade value is a number («1980») or the string «none»; every other value is a string.
        let raw: String
        if let text = try? c.decode(String.self, forKey: .value) {
            raw = text
        } else if let whole = try? c.decode(Int.self, forKey: .value) {
            raw = String(whole)
        } else if let real = try? c.decode(Double.self, forKey: .value), real.isFinite {
            raw = String(Int(real.rounded()))
        } else {
            throw DecodingError.dataCorruptedError(forKey: .value, in: c, debugDescription: "facet without a value")
        }
        value = raw
        let shown = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? nil
        label = (shown?.isBlank == false) ? shown! : raw
        count = ((try? c.decodeIfPresent(Int.self, forKey: .count)) ?? nil) ?? 0
    }
}

public struct LibraryFacets: Equatable, Sendable, Decodable {
    public var genres: [LibraryFacetEntry]
    public var albums: [LibraryFacetEntry]
    public var artists: [LibraryFacetEntry]
    public var decades: [LibraryFacetEntry]

    public static let empty = LibraryFacets(genres: [], albums: [], artists: [], decades: [])

    public init(genres: [LibraryFacetEntry], albums: [LibraryFacetEntry], artists: [LibraryFacetEntry], decades: [LibraryFacetEntry]) {
        self.genres = genres
        self.albums = albums
        self.artists = artists
        self.decades = decades
    }

    private enum CodingKeys: String, CodingKey { case genres, albums, artists, decades }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func list(_ key: CodingKeys) -> [LibraryFacetEntry] {
            ((try? c.decodeIfPresent([LossyDecodable<LibraryFacetEntry>].self, forKey: key)) ?? nil)?.compactMap { $0.value } ?? []
        }
        genres = list(.genres)
        albums = list(.albums)
        artists = list(.artists)
        // A decade the server did not label is still «Anni 2000», never a bare «2000».
        decades = list(.decades).map { entry in
            guard entry.label == entry.value, let decade = DecadeFilter(value: entry.value) else { return entry }
            return LibraryFacetEntry(value: entry.value, label: decade.label, count: entry.count)
        }
    }
}

// MARK: - Page

/// The answer of `GET /api/mondrop/library`: the tracks of ONE page, how many match in all, and the headings.
public struct LibraryPage: Equatable, Sendable, Decodable {
    public let songs: [OfflineTrack]
    /// Everything that matches the filters, not only this page.
    public let total: Int
    public let offset: Int
    public let limit: Int
    /// nil when the request said `facets=0`.
    public let facets: LibraryFacets?
    public let user: String?

    public init(songs: [OfflineTrack], total: Int? = nil, offset: Int = 0, limit: Int = LibraryQuery.defaultLimit,
                facets: LibraryFacets? = nil, user: String? = nil) {
        self.songs = songs
        self.total = total ?? offset + songs.count
        self.offset = offset
        self.limit = limit
        self.facets = facets
        self.user = user
    }

    private enum CodingKeys: String, CodingKey { case songs, total, offset, limit, facets, user }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let lossy = ((try? c.decodeIfPresent([LossyDecodable<OfflineTrack>].self, forKey: .songs)) ?? nil) ?? []
        songs = lossy.compactMap { $0.value }
        let decodedOffset = ((try? c.decodeIfPresent(Int.self, forKey: .offset)) ?? nil) ?? 0
        offset = max(0, decodedOffset)
        limit = ((try? c.decodeIfPresent(Int.self, forKey: .limit)) ?? nil) ?? LibraryQuery.defaultLimit
        // A server that forgot `total` still shows what it sent.
        let decodedTotal = (try? c.decodeIfPresent(Int.self, forKey: .total)) ?? nil
        total = max(decodedTotal ?? (offset + songs.count), songs.count)
        facets = (try? c.decodeIfPresent(LibraryFacets.self, forKey: .facets)) ?? nil
        user = (try? c.decodeIfPresent(String.self, forKey: .user)) ?? nil
    }
}

/// What the Libreria needs from the backend besides playlists (a fake in tests).
public protocol LibraryTransport: Sendable {
    func library(_ query: LibraryQuery) async throws -> LibraryPage
}

/// The two halves the Libreria screen talks to.
public typealias LibraryBackend = MondropAPIProtocol & LibraryTransport
