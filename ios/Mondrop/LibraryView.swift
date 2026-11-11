// LibraryView.swift — «Libreria»: browse the music by playlist, album, author, tipo, decade («Anni 80») or song, with a
// filter; the choice becomes the queue shown as «In coda» (spec 2026-11-08-player-selection-and-filters-design.md §X1–X3).
// Since 1.7.0 it is no longer a tab: «Cerca» replaced the tab and opens this screen from its «Sfoglia» list
// (spec 2026-11-08-mondrop-search-spotify-style-design.md S5).
//
// Online it browses `GET /api/mondrop/library`; offline — or with «Solo sul telefono» — it browses what is downloaded.
// The rules (filters, headings, queue) are pure code in MondropKit; this file only draws and wires them.

import SwiftUI

enum LibraryDimension: String, CaseIterable, Identifiable {
    case playlists, albums, artists, genres, decades, songs

    var id: String { rawValue }

    var title: String {
        switch self {
        case .playlists: return "Playlist"
        case .albums: return "Album"
        case .artists: return "Autori"
        case .genres: return "Tipi"
        case .decades: return "Anni"
        case .songs: return "Brani"
        }
    }

    var emptyText: String {
        switch self {
        case .playlists: return "Nessuna playlist."
        case .albums: return "Nessun album."
        case .artists: return "Nessun autore."
        case .genres: return "Nessun tipo."
        case .decades: return "Nessun anno."
        case .songs: return "Nessun brano."
        }
    }
}

/// Starts the queue for a choice. The queue is the WHOLE choice, not the first page of it: the rest is loaded first.
@MainActor
enum LibraryPlayback {
    static func start(
        model: LibraryBrowseModel, choice: LibraryChoice, startAt songKey: String? = nil,
        shuffled: Bool = false, localKeys: Set<String>, only: OfflineTrack? = nil
    ) async {
        if only == nil { await model.loadAll() }
        let tracks = only.map { [$0] } ?? model.songs
        guard let queue = LibraryQueueBuilder.make(
            choice: choice, tracks: tracks, startAt: songKey, shuffled: shuffled, isLocal: { localKeys.contains($0) }
        ) else { return }
        LocalAudioPlayer.shared.start(queue)
    }
}

struct LibraryView: View {
    @StateObject private var model: LibraryBrowseModel
    @ObservedObject private var player = LocalAudioPlayer.shared
    @ObservedObject private var engine = SyncEngine.shared
    @State private var dimension: LibraryDimension = .playlists
    @State private var searchText = ""
    @State private var onlyOnPhone: Bool
    @State private var localKeys: Set<String> = []
    @State private var showQueue = false

    init(initialDimension: LibraryDimension = .playlists, onlyOnPhone: Bool = false) {
        _dimension = State(initialValue: initialDimension)
        _onlyOnPhone = State(initialValue: onlyOnPhone)
        _model = StateObject(
            wrappedValue: LibraryBrowseModel(api: MondropAPI(), store: .shared, activity: .shared)
        )
    }

    private struct LoadTrigger: Equatable {
        let text: String
        let onlyOnPhone: Bool
    }

    var body: some View {
        List {
            if !player.queue.isEmpty { queueSection }
            Section { dimensionChips }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            if let notice = model.source.notice {
                Section {
                    Text(notice).font(.footnote).foregroundStyle(.orange)
                }
            }
            if let paging = model.pagingError {
                Section { Text("Non riesco a caricare altri brani: \(paging)").font(.footnote).foregroundStyle(.red) }
            }
            content
        }
        .navigationTitle("Libreria")
        .withMiniPlayer()
        .searchable(text: $searchText, prompt: "Cerca autore, titolo, album")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Toggle("Solo sul telefono", isOn: $onlyOnPhone)
                    Button("Ricarica") { Task { await refresh() } }
                } label: {
                    Label("Opzioni", systemImage: onlyOnPhone ? "iphone" : "ellipsis.circle")
                }
            }
        }
        .task(id: LoadTrigger(text: searchText, onlyOnPhone: onlyOnPhone)) {
            // Typing: wait for a pause before asking the server (a changed id cancels this task, so a keystroke
            // that is followed by another one never reaches the network).
            if !searchText.isBlank {
                try? await Task.sleep(for: .milliseconds(300))
                if Task.isCancelled { return }
            }
            await refresh()
            // Songs the server is preparing turn into marks while this screen is open.
            await model.pollWhilePreparing()
        }
        .refreshable { await refresh() }
        .onAppear { localKeys = engine.store.localSongKeys() }
        .onChange(of: engine.revision) { _, _ in localKeys = engine.store.localSongKeys() }
        .sheet(isPresented: $showQueue) { QueueView() }
    }

    private func refresh() async {
        model.filters = LibraryFilters(q: searchText)
        model.onlyOnPhone = onlyOnPhone
        await model.reload()
        await model.reloadPlaylists(matching: searchText)
        localKeys = engine.store.localSongKeys()
    }

    // MARK: sections

    /// «In coda»: what the choice made earlier is, and where it is.
    private var queueSection: some View {
        Section {
            Button { showQueue = true } label: {
                HStack(spacing: 10) {
                    Image(systemName: "list.bullet").foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("In coda").font(.caption).foregroundStyle(.secondary)
                        Text(player.queueLabel ?? "Coda").font(.subheadline.bold()).lineLimit(1)
                        Text("\(player.index + 1) di \(player.queue.count) · \(player.title)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    Image(systemName: "chevron.up").font(.caption).foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
        }
    }

    private var dimensionChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(LibraryDimension.allCases) { item in
                    Button { dimension = item } label: {
                        Text(item.title)
                            .font(.subheadline.weight(dimension == item ? .bold : .regular))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 7)
                            .background(
                                dimension == item ? Color.accentColor.opacity(0.22) : Color.secondary.opacity(0.12),
                                in: Capsule()
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch dimension {
        case .playlists: playlistsSection
        case .albums: facetSection(model.facets.albums, kind: .albums)
        case .artists: facetSection(model.facets.artists, kind: .artists)
        case .genres: facetSection(model.facets.genres, kind: .genres)
        case .decades: facetSection(model.facets.decades, kind: .decades)
        case .songs: songsSection
        }
    }

    private var playlistsSection: some View {
        Section {
            if model.playlists.isEmpty {
                Text(dimension.emptyText).foregroundStyle(.secondary)
            }
            let marks = PlaylistMarks.current(store: engine.store, local: localKeys, progress: engine.progress)
            // the playlists that are on the phone first, then the ones that are only online, each with its mark
            ForEach(marks.ordered(model.playlists, id: \.id, songCount: \.songCount)) { playlist in
                NavigationLink {
                    PlaylistOfflineView(playlist: playlist)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            PlaylistStateMark(state: marks.state(id: playlist.id, songCount: playlist.songCount))
                            Text(playlist.name).font(.headline)
                            if playlist.isDynamic { DynamicBadge() }
                        }
                        Text(playlist.isDynamic && playlist.songCount == 0 ? "si calcola quando la apri" : "\(playlist.songCount) brani")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        } footer: {
            Text("Apri una playlist per ascoltarla, tutta o da un brano: quella che suoni si scarica da sola sul telefono.")
        }
    }

    private func facetSection(_ entries: [LibraryFacetEntry], kind: LibraryDimension) -> some View {
        Section {
            if entries.isEmpty {
                Text(dimension.emptyText).foregroundStyle(.secondary)
            }
            ForEach(entries) { entry in
                NavigationLink {
                    LibrarySelectionView(
                        choice: Self.choice(for: entry, kind: kind),
                        title: entry.label,
                        inherited: LibraryFilters(q: searchText),
                        onlyOnPhone: onlyOnPhone
                    )
                } label: {
                    HStack {
                        Text(entry.label).lineLimit(1)
                        Spacer()
                        Text("\(entry.count)").foregroundStyle(.secondary).monospacedDigit()
                    }
                }
            }
        }
    }

    static func choice(for entry: LibraryFacetEntry, kind: LibraryDimension) -> LibraryChoice {
        switch kind {
        case .albums: return .album(entry.value)
        case .artists: return .artist(entry.value)
        case .genres: return .genre(entry.value)
        case .decades: return .decade(DecadeFilter(value: entry.value) ?? .noYear)
        case .playlists, .songs: return .everything
        }
    }

    private var songsSection: some View {
        Section {
            if model.songs.isEmpty && model.phase == .idle {
                Text(dimension.emptyText).foregroundStyle(.secondary)
            } else {
                HStack(spacing: 12) {
                    Button { play(from: nil, shuffled: false) } label: { Label("Suona", systemImage: "play.fill") }
                    Button { play(from: nil, shuffled: true) } label: { Label("Mescola", systemImage: "shuffle") }
                    Spacer()
                    Text("\(model.total) brani").font(.footnote).foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
            }
            ForEach(model.songs) { track in
                Button { play(from: track.songKey, shuffled: false) } label: {
                    SongRowView(
                        track: track, status: status(track),
                        isCurrent: player.currentSongKey == track.songKey, isPlaying: player.playing,
                        detail: track.libraryDetail
                    )
                }
                .buttonStyle(.plain)
                .contextMenu {
                    LikeMenuButton(songKey: track.songKey)
                    Button("Suona solo questo brano") { playOnly(track) }
                }
                .onAppear {
                    if track.songKey == model.songs.last?.songKey, model.canLoadMore { Task { await model.loadMore() } }
                }
            }
            if model.phase == .loadingMore || model.phase == .loading {
                HStack { Spacer(); ProgressView(); Spacer() }
            }
        }
    }

    /// What the «Brani» list is, in the words of «In coda»: the search, the phone, or everything.
    private var currentChoice: LibraryChoice {
        if !searchText.isBlank { return .search(searchText) }
        return model.source.isPhone ? .onPhone : .everything
    }

    private func play(from songKey: String?, shuffled: Bool) {
        Task {
            await LibraryPlayback.start(model: model, choice: currentChoice, startAt: songKey, shuffled: shuffled, localKeys: localKeys)
        }
    }

    private func playOnly(_ track: OfflineTrack) {
        Task {
            await LibraryPlayback.start(model: model, choice: .song(title: track.title), localKeys: localKeys, only: track)
        }
    }

    private func status(_ track: OfflineTrack) -> TrackRowStatus {
        TrackRowStatus.make(
            track: track,
            isLocal: localKeys.contains(track.songKey),
            progress: engine.progress[track.songKey],
            isSkipListed: engine.store.isSkipped(track.songKey)
        )
    }
}

/// The songs of ONE choice (an album, an artist, a tipo, a decade): play all, shuffle, or play from a song.
struct LibrarySelectionView: View {
    let choice: LibraryChoice
    let title: String

    @StateObject private var model: LibraryBrowseModel
    @ObservedObject private var player = LocalAudioPlayer.shared
    @ObservedObject private var engine = SyncEngine.shared
    @State private var localKeys: Set<String> = []

    init(choice: LibraryChoice, title: String, inherited: LibraryFilters = .none, onlyOnPhone: Bool = false) {
        self.choice = choice
        self.title = title
        // What was typed in the search box still narrows the list, so the count matches what the heading promised.
        var filters = choice.filters
        filters.q = inherited.q
        _model = StateObject(
            wrappedValue: LibraryBrowseModel(
                api: MondropAPI(), store: .shared, filters: filters, onlyOnPhone: onlyOnPhone, activity: .shared
            )
        )
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    Button { play(from: nil, shuffled: false) } label: { Label("Suona", systemImage: "play.fill") }
                    Button { play(from: nil, shuffled: true) } label: { Label("Mescola", systemImage: "shuffle") }
                    Spacer()
                    Text("\(model.total) brani").font(.footnote).foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .disabled(model.songs.isEmpty)
                if let notice = model.source.notice {
                    Text(notice).font(.footnote).foregroundStyle(.orange)
                }
            } footer: {
                Text("Tocca un brano per ascoltarlo: la lista diventa la coda. Tieni premuto per ascoltare solo quello.")
            }
            Section {
                if model.songs.isEmpty && model.phase == .idle {
                    Text("Nessun brano.").foregroundStyle(.secondary)
                }
                ForEach(model.songs) { track in
                    Button { play(from: track.songKey, shuffled: false) } label: {
                        SongRowView(
                            track: track, status: status(track),
                            isCurrent: player.currentSongKey == track.songKey, isPlaying: player.playing,
                            detail: track.libraryDetail
                        )
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        LikeMenuButton(songKey: track.songKey)
                        Button("Suona solo questo brano") { playOnly(track) }
                    }
                    .onAppear {
                        if track.songKey == model.songs.last?.songKey, model.canLoadMore { Task { await model.loadMore() } }
                    }
                }
                if model.phase == .loading || model.phase == .loadingMore {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
            }
        }
        .navigationTitle(title)
        .withMiniPlayer()
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task {
            await model.reload()
            localKeys = engine.store.localSongKeys()
            await model.pollWhilePreparing()
        }
        .refreshable {
            await model.reload()
            localKeys = engine.store.localSongKeys()
        }
        .onChange(of: engine.revision) { _, _ in localKeys = engine.store.localSongKeys() }
    }

    private func play(from songKey: String?, shuffled: Bool) {
        Task {
            await LibraryPlayback.start(model: model, choice: choice, startAt: songKey, shuffled: shuffled, localKeys: localKeys)
        }
    }

    private func playOnly(_ track: OfflineTrack) {
        Task {
            await LibraryPlayback.start(model: model, choice: .song(title: track.title), localKeys: localKeys, only: track)
        }
    }

    private func status(_ track: OfflineTrack) -> TrackRowStatus {
        TrackRowStatus.make(
            track: track,
            isLocal: localKeys.contains(track.songKey),
            progress: engine.progress[track.songKey],
            isSkipListed: engine.store.isSkipped(track.songKey)
        )
    }
}
