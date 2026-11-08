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

    init(playlist: MondropPlaylist) {
        self.playlist = playlist
        _model = StateObject(
            wrappedValue: PlaylistSyncCoordinator(
                playlist: playlist,
                api: MondropAPI(),
                engine: .shared,
                net: .shared
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
        .safeAreaInset(edge: .bottom) { miniPlayer }
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
        let isCurrent = player.currentSongKey == track.songKey
        return HStack {
            Button {
                play(track, in: manifest)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        if isCurrent {
                            Image(systemName: player.playing ? "speaker.wave.2.fill" : "speaker.fill")
                                .font(.caption)
                        }
                        Text(track.title)
                    }
                    Text("\(track.artist) · \(status.label)")
                        .font(.caption2)
                        .foregroundStyle(statusColor(status))
                    if case .downloading(let fraction) = status.kind, let fraction {
                        ProgressView(value: fraction)
                    }
                }
            }
            .buttonStyle(.plain)
            Spacer()
            icon(for: status)
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

    @ViewBuilder
    private func icon(for status: TrackRowStatus) -> some View {
        switch status.kind {
        case .local: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .downloading, .queued: Image(systemName: "arrow.down.circle").foregroundStyle(.blue)
        case .preparing: ProgressView()
        case .readyOnServer: Image(systemName: "icloud.and.arrow.down")
        case .removedFromPhone: Image(systemName: "trash.circle").foregroundStyle(.secondary)
        case .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
        case .noSource: Image(systemName: "questionmark.circle").foregroundStyle(.orange)
        case .missing: Image(systemName: "circle.dashed").foregroundStyle(.secondary)
        }
    }

    private func statusColor(_ status: TrackRowStatus) -> Color {
        switch status.kind {
        case .failed: return .red
        case .noSource: return .orange
        default: return .secondary
        }
    }

    /// Whole playlist as the queue (minus tracks with no source at all), starting at the tapped track.
    private func play(_ track: OfflineTrack, in manifest: OfflineManifest) {
        let playable = manifest.tracks.filter { $0.resolvedState != .noSource || engine.store.fileURL(songKey: $0.songKey) != nil }
        guard let start = playable.firstIndex(where: { $0.songKey == track.songKey }) else { return }
        player.setQueue(playable.map { QueueItem(track: $0) }, startAt: start, playlistId: playlist.id)
    }

    @ViewBuilder
    private var miniPlayer: some View {
        if !player.title.isEmpty {
            VStack(spacing: 6) {
                HStack {
                    VStack(alignment: .leading) {
                        Text(player.title).font(.subheadline.bold())
                        Text(player.artist).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button { player.previous() } label: { Image(systemName: "backward.fill") }
                    Button { player.toggle() } label: {
                        Image(systemName: player.playing ? "pause.fill" : "play.fill")
                    }
                    Button { player.next() } label: { Image(systemName: "forward.fill") }
                }
                if let line = PlaybackStatusText.make(
                    status: player.playbackStatus,
                    progress: player.currentSongKey.flatMap { engine.progress[$0] }
                ) {
                    HStack(spacing: 6) {
                        if player.playbackStatus == .preparing { ProgressView().controlSize(.small) }
                        Text(line.text)
                            .font(.caption)
                            .foregroundStyle(line.isError ? Color.red : Color.secondary)
                        Spacer()
                    }
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial)
        }
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
