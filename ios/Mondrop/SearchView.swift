// SearchView.swift — «Cerca», like Spotify: one field, always visible, and under it the songs, the artists and the albums
// that have the words — whether or not they are in a playlist, in the journal, on the NAS or on geekom: the SERVER
// answers (rule P), the app never knows where a file is. A tap plays the song and queues the ones that follow; a long
// press adds it to the queue or to a playlist, or downloads it. Before typing: the recent searches and the ways to browse
// (spec 2026-11-08-mondrop-search-spotify-style-design.md S2–S8, ADR-0018).

import SwiftUI

struct SearchView: View {
    @StateObject private var model: SearchModel
    @StateObject private var actions = TrackActions()
    @StateObject private var downloader = BulkDownloader()
    @ObservedObject private var player = LocalAudioPlayer.shared
    @ObservedObject private var engine = SyncEngine.shared
    @State private var text = ""
    @State private var onlyOnPhone = false
    @State private var localKeys: Set<String> = []
    /// The field is active (keyboard up): the user is typing, or the field of the Home asked for it.
    @State private var searchPresented = false
    @State private var handledSearchRequests = 0
    @ObservedObject private var router = RootRouter.shared
    #if DEBUG
    @State private var demoPush = false
    #endif
    @State private var recent = RecentSearchesStore().load()
    private let recentStore = RecentSearchesStore()

    /// The songs shown before «Mostra tutti i brani».
    static let previewCount = 5

    init() {
        let api = MondropAPI()
        _model = StateObject(wrappedValue: SearchModel(api: api, playlists: api, store: .shared, activity: .shared))
    }

    private struct LoadTrigger: Equatable {
        let text: String
        let onlyOnPhone: Bool
    }

    var body: some View {
        List {
            if let notice = model.source.notice {
                Section { Text(notice).font(.footnote).foregroundStyle(.orange) }
            }
            if text.isBlank {
                recentSection
                browseSection
            } else {
                resultsSections
            }
        }
        .navigationTitle("Cerca")
        #if os(iOS)
        .searchable(text: $text, isPresented: $searchPresented, placement: .navigationBarDrawer(displayMode: .always), prompt: "Brani, artisti, album")
        #else
        .searchable(text: $text, isPresented: $searchPresented, prompt: "Brani, artisti, album")
        #endif
        .onSubmit(of: .search) { remember(text) }
        .safeAreaInset(edge: .top, spacing: 0) { SyncStatusBar() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Toggle("Solo sul telefono", isOn: $onlyOnPhone)
                } label: {
                    Label("Opzioni", systemImage: onlyOnPhone ? "iphone" : "ellipsis.circle")
                }
            }
        }
        .task(id: LoadTrigger(text: text, onlyOnPhone: onlyOnPhone)) {
            // Typing: wait for a pause before asking the server (a changed id cancels this task, so a keystroke that is
            // followed by another one never reaches the network).
            if !text.isBlank {
                try? await Task.sleep(for: .milliseconds(300))
                if Task.isCancelled { return }
            }
            model.text = text
            model.onlyOnPhone = onlyOnPhone
            await model.reload()
            localKeys = engine.store.localSongKeys()
            // Songs the server is preparing turn into marks while this screen is open.
            await model.pollWhilePreparing()
        }
        .onAppear {
            localKeys = engine.store.localSongKeys()
            takeSearchRequest()
        }
        .onChange(of: router.searchRequests) { _, _ in takeSearchRequest() }
        // Opening an artist, an album or the full list pushes a page over this one: the words were worth remembering.
        .onDisappear { remember(text) }
        .onChange(of: engine.revision) { _, _ in localKeys = engine.store.localSongKeys() }
        .trackActions(actions)
        .bulkDownload(downloader, model: model, actions: actions)
        #if DEBUG
        .navigationDestination(isPresented: $demoPush) { LibraryView(initialDimension: .playlists) }
        .onAppear { if DemoData.push == "library" { demoPush = true } }
        #endif
    }

    /// The field of the Home asks for THIS field, with the keyboard (spec 2026-11-08-mondrop-home-spotify-design.md H1). A request made
    /// before this screen existed is not lost: the counter is compared with what was already taken.
    private func takeSearchRequest() {
        guard router.searchRequests > handledSearchRequests else { return }
        handledSearchRequests = router.searchRequests
        searchPresented = true
    }

    // MARK: before typing

    @ViewBuilder
    private var recentSection: some View {
        if !recent.isEmpty {
            Section {
                ForEach(recent.items, id: \.self) { item in
                    Button { text = item } label: {
                        Label(item, systemImage: "clock.arrow.circlepath").foregroundStyle(.primary)
                    }
                    .swipeActions {
                        Button(role: .destructive) { forget(item) } label: { Label("Togli", systemImage: "trash") }
                    }
                }
            } header: {
                HStack {
                    Text("Ricerche recenti")
                    Spacer()
                    Button("Cancella") { clearRecent() }.font(.caption)
                }
            }
        }
    }

    /// The old «Libreria», inside «Cerca»: ways to browse when there is nothing to look for yet.
    private var browseSection: some View {
        Section("Sfoglia") {
            browse("Playlist", "music.note.list") { LibraryView(initialDimension: .playlists) }
            browse("Album", "square.stack") { LibraryView(initialDimension: .albums) }
            browse("Autori", "music.mic") { LibraryView(initialDimension: .artists) }
            browse("Anni", "calendar") { LibraryView(initialDimension: .decades) }
            browse("Tipi", "guitars") { LibraryView(initialDimension: .genres) }
            browse("Sul telefono", "iphone") { LibraryView(initialDimension: .songs, onlyOnPhone: true) }
        }
    }

    private func browse<Destination: View>(_ title: String, _ symbol: String, @ViewBuilder destination: @escaping () -> Destination) -> some View {
        NavigationLink { destination() } label: { Label(title, systemImage: symbol) }
    }

    // MARK: results

    @ViewBuilder
    private var resultsSections: some View {
        if !model.didSearch && model.phase != .idle {
            Section { HStack { Spacer(); ProgressView(); Spacer() } }
        } else if model.didSearch && model.tracks.isEmpty && model.artists.isEmpty && model.albums.isEmpty && model.playlists.isEmpty {
            Section { Text("Nessun risultato per «\(text.trimmingCharacters(in: .whitespacesAndNewlines))».").foregroundStyle(.secondary) }
        }
        if !model.tracks.isEmpty {
            Section {
                ForEach(model.tracks.prefix(Self.previewCount)) { track in
                    row(track)
                }
                if model.total > Self.previewCount {
                    NavigationLink {
                        SearchResultsPage(kind: .allTracks(text: text))
                    } label: {
                        Text("Mostra tutti i brani (\(model.total))").foregroundStyle(Color.accentColor)
                    }
                }
            } header: {
                HStack {
                    Text("Brani")
                    Spacer()
                    Button { downloader.ask(model, actions: actions) } label: {
                        Label("Scarica tutti", systemImage: "arrow.down.circle").font(.caption)
                    }
                    .textCase(nil)
                    .disabled(downloader.busy)
                    .accessibilityLabel("Scarica tutti i brani della ricerca")
                }
            }
        }
        if !model.artists.isEmpty {
            Section("Artisti") {
                ForEach(model.artists) { artist in
                    NavigationLink {
                        SearchResultsPage(kind: .artist(artist.name))
                    } label: {
                        HStack {
                            Label(artist.name, systemImage: "music.mic").lineLimit(1)
                            Spacer()
                            Text("\(artist.tracks) brani").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        if !model.albums.isEmpty {
            Section("Album") {
                ForEach(model.albums) { album in
                    NavigationLink {
                        SearchResultsPage(kind: .album(title: album.title, artist: album.artist))
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Label(album.title, systemImage: "square.stack").lineLimit(1)
                            Text("\(album.artist.isEmpty ? "" : album.artist + " · ")\(album.tracks) brani")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        if !model.playlists.isEmpty {
            Section("Playlist") {
                ForEach(model.playlists) { playlist in
                    NavigationLink {
                        PlaylistOfflineView(playlist: playlist)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                Label(playlist.name, systemImage: "music.note.list").lineLimit(1)
                                if playlist.isDynamic { DynamicBadge() }
                            }
                            Text(playlist.isDynamic && playlist.songCount == 0 ? "si calcola al Sync" : "\(playlist.songCount) brani")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        if let paging = model.pagingError {
            Section { Text("Non riesco a caricare altri brani: \(paging)").font(.footnote).foregroundStyle(.red) }
        }
    }

    private func row(_ track: OfflineTrack) -> some View {
        let status = TrackRowStatus.make(
            track: track,
            isLocal: localKeys.contains(track.songKey),
            progress: engine.progress[track.songKey],
            isSkipListed: engine.store.isSkipped(track.songKey)
        )
        return SearchTrackRow(
            track: track, status: status,
            isCurrent: player.currentSongKey == track.songKey, isPlaying: player.playing,
            isLocal: localKeys.contains(track.songKey), actions: actions,
            onPlay: { play(track) }
        )
    }

    /// «Suona e accoda i seguenti»: this song, then the ones that follow it in the list on screen.
    private func play(_ track: OfflineTrack) {
        remember(text)
        let choice = SearchPlayback.choice(text: text, artist: "", album: "")
        guard let queue = SearchPlayback.queue(
            choice: choice, tracks: model.tracks, tapped: track.songKey, isLocal: { localKeys.contains($0) }
        ) else { return }
        LocalAudioPlayer.shared.setQueue(queue.items, startAt: queue.startIndex, playlistId: queue.playlistId, label: queue.label)
    }

    // MARK: recent searches

    private func remember(_ words: String) {
        recent.record(words)
        recentStore.save(recent)
    }

    private func forget(_ words: String) {
        recent.remove(words)
        recentStore.save(recent)
    }

    private func clearRecent() {
        recent.clear()
        recentStore.save(recent)
    }
}
