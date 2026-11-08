// LibraryBrowseModel.swift — the list behind «Libreria»: the songs the filters select, the headings to choose from,
// the playlists. Online it asks `GET /api/mondrop/library`; offline (or when the user asks for «solo sul telefono») it
// answers the same questions from the songs on the device (LibraryCatalog), so the screen never goes blank.

import Foundation

@MainActor
public final class LibraryBrowseModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case loadingMore
    }

    /// Where the list on screen comes from.
    public enum Source: Equatable, Sendable {
        case server
        /// The user asked for «solo sul telefono».
        case phone
        /// The server could not be asked (no network, unreachable, an older backend): the songs on the phone, and why.
        case phoneFallback(String)

        public var isPhone: Bool { self != .server }

        /// The banner above the list; nil when everything is as usual.
        public var notice: String? {
            switch self {
            case .server: return nil
            case .phone: return "Solo i brani scaricati sul telefono."
            case .phoneFallback(let reason): return "Server non raggiungibile: mostro i brani scaricati sul telefono (\(reason))."
            }
        }
    }

    @Published public private(set) var songs: [OfflineTrack] = []
    /// Everything that matches, not only what is loaded.
    @Published public private(set) var total = 0
    @Published public private(set) var facets = LibraryFacets.empty
    @Published public private(set) var source: Source = .server
    @Published public private(set) var phase: Phase = .idle
    @Published public private(set) var playlists: [MondropPlaylist] = []
    /// A next page that could not be loaded (the list on screen is still good).
    @Published public private(set) var pagingError: String?

    /// Set by the view, then `reload()` — the model never reloads behind the view's back.
    public var filters: LibraryFilters
    public var onlyOnPhone: Bool

    private let api: LibraryBackend
    private let store: OfflineStore
    private let activity: SyncActivity?
    private let clock: PreparationClock
    private let pageSize: Int
    /// Bumped by every `reload`: an answer that arrives after a newer request started is dropped.
    private var generation = 0

    public init(
        api: LibraryBackend,
        store: OfflineStore,
        filters: LibraryFilters = .none,
        onlyOnPhone: Bool = false,
        activity: SyncActivity? = nil,
        clock: PreparationClock = .real,
        pageSize: Int = LibraryQuery.defaultLimit
    ) {
        self.api = api
        self.store = store
        self.filters = filters
        self.onlyOnPhone = onlyOnPhone
        self.activity = activity
        self.clock = clock
        self.pageSize = pageSize
    }

    public var canLoadMore: Bool { source == .server && songs.count < total }

    // MARK: - Songs

    public func reload() async {
        generation += 1
        let mine = generation
        phase = .loading
        defer { if mine == generation { phase = .idle } }
        pagingError = nil
        if onlyOnPhone {
            showPhone(.phone)
            return
        }
        do {
            let page = try await api.library(LibraryQuery(filters: filters, limit: pageSize, offset: 0, withFacets: true))
            guard mine == generation else { return }
            songs = page.songs
            total = page.total
            facets = page.facets ?? .empty
            source = .server
            note(page.songs)
        } catch {
            if Self.isCancellation(error) { return }
            guard mine == generation else { return }
            showPhone(.phoneFallback(Self.describe(error)))
        }
    }

    /// The next page (only from the server; the phone's list is complete from the start).
    public func loadMore(pageLimit: Int? = nil) async {
        guard canLoadMore, phase == .idle else { return }
        let mine = generation
        phase = .loadingMore
        defer { if mine == generation { phase = .idle } }
        do {
            let page = try await api.library(
                LibraryQuery(filters: filters, limit: pageLimit ?? pageSize, offset: songs.count, withFacets: false)
            )
            guard mine == generation else { return }
            let known = Set(songs.map(\.songKey))
            songs += page.songs.filter { !known.contains($0.songKey) }
            // The server counted more than it gave: stop asking instead of looping.
            total = page.songs.isEmpty ? songs.count : max(page.total, songs.count)
            pagingError = nil
            note(page.songs)
        } catch {
            if Self.isCancellation(error) { return }
            guard mine == generation else { return }
            pagingError = Self.describe(error)
        }
    }

    /// Before «Suona» / «Mescola»: the queue must be the whole choice, not the first page of it.
    public func loadAll(maxSongs: Int = 2500) async {
        while canLoadMore, songs.count < maxSongs {
            let before = songs.count
            await loadMore(pageLimit: LibraryQuery.maxLimit)
            if songs.count == before { break }
        }
    }

    /// While the server prepares songs of this list (a first play asked for one, a sync is running), read it again
    /// every `interval` so the spinners turn into marks. Gives up after `timeout`; stops when the task is cancelled.
    public func pollWhilePreparing(interval: TimeInterval = 5, timeout: TimeInterval = 600) async {
        let started = clock.now()
        while source == .server, songs.contains(where: { $0.resolvedState == .preparing }) {
            if clock.now().timeIntervalSince(started) >= timeout { return }
            do {
                try await clock.sleep(interval)
            } catch {
                return
            }
            if Task.isCancelled { return }
            let mine = generation
            do {
                let limit = min(max(songs.count, pageSize), LibraryQuery.maxLimit)
                let page = try await api.library(LibraryQuery(filters: filters, limit: limit, offset: 0, withFacets: false))
                guard mine == generation else { return }     // a reload took over
                let fresh = Dictionary(page.songs.map { ($0.songKey, $0) }, uniquingKeysWith: { _, last in last })
                songs = songs.map { fresh[$0.songKey] ?? $0 }
                note(page.songs)
            } catch {
                return                                       // quiet: the list stays as it is
            }
        }
    }

    // MARK: - Playlists

    /// The playlists to choose from, narrowed by the words in `text`. Offline: the ones the app has seen, with the
    /// songs of each that are on the phone.
    public func reloadPlaylists(matching text: String = "") async {
        var list: [MondropPlaylist]
        if onlyOnPhone {
            list = phonePlaylists()
        } else {
            do {
                list = try await api.listPlaylists()
            } catch {
                if Self.isCancellation(error) { return }
                list = phonePlaylists()
            }
        }
        let tokens = SearchText.tokens(text)
        if !tokens.isEmpty {
            list = list.filter { playlist in
                let name = SearchText.normalize(playlist.name)
                return tokens.allSatisfy { name.contains($0) }
            }
        }
        playlists = list
    }

    private func phonePlaylists() -> [MondropPlaylist] {
        let local = store.localSongKeys()
        return store.playlistMemberships().compactMap { membership in
            let count = membership.songKeys.filter { local.contains($0) }.count
            return count > 0 ? MondropPlaylist(id: membership.id, name: membership.name, songCount: count) : nil
        }
    }

    // MARK: - Helpers

    private func showPhone(_ source: Source) {
        let page = LibraryCatalog.page(of: store.localTracks(), filters: filters, limit: 100_000, offset: 0, withFacets: true)
        songs = page.songs
        total = page.total
        facets = page.facets ?? .empty
        self.source = source
    }

    /// What the server told us about these songs: album / genres / year for the ones on the phone, and which are
    /// being prepared.
    private func note(_ tracks: [OfflineTrack]) {
        store.recordMetadata(from: tracks)
        activity?.observe(tracks)
    }

    static func isCancellation(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }

    static func describe(_ error: Error) -> String {
        if case .http(404, _)? = error as? MondropAPIError {
            return "il server non ha ancora la Libreria: backend da aggiornare"
        }
        return (error as? MondropAPIError)?.description ?? error.localizedDescription
    }
}
