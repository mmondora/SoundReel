// ReelModels.swift — what `GET /api/mondrop/reels` and `GET /api/mondrop/reels/:id` send (ADR-0033, spec 2026-11-12-mondrop-home-play-loop-reels-design.md M5 and §4, docs/mondrop-reels.md).
//
// Michele, 12 November: «un tab con le altre categorie sul reel ( dove però per ora l'unica cosa che viene portata sulla device è la musica ) ma non il link al reel ma la sua scomposizione e
// spiegazione». A reel here is DESCRIBED — what it is about (the explanation) and what it contains, by category — never linked: there is no field with an address in these types, and the only
// path is the one of the small picture (`imagePath`, asked from SoundReel like every cover). The SERVER decides which categories exist, in which order, and what is cleaned away (rule P): these
// types only READ the answer, leniently, like the Home — a category this app does not know is kept and never drawn as one of ours, a bad element is dropped, a missing field is a default.
//
// Only the music is made of songs (`OfflineTrack`, the ones of the library and of Cerca: they play, download and go in playlists as any song). Everything else is text.

import Foundation

/// A category of what a reel contains. The word is the one the server sends and the one the app sends back in `kind=`.
public enum ReelKind: Hashable, Sendable {
    case music, film, software, place, book, product, brand, person, event, quote
    /// A category a newer server invented: kept, never drawn as a known one.
    case unknown(String)

    public init(_ raw: String) {
        switch raw {
        case "music": self = .music
        case "film": self = .film
        case "software": self = .software
        case "place": self = .place
        case "book": self = .book
        case "product": self = .product
        case "brand": self = .brand
        case "person": self = .person
        case "event": self = .event
        case "quote": self = .quote
        default: self = .unknown(raw)
        }
    }

    public var raw: String {
        switch self {
        case .music: return "music"
        case .film: return "film"
        case .software: return "software"
        case .place: return "place"
        case .book: return "book"
        case .product: return "product"
        case .brand: return "brand"
        case .person: return "person"
        case .event: return "event"
        case .quote: return "quote"
        case .unknown(let raw): return raw
        }
    }

    public var isKnown: Bool {
        if case .unknown = self { return false }
        return true
    }

    /// The symbol of the category on the chips and in front of a section.
    public var systemImage: String {
        switch self {
        case .music: return "music.note"
        case .film: return "film"
        case .software: return "chevron.left.forwardslash.chevron.right"
        case .place: return "mappin.and.ellipse"
        case .book: return "book"
        case .product: return "shippingbox"
        case .brand: return "tag"
        case .person: return "person"
        case .event: return "calendar"
        case .quote: return "quote.opening"
        case .unknown: return "square.grid.2x2"
        }
    }
}

/// How many of a category a reel has (the card of the list: with the first names) or how many reels have it (the categories to choose from: with no names).
public struct ReelKindCount: Decodable, Identifiable, Equatable, Sendable {
    public let kind: ReelKind
    public let label: String
    public let count: Int
    public let names: [String]

    public var id: String { kind.raw }

    public init(kind: ReelKind, label: String, count: Int, names: [String] = []) {
        self.kind = kind
        self.label = label
        self.count = count
        self.names = names
    }

    /// «Software 3: Notion, Gmail, Slack», «Software 5: Notion, Gmail, Slack +2», «Film 2».
    public var chipText: String {
        var text = "\(label) \(count)"
        if !names.isEmpty {
            text += ": " + names.joined(separator: ", ")
            if count > names.count { text += " +\(count - names.count)" }
        }
        return text
    }

    enum CodingKeys: String, CodingKey { case kind, label, count, names }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try c.decode(String.self, forKey: .kind)
        kind = ReelKind(raw)
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? raw
        count = (try? c.decodeIfPresent(Int.self, forKey: .count)) ?? 0
        names = (try? c.decodeIfPresent([String].self, forKey: .names)) ?? []
    }
}

/// The platform of a reel, written the way people write it.
public enum ReelPlatform {
    public static func name(_ raw: String) -> String {
        switch raw.lowercased() {
        case "instagram": return "Instagram"
        case "tiktok": return "TikTok"
        case "youtube": return "YouTube"
        case "facebook": return "Facebook"
        case "twitter": return "X"
        case "threads": return "Threads"
        case "reddit": return "Reddit"
        case "linkedin": return "LinkedIn"
        case "pinterest": return "Pinterest"
        case "snapchat": return "Snapchat"
        case "vimeo": return "Vimeo"
        case "twitch": return "Twitch"
        case "spotify": return "Spotify"
        case "shazam": return "Shazam"
        case "soundcloud": return "SoundCloud"
        case "", "other": return "Web"
        default: return raw.prefix(1).uppercased() + raw.dropFirst()
        }
    }

    /// «Instagram · ieri», «TikTok · 10 nov»: where it came from and when it was read; the platform alone when the date is not readable.
    static func line(platform: String, createdAt: String?, now: Date, calendar: Calendar, locale: Locale) -> String {
        let day = PlaylistDateText.text(createdAt, now: now, calendar: calendar, locale: locale)
        let name = name(platform)
        return day.isEmpty ? name : "\(name) · \(day)"
    }
}

/// A reel in the list: what it is about, and what it holds by category.
public struct ReelCard: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let createdAt: String?
    public let platform: String
    /// The explanation: what the post is about, in a sentence or two. Nil when the analysis wrote none.
    public let summary: String?
    /// Where the small picture is asked (SoundReel's own path), or nil.
    public let imagePath: String?
    public let counts: [ReelKindCount]

    public init(id: String, createdAt: String? = nil, platform: String = "", summary: String? = nil, imagePath: String? = nil, counts: [ReelKindCount] = []) {
        self.id = id
        self.createdAt = createdAt
        self.platform = platform
        self.summary = summary
        self.imagePath = imagePath
        self.counts = counts
    }

    public var platformName: String { ReelPlatform.name(platform) }

    public func dateLine(now: Date = Date(), calendar: Calendar = .current, locale: Locale = Locale(identifier: "it_IT")) -> String {
        ReelPlatform.line(platform: platform, createdAt: createdAt, now: now, calendar: calendar, locale: locale)
    }

    enum CodingKeys: String, CodingKey { case id, createdAt, platform, summary, imagePath, counts }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        platform = (try? c.decodeIfPresent(String.self, forKey: .platform)) ?? ""
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
        imagePath = try? c.decodeIfPresent(String.self, forKey: .imagePath)
        counts = ((try? c.decodeIfPresent([LossyDecodable<ReelKindCount>].self, forKey: .counts)) ?? nil)?.compactMap(\.value) ?? []
    }
}

/// A page of the list. `kinds` comes only when the categories were asked for (the first page): how many reels have each.
public struct ReelPage: Decodable, Equatable, Sendable {
    public let total: Int
    public let limit: Int
    public let offset: Int
    public let kinds: [ReelKindCount]
    public let reels: [ReelCard]

    public init(total: Int, limit: Int, offset: Int, kinds: [ReelKindCount] = [], reels: [ReelCard] = []) {
        self.total = total
        self.limit = limit
        self.offset = offset
        self.kinds = kinds
        self.reels = reels
    }

    enum CodingKeys: String, CodingKey { case total, limit, offset, kinds, reels }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = (try? c.decodeIfPresent(Int.self, forKey: .total)) ?? 0
        limit = (try? c.decodeIfPresent(Int.self, forKey: .limit)) ?? 0
        offset = (try? c.decodeIfPresent(Int.self, forKey: .offset)) ?? 0
        kinds = ((try? c.decodeIfPresent([LossyDecodable<ReelKindCount>].self, forKey: .kinds)) ?? nil)?.compactMap(\.value) ?? []
        reels = ((try? c.decodeIfPresent([LossyDecodable<ReelCard>].self, forKey: .reels)) ?? nil)?.compactMap(\.value) ?? []
    }
}

/// A thing a reel mentions, in text: a film with its year and director, a software with what it is, a place, a book, a quote…
public struct ReelItem: Decodable, Equatable, Sendable {
    public let title: String
    public let detail: String?

    public init(title: String, detail: String? = nil) {
        self.title = title
        self.detail = detail
    }

    enum CodingKeys: String, CodingKey { case title, detail }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decode(String.self, forKey: .title)
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
    }
}

/// One category of a reel. The music has `tracks`; the others have `items`.
public struct ReelSection: Decodable, Identifiable, Equatable, Sendable {
    public let kind: ReelKind
    public let title: String
    public let tracks: [OfflineTrack]
    public let items: [ReelItem]

    public var id: String { kind.raw }

    public init(kind: ReelKind, title: String, tracks: [OfflineTrack] = [], items: [ReelItem] = []) {
        self.kind = kind
        self.title = title
        self.tracks = tracks
        self.items = items
    }

    enum CodingKeys: String, CodingKey { case kind, title, tracks, items }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try c.decode(String.self, forKey: .kind)
        kind = ReelKind(raw)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? raw
        tracks = ((try? c.decodeIfPresent([LossyDecodable<OfflineTrack>].self, forKey: .tracks)) ?? nil)?.compactMap(\.value) ?? []
        items = ((try? c.decodeIfPresent([LossyDecodable<ReelItem>].self, forKey: .items)) ?? nil)?.compactMap(\.value) ?? []
    }
}

/// An explanation the local model wrote about one thing the reel mentions («Brand: AGENTI»). Not always exact: the page says so.
public struct ReelInsight: Decodable, Equatable, Sendable {
    public let label: String
    public let text: String

    public init(label: String, text: String) {
        self.label = label
        self.text = text
    }

    enum CodingKeys: String, CodingKey { case label, text }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decode(String.self, forKey: .label)
        text = try c.decode(String.self, forKey: .text)
    }
}

/// What the post claims is true or not, when it claims something (vero, falso, dubbio…), with the reason.
public struct ReelVerdict: Decodable, Equatable, Sendable {
    public let label: String
    public let explanation: String?

    public init(label: String, explanation: String? = nil) {
        self.label = label
        self.explanation = explanation
    }

    enum CodingKeys: String, CodingKey { case label, explanation }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decode(String.self, forKey: .label)
        explanation = try? c.decodeIfPresent(String.self, forKey: .explanation)
    }
}

/// One slide of a carousel and what it says.
public struct ReelSlide: Decodable, Equatable, Sendable {
    public let index: Int
    public let summary: String

    public init(index: Int, summary: String) {
        self.index = index
        self.summary = summary
    }

    enum CodingKeys: String, CodingKey { case index, summary }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        index = (try? c.decodeIfPresent(Int.self, forKey: .index)) ?? 0
        summary = try c.decode(String.self, forKey: .summary)
    }
}

/// The page of one reel: its explanation, its sections by category, the insights, the verdict, the slides and the keywords.
public struct ReelDetail: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let createdAt: String?
    public let platform: String
    public let summary: String?
    public let imagePath: String?
    public let tags: [String]
    public let sections: [ReelSection]
    public let insights: [ReelInsight]
    public let verdict: ReelVerdict?
    public let slides: [ReelSlide]

    public init(
        id: String, createdAt: String? = nil, platform: String = "", summary: String? = nil, imagePath: String? = nil, tags: [String] = [],
        sections: [ReelSection] = [], insights: [ReelInsight] = [], verdict: ReelVerdict? = nil, slides: [ReelSlide] = []
    ) {
        self.id = id
        self.createdAt = createdAt
        self.platform = platform
        self.summary = summary
        self.imagePath = imagePath
        self.tags = tags
        self.sections = sections
        self.insights = insights
        self.verdict = verdict
        self.slides = slides
    }

    public var platformName: String { ReelPlatform.name(platform) }

    public func dateLine(now: Date = Date(), calendar: Calendar = .current, locale: Locale = Locale(identifier: "it_IT")) -> String {
        ReelPlatform.line(platform: platform, createdAt: createdAt, now: now, calendar: calendar, locale: locale)
    }

    /// The explanation in words, or nothing when the analysis wrote none (blanks are none).
    public var explanation: String? {
        guard let text = summary?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }

    public var hasExplanation: Bool { explanation != nil }

    /// The songs of the reel, in the order of the section: the only part of a reel that can go to the phone.
    public var musicTracks: [OfflineTrack] { sections.filter { $0.kind == .music }.flatMap(\.tracks) }

    enum CodingKeys: String, CodingKey { case id, createdAt, platform, summary, imagePath, tags, sections, insights, verdict, slides }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        platform = (try? c.decodeIfPresent(String.self, forKey: .platform)) ?? ""
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
        imagePath = try? c.decodeIfPresent(String.self, forKey: .imagePath)
        tags = (try? c.decodeIfPresent([String].self, forKey: .tags)) ?? []
        sections = ((try? c.decodeIfPresent([LossyDecodable<ReelSection>].self, forKey: .sections)) ?? nil)?.compactMap(\.value) ?? []
        insights = ((try? c.decodeIfPresent([LossyDecodable<ReelInsight>].self, forKey: .insights)) ?? nil)?.compactMap(\.value) ?? []
        verdict = (try? c.decodeIfPresent(ReelVerdict.self, forKey: .verdict)) ?? nil
        slides = ((try? c.decodeIfPresent([LossyDecodable<ReelSlide>].self, forKey: .slides)) ?? nil)?.compactMap(\.value) ?? []
    }
}
