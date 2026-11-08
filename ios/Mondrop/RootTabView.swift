import SwiftUI

enum RootTab: Hashable {
    case player, library, playlists, share, settings
}

struct RootTabView: View {
    @State private var selection: RootTab = .player

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack {
                // Nothing in the queue → «Scegli dalla Libreria» takes the user to the place where music is chosen.
                WinampPlayerView(onChoose: { selection = .library })
            }
            .tabItem { Label("Player", systemImage: "hifispeaker") }
            .tag(RootTab.player)

            NavigationStack {
                // Choosing starts the queue: the mini player and «In coda» stay on this screen, the user keeps browsing.
                LibraryView()
            }
            .tabItem { Label("Libreria", systemImage: "music.note.house") }
            .tag(RootTab.library)

            NavigationStack {
                PlaylistsView()
            }
            .tabItem { Label("Playlist", systemImage: "music.note.list") }
            .tag(RootTab.playlists)

            NavigationStack {
                ContentView()
            }
            .tabItem { Label("Share", systemImage: "square.and.arrow.up") }
            .tag(RootTab.share)

            NavigationStack {
                SettingsView()
            }
            .tabItem { Label("Impostazioni", systemImage: "gearshape") }
            .tag(RootTab.settings)
        }
    }
}
