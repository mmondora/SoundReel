import SwiftUI

struct PlaylistsView: View {
    // The list is asked to the server a page at a time, with search, filter and sort by date (ADR-0023, rule P).
    @StateObject private var model: PlaylistListModel
    /// What each playlist shows as its mark comes from what the phone has read of it and holds (U9): read again when a download ends or fails.
    @ObservedObject private var engine = SyncEngine.shared
    /// The files on the phone, read when the page appears and when a song arrives or goes (not at every tick of a download).
    @State private var localKeys: Set<String> = []

    init() {
        #if DEBUG
        let transport: PlaylistListTransport = DemoData.isOn ? DemoData.PlaylistListAPI() : MondropAPI()
        #else
        let transport: PlaylistListTransport = MondropAPI()
        #endif
        _model = StateObject(wrappedValue: PlaylistListModel(transport: transport))
    }

    var body: some View {
        List {
            if let failure = model.failure {
                Text(failure).foregroundStyle(.red)
            }
            let marks = PlaylistMarks.current(store: engine.store, local: localKeys, progress: engine.progress)
            ForEach(model.items) { p in
                NavigationLink {
                    PlaylistOfflineView(playlist: p)
                } label: {
                    PlaylistRow(playlist: p, state: marks.state(id: p.id, songCount: p.songCount))
                }
            }
            if model.items.isEmpty && !model.loading && model.failure == nil {
                Text(model.narrowed ? "Nessuna playlist corrisponde" : "Nessuna playlist: creane una")
                    .foregroundStyle(.secondary)
            }
            if model.hasMore {
                Button {
                    Task { await model.loadMore() }
                } label: {
                    HStack {
                        Text("Carica altre")
                        Spacer()
                        Text("\(model.items.count) di \(model.total)").foregroundStyle(.secondary)
                    }
                }
                .disabled(model.loadingMore)
                .onAppear { Task { await model.loadMore() } }
            }
        }
        .navigationTitle("Playlist")
        .searchable(text: Binding(get: { model.text }, set: { model.setText($0) }), prompt: "Cerca nelle playlist")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Picker("Mostra", selection: Binding(get: { model.filter }, set: { model.setFilter($0) })) {
                        ForEach(PlaylistFilter.allCases) { Text($0.title).tag($0) }
                    }
                    Picker("Ordina per", selection: Binding(get: { model.sort }, set: { model.setSort($0) })) {
                        ForEach(PlaylistSort.allCases) { Text($0.title).tag($0) }
                    }
                    Button {
                        model.toggleOrder()
                    } label: {
                        Label(model.sort.orderTitle(model.order), systemImage: model.order == .desc ? "arrow.down" : "arrow.up")
                    }
                    Divider()
                    Button("Aggiorna") { Task { await refreshAll() } }
                } label: {
                    Label("Elenco", systemImage: "line.3.horizontal.decrease.circle")
                }
            }
        }
        .overlay {
            if model.loading && model.items.isEmpty { ProgressView() }
        }
        .safeAreaInset(edge: .top, spacing: 0) { SyncStatusBar() }
        .safeAreaInset(edge: .bottom) {
            if model.total > 0 {
                Text(model.hasMore ? "\(model.items.count) di \(model.total) playlist" : "\(model.total) playlist")
                    .font(.footnote)
                    .padding(8)
                    .frame(maxWidth: .infinity)
                    .background(.ultraThinMaterial)
            }
        }
        .onAppear { localKeys = engine.store.localSongKeys() }
        .onChange(of: engine.revision) { _, _ in localKeys = engine.store.localSongKeys() }
        .task { await refreshAll() }
    }

    private func refreshAll() async {
        await model.reload()
        // A playlist deleted on the server no longer protects its songs from "Libera spazio": that needs EVERY playlist, not a page.
        if let all = try? await MondropAPI().listPlaylists() {
            OfflineStore.shared.pruneMemberships(keeping: Set(all.map(\.id)))
            // The names Siri can be asked for by voice («metti la playlist X su Mondrop»): every playlist the screen knows, not a page.
            PlaylistCatalog.shared.remember(all, user: Settings.shared.autheliaUsername)
        }
    }
}

/// One row of the list: the name, the labels (dynamic, automatic), the DATE OF CREATION beside the name, and how many songs.
private struct PlaylistRow: View {
    let playlist: MondropPlaylist
    /// The mark of the playlist: on the phone, online, error (nothing for an empty one).
    let state: PlaylistState?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                PlaylistStateMark(state: state)
                Text(playlist.name).font(.headline)
                if playlist.isDynamic { DynamicBadge() }
                if playlist.isAuto { AutoBadge() }
                Spacer(minLength: 8)
                let created = PlaylistDateText.text(playlist.createdAt)
                if !created.isEmpty {
                    Text(created)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .accessibilityLabel("Creata \(created)")
                }
            }
            if playlist.isDynamic, let summary = playlist.ruleSummary, !summary.isEmpty {
                Text(summary).font(.footnote).foregroundStyle(.secondary)
            }
            Text(playlist.isDynamic && playlist.songCount == 0 ? "si calcola al Sync" : "\(playlist.songCount) brani")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

struct PlaylistOfflineView: View {
    let playlist: MondropPlaylist
    @StateObject private var model: PlaylistSyncCoordinator
    @ObservedObject private var engine = SyncEngine.shared
    @ObservedObject private var player = LocalAudioPlayer.shared
    @ObservedObject private var net = NetStatus.shared
    @State private var youtubeTarget: OfflineTrack?
    @State private var youtubeText = ""
    /// The line at the bottom after «Togli dalla playlist» («Tolto da «Road trip»», or why it did not work).
    @StateObject private var actions = TrackActions()

    init(playlist: MondropPlaylist) {
        self.playlist = playlist
        #if DEBUG
        let api: MondropAPIProtocol = DemoData.isOn ? DemoData.PlaylistAPI() : MondropAPI()
        #else
        let api: MondropAPIProtocol = MondropAPI()
        #endif
        _model = StateObject(
            wrappedValue: PlaylistSyncCoordinator(
                playlist: playlist,
                api: api,
                engine: .shared,
                activity: .shared,
                // The right moment to ask iOS for notifications, once: the user has just started a sync. And to refresh the
                // playlists the share sheet offers.
                onSyncStarted: {
                    Task { await SyncNotifier.shared.ensurePermission() }
                    Task { await InboxWiring.refreshPlaylistsCache() }
                }
            )
        )
    }

    var body: some View {
        List {
            if let manifest = model.manifest {
                if playlist.isDynamic || manifest.dynamic {
                    Section {
                        HStack(spacing: 8) {
                            DynamicBadge()
                            Text(playlist.ruleSummary ?? "Playlist dinamica").font(.subheadline)
                        }
                        if let generated = manifest.generatedDate {
                            Text("Calcolata \(generated.formatted(date: .abbreviated, time: .shortened)). Si ricalcola a ogni Sync; i brani li decide la regola (qui è in sola lettura).")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        } else {
                            Text("I brani li decide la regola e si ricalcolano a ogni Sync (qui è in sola lettura).")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                Section {
                    stateHeader(manifest)
                    summaryLine(manifest)
                    HStack(spacing: 14) {
                        Button { play(nil, shuffled: false, in: manifest) } label: { Label("Suona", systemImage: "play.fill") }
                        Button { play(nil, shuffled: true, in: manifest) } label: { Label("Mescola", systemImage: "shuffle") }
                    }
                    .buttonStyle(.borderless)
                    .disabled(manifest.tracks.isEmpty)
                    HStack {
                        Button(model.isBusy ? "Sync…" : "Sync") {
                            Task { await model.sync() }
                        }
                        .disabled(model.isBusy)
                        Spacer()
                        if manifest.failedCount + manifest.noSourceCount > 0 {
                            Button("Riprova errori") {
                                Task { await model.sync(retryFailed: true) }
                            }
                            .disabled(model.isBusy)
                        }
                    }
                    if !model.message.isEmpty {
                        Text(model.message).font(.footnote).foregroundStyle(.secondary)
                    }
                    Text("Rete: \(net.label)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if WifiHint.isWaitingForWifi(
                        onExpensivePath: net.onExpensivePath,
                        allowCellular: Settings.shared.allowCellularDownloads,
                        activeDownloads: engine.activeCount
                    ) {
                        Text("In attesa del Wi-Fi: la rete cellulare è disattivata per i download (Impostazioni → Sync).")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                } footer: {
                    Text("Tocca un brano per ascoltarlo: se non è ancora sul telefono parte subito in streaming e si scarica in parallelo.")
                }
                Section("Brani") {
                    ForEach(Array(manifest.tracks.enumerated()), id: \.element.id) { offset, track in
                        row(track, at: offset, in: manifest)
                    }
                }
            } else if model.phase == .loading {
                ProgressView()
            }
            if let error = model.errorText {
                Text(error).foregroundStyle(.red)
            }
        }
        .navigationTitle(playlist.name)
        .trackActions(actions)
        .task { await model.load() }
        // The «Rete: casa / internet» line is information only (rule P): sync and play do not read it.
        .task { if net.info == nil { await net.refresh(api: MondropAPI()) } }
        .safeAreaInset(edge: .top, spacing: 0) { SyncStatusBar() }
        .alert("Link YouTube", isPresented: Binding(
            get: { youtubeTarget != nil },
            set: { if !$0 { youtubeTarget = nil } }
        )) {
            TextField("https://www.youtube.com/watch?v=…", text: $youtubeText)
            Button("Usa questo link") {
                if let target = youtubeTarget {
                    let text = youtubeText
                    Task { await model.setYouTubeSource(songKey: target.songKey, urlText: text) }
                }
                youtubeTarget = nil
                youtubeText = ""
            }
            Button("Annulla", role: .cancel) {
                youtubeTarget = nil
                youtubeText = ""
            }
        } message: {
            Text("Per «\(youtubeTarget?.title ?? "")»: il server lo scarica da quel video.")
        }
    }

    /// The mark of the whole playlist and «12 di 20 sul telefono» (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U9).
    @ViewBuilder
    private func stateHeader(_ manifest: OfflineManifest) -> some View {
        let summary = PlaylistStateSummary(songs: manifest.tracks.map { SongState(status(of: $0)) })
        if let words = summary.headerText {
            HStack(spacing: 8) {
                PlaylistStateMark(state: summary.state, font: .subheadline)
                Text(words).font(.subheadline)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func status(of track: OfflineTrack) -> TrackRowStatus {
        TrackRowStatus.make(
            track: track,
            isLocal: engine.store.fileURL(songKey: track.songKey) != nil,
            progress: engine.progress[track.songKey],
            isSkipListed: engine.store.isSkipped(track.songKey)
        )
    }

    /// Only the user's own static playlists take songs out by hand (`PlaylistRowActions`).
    private var canRemoveSongs: Bool {
        PlaylistRowActions.canRemoveSongs(from: playlist, dynamicManifest: model.manifest?.dynamic ?? false)
    }

    private func remove(_ track: OfflineTrack) {
        Task {
            let outcome = await model.removeSong(songKey: track.songKey, using: MondropAPI())
            actions.show(outcome.message)
        }
    }

    private func summaryLine(_ manifest: OfflineManifest) -> some View {
        var parts = ["Pronti \(manifest.readyCount)"]
        if manifest.preparingCount > 0 { parts.append("in preparazione \(manifest.preparingCount)") }
        if manifest.failedCount > 0 { parts.append("errori \(manifest.failedCount)") }
        if manifest.noSourceCount > 0 { parts.append("senza sorgente \(manifest.noSourceCount)") }
        return Text(parts.joined(separator: " · ")).font(.footnote)
    }

    private func row(_ track: OfflineTrack, at offset: Int, in manifest: OfflineManifest) -> some View {
        let status = status(of: track)
        return HStack {
            Button {
                play(track.songKey, shuffled: false, in: manifest)
            } label: {
                SongRowView(
                    track: track, status: status,
                    isCurrent: player.currentSongKey == track.songKey, isPlaying: player.playing,
                    marks: .playlist
                )
            }
            .buttonStyle(.plain)
            if status.canRedownload {
                Button("Riscarica") { Task { await model.redownload(songKey: track.songKey) } }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
            if status.canRetry {
                Button("Riprova") { Task { await model.retry(songKey: track.songKey) } }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
            if status.canSetSource {
                Button("Link") {
                    youtubeText = ""
                    youtubeTarget = track
                }
                .buttonStyle(.borderless)
                .font(.caption)
            }
        }
        // «il remove è in swipe sulla playlist»: the swipe takes the song out of THIS playlist and deletes nothing from the phone.
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if canRemoveSongs {
                Button { remove(track) } label: {
                    Label("Togli dalla playlist", systemImage: "minus.circle")
                }
                .tint(Color(MondropPalette.error))
            }
        }
    }

    /// The playlist as the queue («In coda: Playlist · Road trip»), from the tapped song — or from the top / shuffled.
    /// A song the server found no source for is left out unless it is already on the phone.
    private func play(_ songKey: String?, shuffled: Bool, in manifest: OfflineManifest) {
        guard let queue = LibraryQueueBuilder.make(
            choice: .playlist(id: playlist.id, name: playlist.name),
            tracks: manifest.tracks,
            startAt: songKey,
            shuffled: shuffled,
            isLocal: { engine.store.fileURL(songKey: $0) != nil }
        ) else { return }
        player.start(queue)
    }
}

/// "DINAMICA": the songs come from a rule, not from a hand-made list.
struct DynamicBadge: View {
    var body: some View {
        Text("DINAMICA")
            .font(.system(size: 9, weight: .heavy, design: .monospaced))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.accentColor.opacity(0.18), in: Capsule())
            .foregroundStyle(Color.accentColor)
            .accessibilityLabel("Playlist dinamica")
    }
}

/// A playlist the server made from a post that talks about music (ADR-0023).
struct AutoBadge: View {
    var body: some View {
        Text("AUTOMATICA")
            .font(.system(size: 9, weight: .heavy, design: .monospaced))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.accentColor.opacity(0.18), in: Capsule())
            .foregroundStyle(Color.accentColor)
            .accessibilityLabel("Playlist automatica")
    }
}
