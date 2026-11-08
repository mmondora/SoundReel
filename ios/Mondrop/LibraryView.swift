import SwiftUI

struct LibraryView: View {
    @State private var items: [OfflineStore.Item] = []
    @ObservedObject private var player = LocalAudioPlayer.shared
    @ObservedObject private var engine = SyncEngine.shared

    var body: some View {
        List {
            if items.isEmpty {
                Text("Nessun file offline. Apri Playlist → Sync.")
                    .foregroundStyle(.secondary)
            }
            ForEach(items) { item in
                Button {
                    if let i = items.firstIndex(where: { $0.songKey == item.songKey }) {
                        player.setQueue(local: items, startAt: i)
                    }
                } label: {
                    VStack(alignment: .leading) {
                        Text(item.title)
                        Text(subtitle(item)).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Coda offline")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Ricarica") { reload() }
            }
            ToolbarItem(placement: .navigation) {
                NavigationLink {
                    SpaceView()
                } label: {
                    Label("Spazio", systemImage: "internaldrive")
                }
            }
        }
        .onAppear { reload() }
        // A download finished (or a file was removed): the list follows.
        .onChange(of: engine.revision) { _, _ in reload() }
    }

    private func reload() {
        items = OfflineStore.shared.loadIndex()
    }

    private func subtitle(_ item: OfflineStore.Item) -> String {
        guard let bytes = item.bytes else { return item.artist }
        return "\(item.artist) · \(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))"
    }
}
