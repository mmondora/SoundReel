import SwiftUI

enum RootTab: Hashable {
    case player, search, playlists, inbox, share, settings
}

struct RootTabView: View {
    @State private var selection: RootTab = .player
    /// The unread count of the Posta is the badge on its tab (and, with the permission, on the app icon).
    @ObservedObject private var inbox = InboxModel.shared
    /// A tap on a notification asks for the Posta.
    @ObservedObject private var router = NotificationRouter.shared
    @State private var handledRequests = 0

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack {
                // Nothing in the queue → «Cerca musica» takes the user to the place where music is chosen.
                WinampPlayerView(onChoose: { selection = .search })
            }
            .tabItem { Label("Player", systemImage: "hifispeaker") }
            .tag(RootTab.player)

            NavigationStack {
                // Like Spotify: one field, always visible. Choosing starts the queue; the mini player and «In coda» stay on
                // this screen, the user keeps looking. The old «Libreria» (browse by album, author, year…) lives inside it.
                SearchView()
            }
            .tabItem { Label("Cerca", systemImage: "magnifyingglass") }
            .tag(RootTab.search)

            NavigationStack {
                PlaylistsView()
            }
            .tabItem { Label("Playlist", systemImage: "music.note.list") }
            .tag(RootTab.playlists)

            // Fourth, so that on an iPhone it stays on the tab bar (from the sixth tab on iOS folds the rest into «Altro»,
            // and a badge there would not be seen).
            NavigationStack {
                InboxView()
            }
            .tabItem { Label("Posta", systemImage: "tray") }
            .badge(inbox.unread)
            .tag(RootTab.inbox)

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
        .onChange(of: router.openInboxRequests) { _, requests in
            guard requests > handledRequests else { return }
            handledRequests = requests
            selection = .inbox
        }
        .onAppear {
            // The app was launched by a tap on a notification: the request arrived before this view existed.
            if router.openInboxRequests > handledRequests {
                handledRequests = router.openInboxRequests
                selection = .inbox
            }
        }
    }
}
