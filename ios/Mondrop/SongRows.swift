// SongRows.swift — the pieces every song list shares: the spinner / mark next to a song, the row itself, the line at
// the top that says what is going on, and the mini player. The wording and the choice of mark are decided by pure
// code in MondropKit (TrackRowStatus, SyncStatusLine); these views only draw them.

import SwiftUI

/// Next to a song: a spinner (with the percent while the phone downloads it) when the server prepares it or the phone
/// downloads it, the ready mark when it is on the phone, and a clear symbol for the rest.
struct StatusAccessoryView: View {
    let status: TrackRowStatus

    var body: some View {
        switch status.accessory {
        case .spinner:
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                if let percent = status.percent {
                    Text("\(percent) %")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(status.rowText)
        case .done:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                .accessibilityLabel("Scaricato")
        case .cloud:
            Image(systemName: "icloud.and.arrow.down").foregroundStyle(.secondary)
                .accessibilityLabel("Pronto da scaricare")
        case .queued:
            Image(systemName: "clock").foregroundStyle(.blue)
                .accessibilityLabel("In coda")
        case .search:
            Image(systemName: "magnifyingglass.circle").foregroundStyle(.orange)
                .accessibilityLabel("Da cercare")
        case .error:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
                .accessibilityLabel("Errore")
        case .removed:
            Image(systemName: "trash.circle").foregroundStyle(.secondary)
                .accessibilityLabel("Rimossa dal telefono")
        case .pending:
            Image(systemName: "circle.dashed").foregroundStyle(.secondary)
                .accessibilityLabel("Da preparare")
        }
    }
}

extension TrackRowStatus {
    /// Errors red, «da cercare» orange, everything else quiet.
    var tint: Color {
        switch kind {
        case .failed: return .red
        case .noSource: return .orange
        default: return .secondary
        }
    }
}

/// A song in a list: title, artist · state, optional detail line, the bar while downloading, the mark on the right.
struct SongRowView: View {
    let track: OfflineTrack
    let status: TrackRowStatus
    var isCurrent = false
    var isPlaying = false
    /// «Thriller · 1982 · Pop» under the state, for lists that browse the library.
    var detail: String?

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if isCurrent {
                        Image(systemName: isPlaying ? "speaker.wave.2.fill" : "speaker.fill").font(.caption)
                    }
                    Text(track.title).lineLimit(1)
                }
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(status.tint)
                    .lineLimit(2)
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                if case .downloading(let fraction) = status.kind, let fraction {
                    ProgressView(value: min(max(fraction, 0), 1))
                }
            }
            Spacer(minLength: 8)
            StatusAccessoryView(status: status)
        }
        .contentShape(Rectangle())
    }

    private var subtitle: String {
        track.artist.isEmpty ? status.rowText : "\(track.artist) · \(status.rowText)"
    }
}

extension OfflineTrack {
    /// «Thriller · 1982 · Pop, Rock» — whatever of the three is known.
    var libraryDetail: String {
        var parts: [String] = []
        if let album { parts.append(album) }
        if let year { parts.append(String(year)) }
        if !genres.isEmpty { parts.append(genres.joined(separator: ", ")) }
        return parts.joined(separator: " · ")
    }
}

/// The line at the top: «Preparo 3 brani sul server · 1 in download dal telefono». Hidden when nothing is going on.
struct SyncStatusBar: View {
    @ObservedObject private var engine = SyncEngine.shared
    @ObservedObject private var activity = SyncActivity.shared
    @ObservedObject private var net = NetStatus.shared

    var body: some View {
        // The sightings of the server expire by themselves: look again every few seconds even if nothing publishes.
        TimelineView(.periodic(from: .now, by: 10)) { _ in
            let counts = SyncStatusCounts(
                progress: engine.progress,
                preparingOnServer: activity.preparingCount(),
                waitingForWifi: WifiHint.isWaitingForWifi(
                    onExpensivePath: net.onExpensivePath,
                    allowCellular: Settings.shared.allowCellularDownloads,
                    activeDownloads: engine.activeCount
                )
            )
            if let line = SyncStatusLine.make(counts) {
                HStack(spacing: 8) {
                    if counts.isWorking {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: counts.failed > 0 ? "exclamationmark.triangle.fill" : "clock")
                            .font(.footnote)
                            .foregroundStyle(counts.failed > 0 ? Color.red : Color.secondary)
                    }
                    Text(line).font(.footnote)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                // A material ignores the safe area by default: at the top it would paint over the navigation bar and
                // hide the large title.
                .background(.ultraThinMaterial, ignoresSafeAreaEdges: [])
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// What is playing, with the transport, at the bottom of the screens that start music.
struct MiniPlayerBar: View {
    @ObservedObject private var player = LocalAudioPlayer.shared
    @ObservedObject private var engine = SyncEngine.shared
    var onOpenQueue: (() -> Void)?

    var body: some View {
        if !player.title.isEmpty {
            VStack(spacing: 6) {
                HStack {
                    VStack(alignment: .leading) {
                        Text(player.title).font(.subheadline.bold()).lineLimit(1)
                        Text(player.artist).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    if let onOpenQueue {
                        Button(action: onOpenQueue) { Image(systemName: "list.bullet") }
                            .accessibilityLabel("In coda")
                    }
                    Button { player.previous() } label: { Image(systemName: "backward.fill") }
                    Button { player.toggle() } label: { Image(systemName: player.playing ? "pause.fill" : "play.fill") }
                    Button { player.next() } label: { Image(systemName: "forward.fill") }
                }
                if let label = player.queueLabel, player.queue.count > 1 {
                    HStack {
                        Text("In coda: \(label) · \(player.index + 1) / \(player.queue.count)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer()
                    }
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

/// The queue («In coda»): what the user chose, the song playing now, what follows, each with its download state.
struct QueueView: View {
    @ObservedObject private var player = LocalAudioPlayer.shared
    @ObservedObject private var engine = SyncEngine.shared
    @Environment(\.dismiss) private var dismiss
    @State private var localKeys: Set<String> = []
    var onChooseMore: (() -> Void)?

    var body: some View {
        NavigationStack {
            List {
                if player.queue.isEmpty {
                    Section {
                        Text("Niente in coda. Cerca un brano, un artista o un album, o sfoglia per playlist, tipo e anno.")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        ForEach(Array(player.queue.enumerated()), id: \.element.id) { offset, item in
                            Button {
                                player.play(at: offset)
                            } label: {
                                SongRowView(
                                    track: item.track ?? OfflineTrack(songKey: item.songKey, title: item.title, artist: item.artist),
                                    status: status(for: item),
                                    isCurrent: offset == player.index,
                                    isPlaying: player.playing
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    } header: {
                        Text("\(player.queueLabel ?? "In coda") · \(player.queue.count) brani")
                    }
                }
            }
            .navigationTitle("In coda")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Chiudi") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    if let onChooseMore {
                        Button("Cerca") {
                            dismiss()
                            onChooseMore()
                        }
                    }
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) { SyncStatusBar() }
            .onAppear { localKeys = engine.store.localSongKeys() }
            .onChange(of: engine.revision) { _, _ in localKeys = engine.store.localSongKeys() }
        }
    }

    private func status(for item: QueueItem) -> TrackRowStatus {
        TrackRowStatus.make(
            track: item.track ?? OfflineTrack(songKey: item.songKey, title: item.title, artist: item.artist),
            isLocal: localKeys.contains(item.songKey),
            progress: engine.progress[item.songKey],
            isSkipListed: engine.store.isSkipped(item.songKey)
        )
    }
}
