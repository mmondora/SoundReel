// HomeModels.swift — what `GET /api/mondrop/home` sends (ADR-0020, spec 2026-11-08-mondrop-home-spotify-design.md §4).
//
// The SERVER decides which sections exist, in what order, with what title and with which songs: the app draws what it gets and
// computes nothing (rule P). So these types only READ the answer, leniently: a section of a kind this app does not know is kept
// but never drawn, a malformed one is dropped, and a missing field is a default, never a failed Home.

import Foundation

/// A playlist card: the playlist as the Playlist screens know it, plus up to four song keys for the mosaic of its cover.
public struct HomePlaylist: Decodable, Identifiable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let songCount: Int
    /// `static` | `dynamic`.
    public let kind: String?
    public let ruleSummary: String?
    public let canEdit: Bool?
    /// `auto` = made by the server from a post (ADR-0023). The route does not send it yet: nil then, and the playlist is taken for one made by hand.
    public let origin: String?
    /// The songs whose covers make the mosaic (at most four). The app asks SoundReel for each cover as always.
    public let coverKeys: [String]

    public var isDynamic: Bool { kind?.lowercased() == "dynamic" }

    /// The same playlist as the full list shows it, so that a card opens the page a row of that list opens.
    public var playlist: MondropPlaylist {
        MondropPlaylist(id: id, name: name, songCount: songCount, kind: kind, ruleSummary: ruleSummary, canEdit: canEdit, origin: origin)
    }

    public init(
        id: String, name: String, songCount: Int, kind: String? = nil, ruleSummary: String? = nil, canEdit: Bool? = nil, origin: String? = nil, coverKeys: [String] = []
    ) {
        self.id = id
        self.name = name
        self.songCount = songCount
        self.kind = kind
        self.ruleSummary = ruleSummary
        self.canEdit = canEdit
        self.origin = origin
        self.coverKeys = coverKeys
    }

    enum CodingKeys: String, CodingKey { case id, name, songCount, kind, ruleSummary, canEdit, origin, coverKeys }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        songCount = (try? c.decodeIfPresent(Int.self, forKey: .songCount)) ?? 0
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        ruleSummary = try? c.decodeIfPresent(String.self, forKey: .ruleSummary)
        canEdit = (try? c.decodeIfPresent(Bool.self, forKey: .canEdit)) ?? nil
        origin = try? c.decodeIfPresent(String.self, forKey: .origin)
        coverKeys = (try? c.decodeIfPresent([String].self, forKey: .coverKeys)) ?? []
    }
}

public enum HomeSectionKind: Equatable, Sendable {
    /// Cards of playlists.
    case playlists
    /// A row of songs.
    case tracks
    /// A kind a newer server invented: kept, never drawn.
    case unknown(String)

    init(_ raw: String) {
        switch raw {
        case "playlists": self = .playlists
        case "tracks": self = .tracks
        default: self = .unknown(raw)
        }
    }
}

public struct HomeSection: Decodable, Identifiable, Sendable, Equatable {
    /// `playlists`, `recent`, `fresh`… stable, for the tests and for the accessibility of the screen.
    public let id: String
    public let title: String
    public let kind: HomeSectionKind
    public let playlists: [HomePlaylist]
    public let tracks: [OfflineTrack]

    public init(id: String, title: String, kind: HomeSectionKind, playlists: [HomePlaylist] = [], tracks: [OfflineTrack] = []) {
        self.id = id
        self.title = title
        self.kind = kind
        self.playlists = playlists
        self.tracks = tracks
    }

    /// Something the screen can draw: a known kind with something in it (the server never sends an empty one, but it is checked).
    public var isRenderable: Bool {
        switch kind {
        case .playlists: return !playlists.isEmpty
        case .tracks: return !tracks.isEmpty
        case .unknown: return false
        }
    }

    enum CodingKeys: String, CodingKey { case id, title, kind, playlists, tracks }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        kind = HomeSectionKind((try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "")
        playlists = c.lossyList(HomePlaylist.self, forKey: .playlists)
        tracks = c.lossyList(OfflineTrack.self, forKey: .tracks)
    }
}

public struct HomeResponse: Decodable, Sendable, Equatable {
    public let user: String
    /// The name the Home greets with, or nil (the app then greets without one).
    public let displayName: String?
    public let sections: [HomeSection]

    /// The sections the screen draws, in the order the server gave them.
    public var renderableSections: [HomeSection] { sections.filter(\.isRenderable) }

    public init(user: String, displayName: String? = nil, sections: [HomeSection] = []) {
        self.user = user
        self.displayName = displayName
        self.sections = sections
    }

    enum CodingKeys: String, CodingKey { case user, displayName, sections }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = (try? c.decodeIfPresent(String.self, forKey: .user)) ?? ""
        displayName = try? c.decodeIfPresent(String.self, forKey: .displayName)
        sections = c.lossyList(HomeSection.self, forKey: .sections)
    }
}

/// One element of a list that may be malformed: it decodes to nil instead of failing the whole list.
private struct Lossy<Element: Decodable>: Decodable {
    let value: Element?
    init(from decoder: Decoder) throws { value = try? Element(from: decoder) }
}

private extension KeyedDecodingContainer {
    /// A list whose bad elements are left out (and which is empty when the key is missing or is not a list).
    func lossyList<T: Decodable>(_ type: T.Type, forKey key: Key) -> [T] {
        ((try? decodeIfPresent([Lossy<T>].self, forKey: key)) ?? nil)?.compactMap(\.value) ?? []
    }
}
