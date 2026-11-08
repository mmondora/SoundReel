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
