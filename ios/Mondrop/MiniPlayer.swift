// MiniPlayer.swift — what is playing, always in view, above the tab bar of EVERY tab (spec 2026-11-08-mondrop-home-spotify-design.md
// H2): cover, title and artist, the transport and a thin line of progress; a tap opens the Player at full screen. There is ONE for the
// whole app: no page draws its own (it used to be inset by hand in five screens, and only on the screens that start music).

import SwiftUI

struct MiniPlayerBar: View {
    @ObservedObject private var player = LocalAudioPlayer.shared
    @ObservedObject private var engine = SyncEngine.shared
    /// A tap on the bar: the Player.
    let onOpen: () -> Void
    /// The user is scrolling a page down: the bar slides away and fades (`MiniPlayerScrollRule`) — but it keeps its room, so that the page does not grow and shrink
    /// under the finger (a list that changes its height while it is scrolled moves, and at the end of a short list it would hide and show the bar over and over).
    var tucked = false

    var body: some View {
        // Only while something is in play (Michele, 11 November: «Il mini player non deve essere visibile se non ci sono cose in play.»): a queue the phone brought
        // back paused is on the first page as «Riprendi», not over every page.
        if MiniPlayerPresence.isShown(title: player.title, inPlay: player.inPlay) {
            HStack(spacing: 4) {
                // What is playing is one button (VoiceOver reads «In riproduzione: …, Apri il Player»); the transport are three more.
                Button(action: onOpen) {
                    HStack(spacing: 12) {
                        CoverView(coverData: player.coverData, title: player.title, artist: player.artist, seed: player.currentSongKey ?? player.title, showsText: false)
                            .frame(width: 44, height: 44)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(player.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Color(MondropPalette.text))
                                .lineLimit(1)
                            subtitle
                        }
                        Spacer(minLength: 8)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("In riproduzione: \(player.title)\(player.artist.isEmpty ? "" : ", \(player.artist)")\(location.map { ", \($0.accessibilityLabel.lowercased())" } ?? "")")
                .accessibilityHint("Apri il Player")
                controls
            }
            .padding(.leading, 10)
            .padding(.trailing, 4)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(MondropPalette.backgroundTop)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.white.opacity(0.14), lineWidth: 1))
            .overlay(alignment: .bottom) { progressLine }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .padding(.horizontal, 8)
            .padding(.bottom, 4)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
            .environment(\.colorScheme, .dark)
            // The keyboard of «Cerca» covers it instead of carrying it up.
            .ignoresSafeArea(.keyboard, edges: .bottom)
            .offset(y: tucked ? 96 : 0)
            .opacity(tucked ? 0 : 1)
            .allowsHitTesting(!tucked)
            .accessibilityHidden(tucked)
        }
    }

    /// Where the file of the song in play is: on the phone, online, error (the same marks as the lists).
    private var location: SongState? { MiniPlayerPresence.location(of: player.playbackStatus) }

    /// The artist, with the mark of where the file is; or, when the song is not playing yet or cannot, what is going on («Preparo il brano…», the error).
    @ViewBuilder
    private var subtitle: some View {
        let status = PlaybackStatusText.make(status: player.playbackStatus, progress: player.currentSongKey.flatMap { engine.progress[$0] })
        if let status, status.isError || player.playbackStatus == .preparing {
            Text(status.text)
                .font(.caption)
                .foregroundStyle(status.isError ? Color(MondropPalette.error) : secondary)
                .lineLimit(1)
        } else {
            HStack(spacing: 5) {
                if let location {
                    SongStateMark(state: location).font(.caption2)
                }
                Text(player.artist)
                    .font(.caption)
                    .foregroundStyle(secondary)
                    .lineLimit(1)
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 0) {
            LikeButton(songKey: player.currentSongKey, size: 18)
            Button { player.previous() } label: { glyph("backward.fill", size: 18) }
                .accessibilityLabel("Brano precedente")
            Button { player.toggle() } label: {
                glyph(player.playing ? "pause.fill" : "play.fill", size: 24, color: Color(MondropPalette.accent))
            }
            .accessibilityLabel(player.playing ? "Pausa" : "Riproduci")
            Button { player.next() } label: { glyph("forward.fill", size: 18) }
                .accessibilityLabel("Brano successivo")
        }
        .buttonStyle(.plain)
    }

    private func glyph(_ name: String, size: CGFloat, color: Color = Color(MondropPalette.text)) -> some View {
        Image(systemName: name)
            .font(.system(size: size))
            .foregroundStyle(color)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }

    private var progressLine: some View {
        GeometryReader { geo in
            let fraction = player.duration > 0 && player.duration.isFinite ? min(max(player.currentTime / player.duration, 0), 1) : 0
            ZStack(alignment: .leading) {
                Rectangle().fill(Color.white.opacity(0.14))
                Rectangle().fill(Color(MondropPalette.accent)).frame(width: geo.size.width * fraction)
            }
        }
        .frame(height: 2)
        .accessibilityHidden(true)
    }

    private var secondary: Color { Color(MondropPalette.text).opacity(MondropPalette.secondaryTextOpacity) }
}

/// What the pages tell the bar about their scrolling: `MiniPlayerScrollRule` decides whether it is tucked away, and the bar slides out and back.
@MainActor
final class MiniPlayerScroll: ObservableObject {
    @Published private(set) var hidden = false
    private var rule = MiniPlayerScrollRule()

    func scrolled(to offset: Double) {
        #if DEBUG
        if DemoData.keepsBar { return }
        #endif
        rule.scrolled(to: offset)
        set(rule.hidden)
    }

    /// A page appeared (pushed, or come back to): the bar is back.
    func reset() {
        rule.reset()
        set(false)
    }

    private func set(_ value: Bool) {
        guard value != hidden else { return }
        withAnimation(.easeInOut(duration: 0.22)) { hidden = value }
    }
}

private struct MiniPlayerScrollKey: EnvironmentKey {
    static let defaultValue: MiniPlayerScroll? = nil
}

extension EnvironmentValues {
    /// Where the pages of one tab report their scrolling (set by `.miniPlayer(open:)`); nil outside a tab.
    var miniPlayerScroll: MiniPlayerScroll? {
        get { self[MiniPlayerScrollKey.self] }
        set { self[MiniPlayerScrollKey.self] = newValue }
    }
}

/// How tall the bar is, measured where it is drawn (a taller text size makes a taller bar).
private struct MiniPlayerBarHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private struct MiniPlayerReserveKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

extension EnvironmentValues {
    /// The room the bar of this tab takes at the bottom of a page: 0 when there is no bar (nothing in play, the first page of the Home). A page puts it after its last
    /// row (`.withMiniPlayer()`): the bar floats over the page (an inset on the navigation stack does not reach the lists of the pages pushed on it — seen on the
    /// simulator: at the end of a long list the last row was under the bar), so the room has to be made by the page.
    var miniPlayerReserve: CGFloat {
        get { self[MiniPlayerReserveKey.self] }
        set { self[MiniPlayerReserveKey.self] = newValue }
    }
}

/// The bar above the tab bar of a tab, the room it takes told to the pages, and the scroll of the pages told to it.
private struct MiniPlayerHost: ViewModifier {
    let open: () -> Void
    let visible: Bool
    @StateObject private var scroll = MiniPlayerScroll()
    @State private var barHeight: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .environment(\.miniPlayerScroll, scroll)
            .environment(\.miniPlayerReserve, visible ? barHeight : 0)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if visible {
                    MiniPlayerBar(onOpen: open, tucked: scroll.hidden)
                        .background(GeometryReader { Color.clear.preference(key: MiniPlayerBarHeightKey.self, value: $0.size.height) })
                }
            }
            .onPreferenceChange(MiniPlayerBarHeightKey.self) { barHeight = $0 }
    }
}

/// What a page with a list does for the bar: it leaves room after its last row, and it tells the bar how far it is scrolled — down hides the bar, up (or the top of the page)
/// brings it back (iOS 18 and later; before that the bar stays).
private struct MiniPlayerPage: ViewModifier {
    @Environment(\.miniPlayerScroll) private var scroll
    @Environment(\.miniPlayerReserve) private var reserve

    func body(content: Content) -> some View {
        let roomy = content.contentMargins(.bottom, reserve, for: .scrollContent)
        if #available(iOS 18.0, macOS 15.0, *) {
            roomy
                .onScrollGeometryChange(for: Double.self) { geometry in
                    Double(geometry.contentOffset.y + geometry.contentInsets.top)
                } action: { _, offset in
                    scroll?.scrolled(to: offset)
                }
                .onAppear { scroll?.reset() }
        } else {
            roomy
        }
    }
}

extension View {
    /// The mini player above the tab bar. Applied ONCE per tab, on its NavigationStack: the pages that tab pushes get it too, and none of
    /// them draws its own.
    ///
    /// `visible: false` takes it away without moving it: the first page of the Home has none (Michele, 10 November: «Il mini player in basso» does not
    /// belong there; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U5), and the pages pushed from it have it.
    func miniPlayer(open: @escaping () -> Void, visible: Bool = true) -> some View {
        modifier(MiniPlayerHost(open: open, visible: visible))
    }

    /// For the main list or form of a page (Michele, 11 November: «non deve sovrapporre le cose sotto, oppure deve sparire/nascondersi se navigo»): the room after the last
    /// row so that nothing ends up under the bar, and the bar slides away while the page is scrolled down and comes back when it is scrolled up.
    func withMiniPlayer() -> some View {
        modifier(MiniPlayerPage())
    }
}
