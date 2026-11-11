// SongRows.swift — the pieces every song list shares: the row itself (with the mark that says where the file is) and the queue sheet. (The mini player lives in
// MiniPlayer.swift: one for the whole app.) The wording and the choice of mark are decided by pure code in MondropKit (TrackRowStatus, SongState); these views only
// draw them. There is no line at the top that says what the sync is doing: the sync is automatic and quiet («Nessun sync evidente, tutto automatico», Michele,
// 11 November), and the marks of the songs say where each file is.

import SwiftUI

/// A song in a list: title, artist · where the file is, optional detail line, the bar while downloading, and on the right the mark of the three states — on the
/// phone, online, error — that every list of songs shows (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U3, U14; Michele, 11 November: «Non è
/// chiaro dove sono i file ( locali o remoto )»).
struct SongRowView: View {
    let track: OfflineTrack
    let status: TrackRowStatus
    var isCurrent = false
    var isPlaying = false
    /// «Thriller · 1982 · Pop» under the state, for lists that browse the library.
    var detail: String?

    private var state: SongState { SongState(status) }

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
                    .foregroundStyle(subtitleColor)
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
            LikedMark(songKey: track.songKey)
            SongStateMark(state: state)
        }
        .contentShape(Rectangle())
    }

    private var subtitle: String {
        track.artist.isEmpty ? state.rowText : "\(track.artist) · \(state.rowText)"
    }

    private var subtitleColor: Color {
        state.isError ? Color(MondropPalette.error) : .secondary
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

/// The queue («In coda»): what the user chose, the song playing now, what follows, each with its mark.
struct QueueView: View {
    @ObservedObject private var player = LocalAudioPlayer.shared
    @ObservedObject private var engine = SyncEngine.shared
    @Environment(\.dismiss) private var dismiss
    @State private var localKeys: Set<String> = []

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
            }
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
