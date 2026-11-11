// SearchPages.swift — the pages «Cerca» opens: ALL the songs of a search, ONE artist (with his albums), ONE album.
// «Riproduci» and «Casuale» queue the whole list; a tap plays the song and queues the ones that follow; a long press
// offers the same three actions as in the results (spec 2026-11-08-mondrop-search-spotify-style-design.md S3–S4).

import SwiftUI

struct SearchResultsPage: View {
    enum Kind {
        case allTracks(text: String)
        case artist(String)
        case album(title: String, artist: String)

        var title: String {
            switch self {
            case .allTracks(let text): return "Brani · «\(text.trimmingCharacters(in: .whitespacesAndNewlines))»"
            case .artist(let name): return name
            case .album(let title, _): return title
            }
        }
    }

    let kind: Kind

    @StateObject private var model: SearchModel
    @StateObject private var actions = TrackActions()
    @StateObject private var downloader = BulkDownloader()
    @ObservedObject private var player = LocalAudioPlayer.shared
    @ObservedObject private var engine = SyncEngine.shared
    @State private var localKeys: Set<String> = []

    init(kind: Kind) {
        self.kind = kind
        var text = "", artist = "", album = ""
        switch kind {
        case .allTracks(let words): text = words
        case .artist(let name): artist = name
        case .album(let title, let by): album = title; artist = by
        }
        _model = StateObject(
            wrappedValue: SearchModel(api: MondropAPI(), store: .shared, text: text, artist: artist, album: album, activity: .shared)
        )
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    Button { play(from: nil, shuffled: false) } label: { Label("Riproduci", systemImage: "play.fill") }
                    Button { play(from: nil, shuffled: true) } label: { Label("Casuale", systemImage: "shuffle") }
                    Button { downloader.ask(model, actions: actions) } label: { Label("Scarica", systemImage: "arrow.down.circle") }
                        .disabled(downloader.busy)
                        .accessibilityLabel("Scarica tutti i brani")
                    Spacer()
                    Text("\(model.total) brani").font(.footnote).foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .disabled(model.tracks.isEmpty)
                if let notice = model.source.notice {
                    Text(notice).font(.footnote).foregroundStyle(.orange)
                }
                if case .album(_, let artist) = kind, !artist.isEmpty {
                    Text(artist).font(.subheadline).foregroundStyle(.secondary)
                }
            } footer: {
                Text("Tocca un brano per ascoltarlo: i brani che lo seguono vanno in coda. «+» lo mette in una playlist; tieni premuto per altre azioni; scorri per cancellarlo dal telefono.")
            }
            if case .artist = kind, !model.albums.isEmpty {
                Section("Album") {
                    ForEach(model.albums) { album in
                        NavigationLink {
                            SearchResultsPage(kind: .album(title: album.title, artist: album.artist))
                        } label: {
                            HStack {
                                Label(album.title, systemImage: "square.stack").lineLimit(1)
                                Spacer()
                                Text("\(album.tracks)").font(.footnote).foregroundStyle(.secondary).monospacedDigit()
                            }
                        }
                    }
                }
            }
            Section("Brani") {
                if model.tracks.isEmpty && model.phase == .idle && model.didSearch {
                    Text("Nessun brano.").foregroundStyle(.secondary)
                }
                ForEach(model.tracks) { track in
                    row(track)
                        .onAppear {
                            if track.songKey == model.tracks.last?.songKey, model.canLoadMore { Task { await model.loadMore() } }
                        }
                }
                if model.phase == .loading || model.phase == .loadingMore {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
                if let paging = model.pagingError {
                    Text("Non riesco a caricare altri brani: \(paging)").font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(kind.title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .safeAreaInset(edge: .top, spacing: 0) { SyncStatusBar() }
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
        .trackActions(actions)
        .searchDeletion(actions)
        .bulkDownload(downloader, model: model, actions: actions)
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
            onPlay: { play(from: track.songKey, shuffled: false) }
        )
    }

    /// The queue is the WHOLE list, not the first page of it: the rest is loaded first.
    private func play(from songKey: String?, shuffled: Bool) {
        Task {
            await model.loadAll()
            let choice = SearchPlayback.choice(text: model.text, artist: model.artist, album: model.album)
            let queue: PlayQueue?
            if let songKey {
                queue = SearchPlayback.queue(choice: choice, tracks: model.tracks, tapped: songKey, isLocal: { localKeys.contains($0) })
            } else {
                queue = SearchPlayback.queue(choice: choice, tracks: model.tracks, shuffled: shuffled, isLocal: { localKeys.contains($0) })
            }
            guard let queue else { return }
            LocalAudioPlayer.shared.start(queue)
        }
    }
}
