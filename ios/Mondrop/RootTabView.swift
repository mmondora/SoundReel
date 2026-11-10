import SwiftUI

/// The tabs, in the order they are drawn. The Player is NOT one of them: it is the mini player above the bar, which opens it at full
/// screen (spec 2026-11-08-mondrop-home-spotify-design.md H2–H3). On an iPhone the first four stay on the bar and the rest go under «Altro».
enum RootTab: Hashable, CaseIterable {
    case home, search, playlists, inbox, share, settings
}

/// What one screen asks of the root: today, «open Cerca with the keyboard» (the field on the Home). A counter, like
/// `NotificationRouter.openInboxRequests`: a request made before its destination exists is not lost.
@MainActor
final class RootRouter: ObservableObject {
    static let shared = RootRouter()
    @Published private(set) var searchRequests = 0

    func requestSearch() { searchRequests += 1 }
}

struct RootTabView: View {
    @State private var selection: RootTab = .home
    /// The Player at full screen, opened from the mini player.
    @State private var showPlayer = false
    /// The unread count of the Posta is the badge on its tab (and, with the permission, on the app icon).
    @ObservedObject private var inbox = InboxModel.shared
    /// A tap on a notification asks for the Posta.
    @ObservedObject private var router = NotificationRouter.shared
    /// The field of the Home asks for Cerca.
    @ObservedObject private var root = RootRouter.shared
    @State private var handledRequests = 0

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack {
                // The first thing the app shows: the greeting, the field, where the user was and what the server found for them.
                HomeView(onOpenPlayer: openPlayer)
            }
            .miniPlayer(open: openPlayer)
            .tabItem { Label("Home", systemImage: "house") }
            .tag(RootTab.home)

            NavigationStack {
                // Like Spotify: one field, always visible. Choosing starts the queue; the mini player stays on this screen, the user
                // keeps looking. The old «Libreria» (browse by album, author, year…) lives inside it.
                SearchView()
            }
            .miniPlayer(open: openPlayer)
            .tabItem { Label("Cerca", systemImage: "magnifyingglass") }
            .tag(RootTab.search)

            NavigationStack {
                PlaylistsView()
            }
            .miniPlayer(open: openPlayer)
            .tabItem { Label("Playlist", systemImage: "music.note.list") }
            .tag(RootTab.playlists)

            // Fourth, so that on an iPhone it stays on the tab bar (from the fifth slot on iOS folds the rest into «Altro»,
            // and a badge there would not be seen).
            NavigationStack {
                InboxView()
            }
            .miniPlayer(open: openPlayer)
            .tabItem { Label("Posta", systemImage: "tray") }
            .badge(inbox.unread)
            .tag(RootTab.inbox)

            NavigationStack {
                ContentView()
            }
            .miniPlayer(open: openPlayer)
            .tabItem { Label("Share", systemImage: "square.and.arrow.up") }
            .tag(RootTab.share)

            NavigationStack {
                #if DEBUG
                DemoSettingsScroll(content: SettingsView())
                #else
                SettingsView()
                #endif
            }
            .miniPlayer(open: openPlayer)
            .tabItem { Label("Impostazioni", systemImage: "gearshape") }
            .tag(RootTab.settings)
        }
        .playerPresentation(isPresented: $showPlayer)
        .onChange(of: router.openInboxRequests) { _, requests in
            guard requests > handledRequests else { return }
            handledRequests = requests
            selection = .inbox
        }
        .onChange(of: root.searchRequests) { _, _ in selection = .search }
        .onAppear {
            #if DEBUG
            if let tab = DemoData.startTab { selection = tab }
            if DemoData.opensPlayer { showPlayer = true }
            if DemoData.focusesSearch { RootRouter.shared.requestSearch() }
            #endif
            // The app was launched by a tap on a notification: the request arrived before this view existed.
            if router.openInboxRequests > handledRequests {
                handledRequests = router.openInboxRequests
                selection = .inbox
            }
        }
    }

    private func openPlayer() { showPlayer = true }
}

/// The Player opens at full screen over everything (a sheet on the Mac, which has no full-screen cover) and closes with its arrow.
private struct PlayerPresentation: ViewModifier {
    @Binding var isPresented: Bool

    func body(content: Content) -> some View {
        #if os(iOS)
        content.fullScreenCover(isPresented: $isPresented) {
            WinampPlayerView(onClose: { isPresented = false })
        }
        #else
        content.sheet(isPresented: $isPresented) {
            WinampPlayerView(onClose: { isPresented = false })
                .frame(minWidth: 420, minHeight: 640)
        }
        #endif
    }
}

private extension View {
    func playerPresentation(isPresented: Binding<Bool>) -> some View {
        modifier(PlayerPresentation(isPresented: isPresented))
    }
}
