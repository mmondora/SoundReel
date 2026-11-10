// PlaylistList.swift — the list of playlists as the person asks for it (ADR-0023, spec 2026-11-10-auto-playlists-and-playlist-list-design.md §3.B).
// Michele, 10 November: «Se le play list diventano molte devo poterle selezionare/paginare/cercare, e di fianco al nome la data di creazione e un
// ordine di data. questo anche su mondrop.»
//
// The SERVER searches, filters, sorts and cuts the list in pages (rule P): the app asks for a page with `q`, `filter`, `sort`, `order`, `limit`,
// `offset` and draws what comes back; it never downloads every playlist to find one. A server that does not know the parameters answers with
// every playlist and no `total`: the page is then that list.

import Foundation

/// What the list can be narrowed to.
public enum PlaylistFilter: String, CaseIterable, Identifiable, Sendable {
    case all, auto, mine, shared, dynamic

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .all: return "Tutte"
        case .auto: return "Automatiche"
        case .mine: return "Mie"
        case .shared: return "Condivise"
        case .dynamic: return "Dinamiche"
        }
    }
}

public enum PlaylistOrder: String, Sendable {
    case asc, desc
}

/// What the list can be sorted by. By date of creation (the newest first) is the one Michele asked for.
public enum PlaylistSort: String, CaseIterable, Identifiable, Sendable {
    case created, updated, name, size

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .created: return "Data di creazione"
        case .updated: return "Ultima modifica"
        case .name: return "Nome"
        case .size: return "Numero di brani"
        }
    }

    /// A to Z by name; the newest or the biggest first for the others.
    public var naturalOrder: PlaylistOrder { self == .name ? .asc : .desc }

    /// What the two directions mean for this sort, in words.
    public func orderTitle(_ order: PlaylistOrder) -> String {
        switch (self, order) {
        case (.created, .desc), (.updated, .desc): return "Più recenti prima"
        case (.created, .asc), (.updated, .asc): return "Più vecchie prima"
        case (.name, .asc): return "Da A a Z"
        case (.name, .desc): return "Da Z a A"
        case (.size, .desc): return "Più brani prima"
        case (.size, .asc): return "Meno brani prima"
        }
    }
}

public struct PlaylistListQuery: Equatable, Sendable {
    public var text: String
    public var filter: PlaylistFilter
    public var sort: PlaylistSort
    public var order: PlaylistOrder
    public var limit: Int
    public var offset: Int

    public init(
        text: String = "", filter: PlaylistFilter = .all, sort: PlaylistSort = .created, order: PlaylistOrder = .desc,
        limit: Int = 30, offset: Int = 0
    ) {
        self.text = text
        self.filter = filter
        self.sort = sort
        self.order = order
        self.limit = limit
        self.offset = offset
    }

    /// The query string, in the order the server documents (the `user` hint is added last by the API).
    public var queryItems: [(String, String)] {
        var items: [(String, String)] = []
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !words.isEmpty { items.append(("q", words)) }
        items.append(("filter", filter.rawValue))
        items.append(("sort", sort.rawValue))
        items.append(("order", order.rawValue))
        items.append(("limit", String(limit)))
        items.append(("offset", String(offset)))
        return items
    }

    /// The same question without the page: two answers belong together when this is equal.
    var withoutPage: PlaylistListQuery {
        var copy = self
        copy.offset = 0
        return copy
    }
}

/// One page, with how many playlists matched in all.
public struct PlaylistPage: Equatable, Sendable {
    public let playlists: [MondropPlaylist]
    public let total: Int
    public let limit: Int?
    public let offset: Int

    public init(playlists: [MondropPlaylist], total: Int, limit: Int? = nil, offset: Int = 0) {
        self.playlists = playlists
        self.total = total
        self.limit = limit
        self.offset = offset
    }
}

public protocol PlaylistListTransport: Sendable {
    func playlistsPage(_ query: PlaylistListQuery) async throws -> PlaylistPage
}

extension MondropAPI: PlaylistListTransport {
    /// `GET /api/mondrop/playlists?q&filter&sort&order&limit&offset`. Read-only.
    public func playlistsPage(_ query: PlaylistListQuery) async throws -> PlaylistPage {
        struct Wire: Decodable {
            let playlists: [MondropPlaylist]
            let total: Int?
            let limit: Int?
            let offset: Int?
        }
        let data = try await sendRequest(path: "/api/mondrop/playlists", timeout: 30, query: query.queryItems)
        let wire = try decodeBody(Wire.self, from: data)
        return PlaylistPage(playlists: wire.playlists, total: wire.total ?? wire.playlists.count, limit: wire.limit, offset: wire.offset ?? 0)
    }
}

/// «oggi», «ieri», «10 nov», «24 dic 2025»: the creation date as it is written beside the name of a playlist.
public enum PlaylistDateText {
    public static func parse(_ iso: String?) -> Date? {
        guard let iso, !iso.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: iso) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: iso)
    }

    /// An unreadable or missing date is no text at all.
    public static func text(
        _ iso: String?, now: Date = Date(), calendar: Calendar = .current, locale: Locale = Locale(identifier: "it_IT")
    ) -> String {
        guard let date = parse(iso) else { return "" }
        if calendar.isDate(date, inSameDayAs: now) { return "oggi" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "ieri" }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        formatter.setLocalizedDateFormatFromTemplate(sameYear ? "d MMM" : "d MMM y")
        return formatter.string(from: date)
    }
}

/// The list on the screen: the text typed, the filter, the sort, the pages. The work is the server's; this keeps what came back and ignores
/// an answer that is already out of date (the person typed again while it was on its way).
@MainActor
public final class PlaylistListModel: ObservableObject {
    public static let pageSize = 30
    /// The search waits for a pause in the typing before it asks the server.
    public static let searchDelay: UInt64 = 250_000_000

    @Published public private(set) var items: [MondropPlaylist] = []
    @Published public private(set) var total = 0
    /// The first page of a question is on its way.
    @Published public private(set) var loading = false
    @Published public private(set) var loadingMore = false
    @Published public private(set) var failure: String?
    @Published public private(set) var text = ""
    @Published public private(set) var filter: PlaylistFilter = .all
    @Published public private(set) var sort: PlaylistSort = .created
    @Published public private(set) var order: PlaylistOrder = .desc

    private let transport: PlaylistListTransport
    private let pageSize: Int
    private let searchDelay: UInt64
    private var turn = 0
    private var task: Task<Void, Never>?
    private var lastGood: PlaylistListQuery?

    public init(transport: PlaylistListTransport, pageSize: Int = PlaylistListModel.pageSize, searchDelay: UInt64 = PlaylistListModel.searchDelay) {
        self.transport = transport
        self.pageSize = pageSize
        self.searchDelay = searchDelay
    }

    /// The change in flight (a test waits for it).
    public var work: Task<Void, Never>? { task }

    public var hasMore: Bool { items.count < total }

    /// A search or a filter narrows the list: «no playlist» then means «none matches», not «none yet».
    public var narrowed: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || filter != .all }

    private var query: PlaylistListQuery {
        PlaylistListQuery(text: text, filter: filter, sort: sort, order: order, limit: pageSize, offset: 0)
    }

    // MARK: - What the person does

    public func setText(_ value: String) {
        guard value != text else { return }
        text = value
        schedule(after: searchDelay)
    }

    public func setFilter(_ value: PlaylistFilter) {
        guard value != filter else { return }
        filter = value
        schedule(after: 0)
    }

    /// Choosing a sort puts its natural direction; the arrow then flips it.
    public func setSort(_ value: PlaylistSort) {
        guard value != sort else { return }
        sort = value
        order = value.naturalOrder
        schedule(after: 0)
    }

    public func toggleOrder() {
        order = order == .desc ? .asc : .desc
        schedule(after: 0)
    }

    public func reload() async {
        task?.cancel()
        await run(offset: 0, append: false)
    }

    public func loadMore() async {
        guard hasMore, !loading, !loadingMore else { return }
        await run(offset: items.count, append: true)
    }

    // MARK: - Asking

    private func schedule(after delay: UInt64) {
        task?.cancel()
        task = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
            guard !Task.isCancelled, let self else { return }
            await self.run(offset: 0, append: false)
        }
    }

    private func run(offset: Int, append: Bool) async {
        turn += 1
        let mine = turn
        if append { loadingMore = true } else { loading = true }
        var asked = query
        asked.offset = offset
        do {
            let page = try await transport.playlistsPage(asked)
            guard mine == turn else { return }
            failure = nil
            total = page.total
            if append {
                // a playlist made meanwhile shifts the pages: never show the same one twice
                let seen = Set(items.map(\.id))
                items += page.playlists.filter { !seen.contains($0.id) }
            } else {
                items = page.playlists
            }
            lastGood = asked.withoutPage
        } catch {
            guard mine == turn else { return }
            failure = (error as? MondropAPIError)?.description ?? error.localizedDescription
            // the list of the same question stays (a stale one is better than a blank one); the list of another question does not
            if !append, lastGood != asked.withoutPage {
                items = []
                total = 0
            }
        }
        if mine == turn {
            loading = false
            loadingMore = false
        }
    }
}
