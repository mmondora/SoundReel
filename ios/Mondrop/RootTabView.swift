import SwiftUI

/// The tabs, in the order they are drawn. The Player is NOT one of them: it is the mini player above the bar, which opens it at full
/// screen (spec 2026-11-08-mondrop-home-spotify-design.md H2–H3). The playlists are NOT one either: they are on the first page, and the whole
/// list opens from there («Su Mondrop non vedo utilità nel tab playlist», Michele, 10 November; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md
/// U1). Five tabs: all of them stay on the bar of an iPhone. «Reel» (12 November, spec 2026-11-12-mondrop-home-play-loop-reels-design.md M5) took the place of «Share»:
/// the manual share form opens from the «+» of that tab, the Share Extension and the Settings are as they were.
enum RootTab: Hashable, CaseIterable {
    case home, search, reels, inbox, settings
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
    /// The first page of the Home is on screen: there the mini player is not drawn (it is on every page pushed from it).
    @State private var homeRootShown = true
    /// The sync of the playlist that plays: the question that comes before a big download is put on the display from here.
    @ObservedObject private var playingSync = PlayingPlaylistSync.shared

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack {
                // The first thing the app shows: the greeting, the field, where the user was and what the server found for them.
                HomeView(onOpenPlayer: openPlayer, onRootVisible: { homeRootShown = $0 })
            }
            .miniPlayer(open: openPlayer, visible: !homeRootShown)
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

            // What the reels the family shared hold, explained and split by category (no link to the reel; only the music goes to the phone).
            NavigationStack {
                ReelsView()
            }
            .miniPlayer(open: openPlayer)
            .tabItem { Label("Reel", systemImage: "rectangle.stack") }
            .tag(RootTab.reels)

            // The five tabs all fit on the bar of an iPhone (a sixth would fold the rest into «Altro», where a badge would not be seen).
            NavigationStack {
                InboxView()
            }
            .miniPlayer(open: openPlayer)
            .tabItem { Label("Posta", systemImage: "tray") }
            .badge(inbox.unread)
            .tag(RootTab.inbox)

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
        // «Il sync deve girare solo per playlist che sto suonando» (Michele, 11 November): nothing syncs at the first access; the playlist that begins to play does,
        // and asks first when it is a lot. The Player covers the screen: the question comes up when it is closed.
        .syncSizeDialog(playingSync, suppressed: showPlayer)
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
            if DemoData.startsPlaying { LocalAudioPlayer.shared.demoMarkInPlay() }
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
