import SwiftUI

struct PlaylistsView: View {
    @State private var playlists: [MondropPlaylist] = []
    @State private var status = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        List {
            if let error {
                Text(error).foregroundStyle(.red)
            }
            ForEach(playlists) { p in
                NavigationLink {
                    PlaylistOfflineView(playlist: p)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text(p.name).font(.headline)
                            if p.isDynamic { DynamicBadge() }
                        }
                        if p.isDynamic, let summary = p.ruleSummary, !summary.isEmpty {
                            Text(summary).font(.footnote).foregroundStyle(.secondary)
                        }
                        Text(p.isDynamic && p.songCount == 0 ? "si calcola al Sync" : "\(p.songCount) brani")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Playlist")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Aggiorna") { Task { await reload() } }
                    .disabled(busy)
            }
        }
        .overlay {
            if busy { ProgressView() }
        }
        .safeAreaInset(edge: .top, spacing: 0) { SyncStatusBar() }
        .safeAreaInset(edge: .bottom) {
            if !status.isEmpty {
                Text(status)
                    .font(.footnote)
                    .padding(8)
                    .frame(maxWidth: .infinity)
                    .background(.ultraThinMaterial)
            }
        }
        .task { await reload() }
    }

    private func reload() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            playlists = try await MondropAPI().listPlaylists()
            // A playlist deleted on the server no longer protects its songs from "Libera spazio".
            OfflineStore.shared.pruneMemberships(keeping: Set(playlists.map(\.id)))
            status = "\(playlists.count) playlist"
        } catch {
            self.error = (error as? MondropAPIError)?.description ?? error.localizedDescription
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
    @State private var showQueue = false

    init(playlist: MondropPlaylist) {
        self.playlist = playlist
        _model = StateObject(
            wrappedValue: PlaylistSyncCoordinator(
                playlist: playlist,
                api: MondropAPI(),
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
        .task { await model.load() }
        // The «Rete: casa / internet» line is information only (rule P): sync and play do not read it.
        .task { if net.info == nil { await net.refresh(api: MondropAPI()) } }
        .safeAreaInset(edge: .top, spacing: 0) { SyncStatusBar() }
        .safeAreaInset(edge: .bottom, spacing: 0) { MiniPlayerBar(onOpenQueue: { showQueue = true }) }
        .sheet(isPresented: $showQueue) { QueueView() }
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

    private func summaryLine(_ manifest: OfflineManifest) -> some View {
        var parts = ["Pronti \(manifest.readyCount)"]
        if manifest.preparingCount > 0 { parts.append("in preparazione \(manifest.preparingCount)") }
        if manifest.failedCount > 0 { parts.append("errori \(manifest.failedCount)") }
        if manifest.noSourceCount > 0 { parts.append("senza sorgente \(manifest.noSourceCount)") }
        return Text(parts.joined(separator: " · ")).font(.footnote)
    }

    private func row(_ track: OfflineTrack, at offset: Int, in manifest: OfflineManifest) -> some View {
        let status = TrackRowStatus.make(
            track: track,
            isLocal: engine.store.fileURL(songKey: track.songKey) != nil,
            progress: engine.progress[track.songKey],
            isSkipListed: engine.store.isSkipped(track.songKey)
        )
        return HStack {
            Button {
                play(track.songKey, shuffled: false, in: manifest)
            } label: {
                SongRowView(
                    track: track, status: status,
                    isCurrent: player.currentSongKey == track.songKey, isPlaying: player.playing
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
        player.setQueue(queue.items, startAt: queue.startIndex, playlistId: queue.playlistId, label: queue.label)
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
