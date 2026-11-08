// SearchModel.swift — the list behind «Cerca»: the songs the words select, the artists and the albums they come from.
// Online it asks `GET /api/mondrop/search` (the SERVER searches the journal, geekom's library and the NAS: rule P);
// offline — or with «Solo sul telefono» — it answers the same questions from the songs on the device (LibraryCatalog),
// so the screen never goes blank (spec 2026-11-08-mondrop-search-spotify-style-design.md S7).

import Foundation

/// The user's playlists, to find one by name among the results (a fake in tests).
public protocol PlaylistListing: Sendable {
    func listPlaylists() async throws -> [MondropPlaylist]
}

extension MondropAPI: PlaylistListing {}

@MainActor
public final class SearchModel: ObservableObject {
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

        /// The line above the results; nil when everything is as usual.
        public var notice: String? {
            switch self {
            case .server: return nil
            case .phone: return "Solo i brani scaricati sul telefono."
            case .phoneFallback(let reason): return "Server non raggiungibile: cerco tra i brani scaricati sul telefono (\(reason))."
            }
        }
    }

    @Published public private(set) var tracks: [OfflineTrack] = []
    @Published public private(set) var artists: [SearchArtistHit] = []
    @Published public private(set) var albums: [SearchAlbumHit] = []
    /// The playlists whose NAME has the words (a search for «rap» finds the playlist «Rap»); none on an artist or album page.
    @Published public private(set) var playlists: [MondropPlaylist] = []
    /// Every SONG that matches, not only what is loaded.
    @Published public private(set) var total = 0
    @Published public private(set) var source: Source = .server
    @Published public private(set) var phase: Phase = .idle
    /// A next page that could not be loaded (the list on screen is still good).
    @Published public private(set) var pagingError: String?
    /// A search has finished for the words now in the box: only then may «Nessun risultato» be said.
    @Published public private(set) var didSearch = false

    /// Set by the view, then `reload()` — the model never searches behind the view's back.
    public var text: String
    public var artist: String
    public var album: String
    public var onlyOnPhone: Bool

    private let api: SearchTransport
    private let playlistSource: PlaylistListing?
    private let store: OfflineStore
    private let activity: SyncActivity?
    private let clock: PreparationClock
    private let pageSize: Int
    /// Bumped by every `reload`: an answer that arrives after a newer search started is dropped.
    private var generation = 0
    /// The playlists, read once a minute at most (a search runs at every pause of the typing).
    private var playlistCache: (list: [MondropPlaylist], at: Date)?
    static let playlistCacheAge: TimeInterval = 60

    public init(
        api: SearchTransport,
        playlists playlistSource: PlaylistListing? = nil,
        store: OfflineStore,
        text: String = "",
        artist: String = "",
        album: String = "",
        onlyOnPhone: Bool = false,
        activity: SyncActivity? = nil,
        clock: PreparationClock = .real,
        pageSize: Int = SearchQuery.defaultLimit
    ) {
        self.api = api
        self.playlistSource = playlistSource
        self.store = store
        self.text = text
        self.artist = artist
        self.album = album
        self.onlyOnPhone = onlyOnPhone
        self.activity = activity
        self.clock = clock
        self.pageSize = pageSize
    }

    /// The first page of what is in the box now.
    public var query: SearchQuery {
        SearchQuery(text: text, artist: artist, album: album, limit: pageSize, offset: 0, withSections: true)
    }

    public var canLoadMore: Bool { source == .server && tracks.count < total }

    // MARK: - Searching

    public func reload() async {
        generation += 1
        let mine = generation
        pagingError = nil
        let asked = query
        if asked.isEmpty {
            // Nothing to look for: the server would refuse it, and a list of all the music is not a search.
            clear()
            phase = .idle
            return
        }
        phase = .loading
        defer { if mine == generation { phase = .idle } }
        if onlyOnPhone {
            showPhone(.phone)
            return
        }
        do {
            let page = try await api.search(asked)
            guard mine == generation else { return }
            tracks = Self.unique(page.tracks)
            artists = page.artists
            albums = page.albums
            total = max(page.total, tracks.count)
            source = .server
            didSearch = true
            note(page.tracks)
            let found = await matchingPlaylists()
            guard mine == generation else { return }
            playlists = found
        } catch {
            if Self.isCancellation(error) { return }
            guard mine == generation else { return }
            showPhone(.phoneFallback(Self.describe(error)))
        }
    }

    /// The next page of songs (only from the server; the phone's list is complete from the start).
    public func loadMore(pageLimit: Int? = nil) async {
        guard canLoadMore, phase == .idle else { return }
        let mine = generation
        phase = .loadingMore
        defer { if mine == generation { phase = .idle } }
        var next = query
        next.offset = tracks.count
        next.limit = pageLimit ?? pageSize
        next.withSections = false
        do {
            let page = try await api.search(next)
            guard mine == generation else { return }
            let known = Set(tracks.map(\.songKey))
            tracks += Self.unique(page.tracks).filter { !known.contains($0.songKey) }
            // The server counted more than it gave: stop asking instead of looping.
            total = page.tracks.isEmpty ? tracks.count : max(page.total, tracks.count)
            pagingError = nil
            note(page.tracks)
        } catch {
            if Self.isCancellation(error) { return }
            guard mine == generation else { return }
            pagingError = Self.describe(error)
        }
    }

    /// Before «Riproduci» / «Casuale» and before a tap that queues what follows: the queue must hold the songs that follow, not
    /// just the first page of them.
    public func loadAll(maxTracks: Int = 500) async {
        while canLoadMore, tracks.count < maxTracks {
            let before = tracks.count
            await loadMore(pageLimit: SearchQuery.maxLimit)
            if tracks.count == before { break }
        }
    }

    /// Reads the list again (the first `limit` songs, never more than the server gives in one answer) and keeps what changed: a
    /// spinner turns into a mark. Quiet: a failure leaves the list as it is. `false` when it could not (or a new search took over).
    @discardableResult
    public func refresh() async -> Bool {
        guard source == .server else { return false }
        let mine = generation
        var again = query
        again.limit = min(max(tracks.count, pageSize), SearchQuery.maxLimit)
        again.withSections = false
        do {
            let page = try await api.search(again)
            guard mine == generation else { return false }     // a new search took over
            let fresh = Dictionary(page.tracks.map { ($0.songKey, $0) }, uniquingKeysWith: { _, last in last })
            tracks = tracks.map { fresh[$0.songKey] ?? $0 }
            note(page.tracks)
            return true
        } catch {
            return false
        }
    }

    /// While the server prepares songs of this list (a first play asked for one, or «Scarica tutti»), read it again every
    /// `interval` so the spinners turn into marks. Gives up after `timeout`; stops when the task is cancelled.
    /// `onRefresh`: what to do with the list each time it is read again («Scarica tutti» downloads what has become ready).
    public func pollWhilePreparing(interval: TimeInterval = 5, timeout: TimeInterval = 600, onRefresh: (([OfflineTrack]) -> Void)? = nil) async {
        let started = clock.now()
        while source == .server, tracks.contains(where: { $0.resolvedState == .preparing }) {
            if clock.now().timeIntervalSince(started) >= timeout { return }
            do {
                try await clock.sleep(interval)
            } catch {
                return
            }
            if Task.isCancelled { return }
            guard await refresh() else { return }              // quiet: the list stays as it is
            onRefresh?(tracks)
        }
    }

    // MARK: - On the phone

    private func clear() {
        tracks = []
        artists = []
        albums = []
        playlists = []
        total = 0
        source = .server
        didSearch = false
    }

    private func showPhone(_ source: Source) {
        let filters = LibraryFilters(q: text, album: album, artist: artist)
        let page = LibraryCatalog.page(of: store.localTracks(), filters: filters, limit: 100_000, offset: 0, withFacets: false)
        tracks = page.songs
        total = page.total
        let found = SearchSections.of(page.songs, text: text, artistPage: !artist.isBlank, albumPage: !album.isBlank)
        artists = found.artists
        albums = found.albums
        playlists = phonePlaylists()
        self.source = source
        didSearch = true
    }

    // MARK: - Playlists

    /// Playlists are searched by name, with the same words, on the main search only (an artist or an album page is about
    /// that artist or album).
    private var wantsPlaylists: Bool { artist.isBlank && album.isBlank && !SearchText.tokens(text).isEmpty }

    private static func named(_ playlist: MondropPlaylist, with tokens: [String]) -> Bool {
        let name = SearchText.normalize(playlist.name)
        return tokens.allSatisfy { name.contains($0) }
    }

    private func matchingPlaylists() async -> [MondropPlaylist] {
        guard wantsPlaylists, let playlistSource else { return [] }
        let tokens = SearchText.tokens(text)
        if let cache = playlistCache, clock.now().timeIntervalSince(cache.at) < Self.playlistCacheAge {
            return cache.list.filter { Self.named($0, with: tokens) }
        }
        // A playlist list that cannot be read costs the playlists, never the songs.
        guard let list = try? await playlistSource.listPlaylists() else { return [] }
        playlistCache = (list, clock.now())
        return list.filter { Self.named($0, with: tokens) }
    }

    /// Offline: the playlists the app has seen, with the songs of each that are on the phone.
    private func phonePlaylists() -> [MondropPlaylist] {
        guard wantsPlaylists else { return [] }
        let tokens = SearchText.tokens(text)
        let local = store.localSongKeys()
        return store.playlistMemberships().compactMap { membership -> MondropPlaylist? in
            let count = membership.songKeys.filter { local.contains($0) }.count
            guard count > 0 else { return nil }
            let playlist = MondropPlaylist(id: membership.id, name: membership.name, songCount: count)
            return Self.named(playlist, with: tokens) ? playlist : nil
        }
    }

    // MARK: - Helpers

    /// A song once: the server counts songs, but a hiccup must never put two rows with one key in a list.
    static func unique(_ tracks: [OfflineTrack]) -> [OfflineTrack] {
        var seen = Set<String>()
        return tracks.filter { seen.insert($0.songKey).inserted }
    }

    /// What the server told us about these songs: album / genres / year for the ones on the phone, and which are being
    /// prepared.
    private func note(_ tracks: [OfflineTrack]) {
        store.recordMetadata(from: tracks)
        activity?.observe(tracks)
    }

    static func isCancellation(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }

    static func describe(_ error: Error) -> String {
        if case .http(404, _)? = error as? MondropAPIError {
            return "il server non ha ancora la ricerca: backend da aggiornare"
        }
        return (error as? MondropAPIError)?.description ?? error.localizedDescription
    }
}

/// The artists and albums of a list of songs, computed on the phone: what the server answers for the same words, over the
/// songs that are downloaded. A plain enum (no actor) so tests can share it.
enum SearchSections {
    static let limit = 6
    static let limitOnArtistPage = 60

    /// The artists whose name has the words typed (none on an artist page: they are all one artist), and the albums the songs
    /// found come from (none on an album page).
    static func of(
        _ songs: [OfflineTrack], text: String, artistPage: Bool, albumPage: Bool
    ) -> (artists: [SearchArtistHit], albums: [SearchAlbumHit]) {
        let facets = LibraryCatalog.facets(of: songs, filters: .none)
        var artists: [SearchArtistHit] = []
        let tokens = SearchText.tokens(text)
        if !artistPage, !tokens.isEmpty {
            artists = facets.artists
                .filter { entry in
                    let name = SearchText.normalize(entry.label)
                    return tokens.allSatisfy { name.contains($0) }
                }
                .prefix(limit)
                .map { SearchArtistHit(name: $0.label, tracks: $0.count) }
        }
        var albums: [SearchAlbumHit] = []
        if !albumPage {
            var byAlbum: [String: [String: Int]] = [:]
            for song in songs {
                guard let album = song.album, !SearchText.normalize(album).isEmpty else { continue }
                byAlbum[SearchText.normalize(album), default: [:]][song.artist, default: 0] += 1
            }
            let italian = Locale(identifier: "it")
            albums = facets.albums
                .prefix(artistPage ? limitOnArtistPage : limit)
                .map { entry in
                    let credited = byAlbum[SearchText.normalize(entry.label)] ?? [:]
                    let main = credited.sorted { a, b in
                        if a.value != b.value { return a.value > b.value }
                        return a.key.compare(b.key, locale: italian) == .orderedAscending
                    }.first?.key ?? ""
                    return SearchAlbumHit(title: entry.label, artist: main, tracks: entry.count)
                }
        }
        return (artists, albums)
    }
}
