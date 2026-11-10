// SearchActions.swift — what a long press does on a song of «Cerca», and the row that carries it
// (spec 2026-11-08-mondrop-search-spotify-style-design.md S3): «Aggiungi in coda», «Aggiungi a playlist…»,
// «Scarica sul telefono». Shared by the results, the artist page, the album page and the full list of songs.
// The rules are pure code in MondropKit (QueueAppend, PlaylistPickerModel); this file only draws and wires them.

import SwiftUI

@MainActor
final class TrackActions: ObservableObject {
    /// One short line at the bottom after an action («Aggiunto in coda»), gone by itself.
    @Published var toast: String?
    /// The song the «Aggiungi a playlist» sheet is open for.
    @Published var playlistTarget: OfflineTrack?
    private var toastGeneration = 0

    func show(_ message: String) {
        toastGeneration += 1
        let mine = toastGeneration
        toast = message
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.5))
            guard let self, mine == self.toastGeneration else { return }
            self.toast = nil
        }
    }

    func addToQueue(_ track: OfflineTrack, isLocal: Bool) {
        let outcome = LocalAudioPlayer.shared.append([track], isLocal: { _ in isLocal })
        show(outcome.message)
    }

    func askPlaylist(for track: OfflineTrack) {
        playlistTarget = track
    }

    /// «Mi piace» / «Non mi piace più» (spec 2026-11-10-mondrop-like-and-repeat-design.md L2): one short line says what happened.
    func likeToggled(_ track: OfflineTrack, liked: Bool) {
        show(liked ? "Ti piace «\(track.title)»" : "«\(track.title)» non ti piace più")
    }

    /// An explicit download goes before the sync, and a song the user once removed from the phone comes back.
    func download(_ track: OfflineTrack, status: TrackRowStatus) {
        if status.canRedownload {
            SyncEngine.shared.redownload(track)
        } else {
            SyncEngine.shared.enqueue([track], front: true, origin: .sync)
        }
        show("Scarico «\(track.title)» sul telefono")
    }
}

/// «Scarica tutti» (spec 2026-11-08-mondrop-bulk-download-design.md): puts the songs of a search on the phone in one go. It loads
/// every result (up to `BulkDownload.maxTracks`), works out what there is to do, ASKS, then starts; the songs the server has to
/// prepare are picked up as they become ready. It never starts the player.
@MainActor
final class BulkDownloader: ObservableObject {
    /// The question on screen («Scaricare 87 brani sul telefono?»), nil when none is.
    @Published var plan: BulkDownload.Plan?
    @Published private(set) var busy = false
    private var watch: Task<Void, Never>?

    func ask(_ model: SearchModel, actions: TrackActions) {
        guard !busy else { return }
        busy = true
        Task {
            await model.loadAll(maxTracks: BulkDownload.maxTracks)
            let tracks = Array(model.tracks.prefix(BulkDownload.maxTracks))
            let plan = BulkDownload.Plan(tracks: tracks, found: model.total, sync: SyncEngine.shared.plan(tracks))
            busy = false
            if plan.worthAsking { self.plan = plan } else { actions.show(plan.nothingMessage) }
        }
    }

    func confirm(_ plan: BulkDownload.Plan, model: SearchModel, actions: TrackActions) {
        self.plan = nil
        busy = true
        Task {
            let outcome = await BulkDownload.run(
                plan,
                enqueue: { SyncEngine.shared.enqueue($0) },
                prepare: { key in _ = try await MondropAPI().requestDownload(songKey: key, priority: .sync) }
            )
            busy = false
            actions.show(outcome.message)
            guard outcome.asked > 0 else { return }
            // The songs the server is preparing turn up in the list as they become ready, and are downloaded then: only the
            // songs of THIS press, whatever else the list holds.
            let mine = Set(plan.tracks.map(\.songKey))
            watch?.cancel()
            watch = Task {
                _ = await model.refresh()
                await model.pollWhilePreparing(onRefresh: { tracks in
                    SyncEngine.shared.enqueue(tracks.filter { mine.contains($0.songKey) })
                })
            }
        }
    }
}

private struct BulkDownloadHost: ViewModifier {
    @ObservedObject var downloader: BulkDownloader
    let model: SearchModel
    let actions: TrackActions

    func body(content: Content) -> some View {
        content.confirmationDialog(
            downloader.plan?.question ?? "",
            isPresented: Binding(get: { downloader.plan != nil }, set: { if !$0 { downloader.plan = nil } }),
            titleVisibility: .visible,
            presenting: downloader.plan
        ) { plan in
            Button("Scarica") { downloader.confirm(plan, model: model, actions: actions) }
            Button("Annulla", role: .cancel) { downloader.plan = nil }
        } message: { plan in
            Text(plan.details)
        }
    }
}

extension View {
    func bulkDownload(_ downloader: BulkDownloader, model: SearchModel, actions: TrackActions) -> some View {
        modifier(BulkDownloadHost(downloader: downloader, model: model, actions: actions))
    }
}

/// The sheet of «Aggiungi a playlist» and the line at the bottom, for any screen that lists songs.
private struct TrackActionsHost: ViewModifier {
    @ObservedObject var actions: TrackActions

    func body(content: Content) -> some View {
        content
            .sheet(item: $actions.playlistTarget) { track in
                PlaylistPickerView(track: track) { message in actions.show(message) }
            }
            .overlay(alignment: .bottom) {
                if let message = actions.toast {
                    Text(message)
                        .font(.footnote.weight(.medium))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(.regularMaterial, in: Capsule())
                        .shadow(radius: 3)
                        .padding(.bottom, 84)      // above the mini player
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: actions.toast)
    }
}

extension View {
    func trackActions(_ actions: TrackActions) -> some View {
        modifier(TrackActionsHost(actions: actions))
    }
}

/// A song of the results: a tap plays it and queues what follows; a long press offers the three actions.
struct SearchTrackRow: View {
    let track: OfflineTrack
    let status: TrackRowStatus
    let isCurrent: Bool
    let isPlaying: Bool
    let isLocal: Bool
    let actions: TrackActions
    let onPlay: () -> Void

    var body: some View {
        Button(action: onPlay) {
            SongRowView(track: track, status: status, isCurrent: isCurrent, isPlaying: isPlaying, detail: track.libraryDetail)
        }
        .buttonStyle(.plain)
        .contextMenu {
            LikeMenuButton(songKey: track.songKey) { actions.likeToggled(track, liked: $0) }
            Button { actions.addToQueue(track, isLocal: isLocal) } label: {
                Label("Aggiungi in coda", systemImage: "text.badge.plus")
            }
            Button { actions.askPlaylist(for: track) } label: {
                Label("Aggiungi a playlist…", systemImage: "music.note.list")
            }
            if canDownload {
                Button { actions.download(track, status: status) } label: {
                    Label("Scarica sul telefono", systemImage: "arrow.down.circle")
                }
            }
        }
    }

    /// Only a song the server has ready and the phone does not have (or no longer has).
    private var canDownload: Bool {
        switch status.kind {
        case .readyOnServer, .removedFromPhone: return true
        default: return false
        }
    }
}
