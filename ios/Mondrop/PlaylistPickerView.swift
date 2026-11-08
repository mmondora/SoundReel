// PlaylistPickerView.swift — «Aggiungi a playlist…»: the user's own static playlists, one tap to put the song in
// (docs/mondrop-sync.md "POST /api/mondrop/playlists/:id/songs"). The song may exist only as a file: that is fine, a
// playlist holds song keys (ADR-0018). The rules and the wording of the refusals are in MondropKit (PlaylistPickerModel).

import SwiftUI

struct PlaylistPickerView: View {
    let track: OfflineTrack
    /// The line to show on the screen below once the song is in.
    let onDone: (String) -> Void

    @StateObject private var model: PlaylistPickerModel
    @Environment(\.dismiss) private var dismiss

    init(track: OfflineTrack, onDone: @escaping (String) -> Void) {
        self.track = track
        self.onDone = onDone
        _model = StateObject(wrappedValue: PlaylistPickerModel(api: MondropAPI(), songKey: track.songKey))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(track.title).font(.headline).lineLimit(2)
                        if !track.artist.isEmpty {
                            Text(track.artist).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
                switch model.phase {
                case .loading:
                    Section { HStack { Spacer(); ProgressView(); Spacer() } }
                case .failed(let message):
                    Section {
                        Text(message).font(.footnote).foregroundStyle(.red)
                        Button("Riprova") { Task { await model.load() } }
                    }
                case .ready, .adding, .added:
                    EmptyView()
                }
                if !model.playlists.isEmpty {
                    Section("Le tue playlist") {
                        ForEach(model.playlists) { playlist in
                            Button {
                                Task {
                                    if await model.add(to: playlist), case .added(let message) = model.phase {
                                        onDone(message)
                                        dismiss()
                                    }
                                }
                            } label: {
                                HStack {
                                    Text(playlist.name).foregroundStyle(.primary)
                                    Spacer()
                                    if model.phase == .adding(playlist.id) {
                                        ProgressView().controlSize(.small)
                                    } else {
                                        Text("\(playlist.songCount)").foregroundStyle(.secondary).monospacedDigit()
                                    }
                                }
                            }
                            .disabled(isBusy)
                        }
                    }
                } else if model.phase == .ready {
                    Section {
                        Text("Non hai playlist a cui aggiungere brani a mano. Le playlist dinamiche e quelle condivise con te non si modificano.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Aggiungi a playlist")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annulla") { dismiss() }
                }
            }
            .task { await model.load() }
        }
        .presentationDetents([.medium, .large])
    }

    private var isBusy: Bool {
        if case .adding = model.phase { return true }
        return false
    }
}
