// MiniPlayer.swift — what is playing, always in view, above the tab bar of EVERY tab (spec 2026-11-08-mondrop-home-spotify-design.md
// H2): cover, title and artist, the transport and a thin line of progress; a tap opens the Player at full screen. There is ONE for the
// whole app: no page draws its own (it used to be inset by hand in five screens, and only on the screens that start music).

import SwiftUI

struct MiniPlayerBar: View {
    @ObservedObject private var player = LocalAudioPlayer.shared
    @ObservedObject private var engine = SyncEngine.shared
    /// A tap on the bar: the Player.
    let onOpen: () -> Void

    var body: some View {
        if !player.title.isEmpty {
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
                .accessibilityLabel("In riproduzione: \(player.title)\(player.artist.isEmpty ? "" : ", \(player.artist)")")
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
        }
    }

    /// The artist; or, when the song is not playing yet or cannot, what is going on («Preparo il brano…», the error).
    @ViewBuilder
    private var subtitle: some View {
        let status = PlaybackStatusText.make(status: player.playbackStatus, progress: player.currentSongKey.flatMap { engine.progress[$0] })
        if let status, status.isError || player.playbackStatus == .preparing {
            Text(status.text)
                .font(.caption)
                .foregroundStyle(status.isError ? Color(MondropPalette.error) : secondary)
                .lineLimit(1)
        } else {
            Text(player.artist)
                .font(.caption)
                .foregroundStyle(secondary)
                .lineLimit(1)
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

extension View {
    /// The mini player above the tab bar. Applied ONCE per tab, on its NavigationStack: the pages that tab pushes get it too, and none of
    /// them draws its own.
    func miniPlayer(open: @escaping () -> Void) -> some View {
        safeAreaInset(edge: .bottom, spacing: 0) { MiniPlayerBar(onOpen: open) }
    }
}
