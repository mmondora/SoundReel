// ReelsModel.swift — the tab «Reel» (ADR-0033, spec 2026-11-12-mondrop-home-play-loop-reels-design.md M5): the list of the reels the server composes, a page at a time, the categories to choose
// from, and the page of one reel. Only the network: nothing of a reel is kept on the phone («l'unica cosa che viene portata sulla device è la musica»), so without it the tab says it needs it.
// The server decides what a page holds, the total and which categories exist; this keeps what came back and ignores an answer that is already out of date (the person chose another
// category while it was on its way).

import Foundation

/// What the tab needs from the backend (a fake in tests).
public protocol ReelsTransport: Sendable {
    func reels(limit: Int, offset: Int, kind: ReelKind?, facets: Bool) async throws -> ReelPage
    func reel(id: String) async throws -> ReelDetail
}

extension MondropAPI: ReelsTransport {
    /// `GET /api/mondrop/reels?limit&offset&kind&facets`: a page of reels, newest first. Read-only. A server older than 2.27.0 answers 404 (the tab then asks for a newer SoundReel).
    public func reels(limit: Int, offset: Int, kind: ReelKind?, facets: Bool) async throws -> ReelPage {
        var query: [(String, String)] = [("limit", String(limit)), ("offset", String(offset))]
        if let kind { query.append(("kind", kind.raw)) }
        if facets { query.append(("facets", "1")) }
        let data = try await sendRequest(path: "/api/mondrop/reels", timeout: 30, query: query)
        return try decodeBody(ReelPage.self, from: data)
    }

    /// `GET /api/mondrop/reels/:id`: the page of one reel. 404 when it does not exist or is not the user's to read.
    public func reel(id: String) async throws -> ReelDetail {
        let data = try await sendRequest(path: "/api/mondrop/reels/\(Self.encodeSongKey(id))", timeout: 30)
        return try decodeBody(ReelDetail.self, from: data)
    }
}

/// What a failure is called on the screen.
enum ReelErrors {
    static let needsNetwork = "Serve la rete per leggere i reel."

    static func isNotFound(_ error: Error) -> Bool {
        if let api = error as? MondropAPIError, case .http(let status, _) = api { return status == 404 }
        return false
    }

    static func text(_ error: Error) -> String {
        if let api = error as? MondropAPIError {
            if case .transport = api { return needsNetwork }
            return api.description
        }
        if error is URLError { return needsNetwork }
        return error.localizedDescription
    }
}

/// What the tab shows, decided from what it has (so that the cases are tested, not guessed by the view).
public enum ReelsScreen: Equatable, Sendable {
    /// The first answer has not come yet.
    case loading
    /// Reels to draw. A reload that fails leaves them in place: a stale list is better than a blank one.
    case reels
    /// The server answered and has no reel for this user (and category).
    case empty
    case failed(String)
    /// The server does not have the routes yet (SoundReel older than 2.27.0).
    case needsNewerServer
}

@MainActor
public final class ReelsModel: ObservableObject {
    public static let pageSize = 20
    public static let needsNewerServerText = "Serve un SoundReel più recente"

    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case loaded
        case failed(String)
        case needsNewerServer
    }

    @Published public private(set) var reels: [ReelCard] = []
    @Published public private(set) var total = 0
    /// How many reels have each category, over all the reels (not the page, not the category chosen): asked with the first page.
    @Published public private(set) var kinds: [ReelKindCount] = []
    /// The category chosen, or nil for all of them.
    @Published public private(set) var selected: ReelKind?
    @Published public private(set) var phase: Phase = .idle
    @Published public private(set) var loadingMore = false
    /// A reload or a next page that failed while there was something to show: what is on screen stays, with a line that says so.
    @Published public private(set) var failure: String?

    private let transport: ReelsTransport
    /// Bumped by every question that replaces the list: an answer to an older one is ignored.
    private var generation = 0
    /// A next page brought nothing new (the list moved under it): no more asking.
    private var exhausted = false

    public init(transport: ReelsTransport) {
        self.transport = transport
    }

    public var hasMore: Bool { reels.count < total && !exhausted }

    public var screen: ReelsScreen {
        if !reels.isEmpty { return .reels }
        switch phase {
        case .idle, .loading: return .loading
        case .loaded: return .empty
        case .failed(let text): return .failed(text)
        case .needsNewerServer: return .needsNewerServer
        }
    }

    /// The first page of the category chosen, with the categories to choose from. A failure leaves what was there.
    public func load() async {
        generation += 1
        let mine = generation
        loadingMore = false         // a next page that was on its way is out of date now: its answer is ignored
        if reels.isEmpty { phase = .loading }
        do {
            let page = try await transport.reels(limit: Self.pageSize, offset: 0, kind: selected, facets: true)
            guard mine == generation else { return }
            replace(with: page, keepingKinds: false)
        } catch {
            guard mine == generation else { return }
            fail(error)
        }
    }

    /// Chooses a category (nil = all) and reads its first page. The list of the other category goes away at once: it would be the wrong list under the new chip.
    public func select(_ kind: ReelKind?) async {
        guard kind != selected || phase != .loaded else { return }
        selected = kind
        generation += 1
        let mine = generation
        reels = []
        total = 0
        exhausted = false
        loadingMore = false
        failure = nil
        phase = .loading
        do {
            let page = try await transport.reels(limit: Self.pageSize, offset: 0, kind: kind, facets: false)
            guard mine == generation else { return }
            replace(with: page, keepingKinds: true)
        } catch {
            guard mine == generation else { return }
            fail(error)
        }
    }

    /// The next page, from where the list ends. A reel already held is not added twice (a new reel may have pushed it to the next page).
    public func loadMore() async {
        guard phase == .loaded, hasMore, !loadingMore else { return }
        loadingMore = true
        let mine = generation
        defer { if mine == generation { loadingMore = false } }
        do {
            let page = try await transport.reels(limit: Self.pageSize, offset: reels.count, kind: selected, facets: false)
            guard mine == generation else { return }
            let known = Set(reels.map(\.id))
            let fresh = page.reels.filter { !known.contains($0.id) }
            if fresh.isEmpty { exhausted = true } else { reels += fresh }
            total = page.total
            failure = nil
        } catch {
            guard mine == generation else { return }
            failure = ReelErrors.text(error)
        }
    }

    private func replace(with page: ReelPage, keepingKinds: Bool) {
        var seen = Set<String>()
        reels = page.reels.filter { seen.insert($0.id).inserted }
        total = page.total
        if !keepingKinds { kinds = page.kinds }
        exhausted = false
        failure = nil
        phase = .loaded
    }

    private func fail(_ error: Error) {
        if ReelErrors.isNotFound(error) {
            phase = .needsNewerServer
            failure = nil
        } else if reels.isEmpty {
            phase = .failed(ReelErrors.text(error))
        } else {
            failure = ReelErrors.text(error)
        }
    }
}

/// The page of one reel.
@MainActor
public final class ReelDetailModel: ObservableObject {
    public static let goneText = "Questo reel non c'è più."

    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case loaded
        case failed(String)
        /// Not there (any more) or not the user's to read.
        case gone
    }

    public let id: String
    @Published public private(set) var detail: ReelDetail?
    @Published public private(set) var phase: Phase = .idle
    /// A reload that failed while there was something to show.
    @Published public private(set) var failure: String?

    private let transport: ReelsTransport

    public init(id: String, transport: ReelsTransport) {
        self.id = id
        self.transport = transport
    }

    public func load() async {
        if detail == nil { phase = .loading }
        do {
            detail = try await transport.reel(id: id)
            phase = .loaded
            failure = nil
        } catch {
            if ReelErrors.isNotFound(error) {
                if detail == nil { phase = .gone } else { failure = Self.goneText }
            } else if detail == nil {
                phase = .failed(ReelErrors.text(error))
            } else {
                failure = ReelErrors.text(error)
            }
        }
    }
}
