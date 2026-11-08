import SwiftUI

struct RootTabView: View {
    var body: some View {
        TabView {
            NavigationStack {
                WinampPlayerView()
            }
            .tabItem { Label("Player", systemImage: "hifispeaker") }

            NavigationStack {
                PlaylistsView()
            }
            .tabItem { Label("Playlist", systemImage: "music.note.list") }

            NavigationStack {
                LibraryView()
            }
            .tabItem { Label("Coda", systemImage: "list.bullet") }

            NavigationStack {
                ContentView()
            }
            .tabItem { Label("Share", systemImage: "square.and.arrow.up") }

            NavigationStack {
                SettingsView()
            }
            .tabItem { Label("Impostazioni", systemImage: "gearshape") }
        }
    }
}
