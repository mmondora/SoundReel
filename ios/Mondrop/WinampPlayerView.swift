import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Lightweight Winamp-style local player: cover, transport, lyrics. No video.
struct WinampPlayerView: View {
    @ObservedObject private var player = LocalAudioPlayer.shared
    @ObservedObject private var engine = SyncEngine.shared
    @State private var showLyrics = false
    @State private var lyricsDraft = ""
    @State private var editingLyrics = false
    @State private var showQueue = false

    /// «Cerca musica»: the player has nothing to play until something is chosen.
    var onChoose: () -> Void = {}

    var body: some View {
        playerSurface
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .safeAreaInset(edge: .top, spacing: 0) { SyncStatusBar() }
        .sheet(isPresented: $showQueue) { QueueView(onChooseMore: onChoose) }
        .sheet(isPresented: $showLyrics) {
            NavigationStack {
                Group {
                    if editingLyrics {
                        TextEditor(text: $lyricsDraft)
                            .padding()
                    } else if player.lyrics.isEmpty && lyricsDraft.isEmpty {
                        ContentUnavailableView(
                            "Nessun testo",
                            systemImage: "text.quote",
                            description: Text("Trascrizione del post se c’è, oppure incolla le lyrics.")
                        )
                    } else {
                        ScrollView {
                            Text(lyricsDraft.isEmpty ? player.lyrics : lyricsDraft)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding()
                                .font(.body)
                        }
                    }
                }
                .navigationTitle("Parole")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Chiudi") { showLyrics = false; editingLyrics = false }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        if editingLyrics {
                            Button("Salva") {
                                player.setLyrics(lyricsDraft)
                                editingLyrics = false
                            }
                        } else {
                            Button("Modifica") {
                                lyricsDraft = player.lyrics
                                editingLyrics = true
                            }
                        }
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
    }

    // MARK: - The screen (spec 2026-11-08-mondrop-ipad-player-design.md)

    /// The dark surface. It is dark whatever the device's appearance is, so everything on it takes its colours from
    /// `PlayerPalette` (never the system's dynamic ones: black in light mode) and the controls are told to draw dark too.
    private var playerSurface: some View {
        ZStack {
            LinearGradient(
                colors: [Color(PlayerPalette.backgroundTop), Color(PlayerPalette.backgroundBottom)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            GeometryReader { geo in
                let layout = PlayerLayout(width: geo.size.width, height: geo.size.height)
                VStack(spacing: 0) {
                    Spacer(minLength: 8)
                    wordmark(layout)
                    cover(layout)
                    titles(layout)
                    progress(layout)
                    transport(layout)
                    actions(layout)
                    Spacer(minLength: 8)
                }
                .frame(width: layout.column)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .environment(\.colorScheme, .dark)
        .tint(Color(PlayerPalette.accent))
    }

    private func wordmark(_ layout: PlayerLayout) -> some View {
        Text("MONDROP")
            .font(.system(size: layout.isWide ? 15 : 13, weight: .heavy, design: .monospaced))
            .tracking(4)
            .foregroundStyle(Color(PlayerPalette.accent))
    }

    /// A SQUARE: the side is asked of the frame itself. (`aspectRatio` before a `frame(maxWidth:)` gave a 320 × 650 rectangle on an iPad.)
    private func cover(_ layout: PlayerLayout) -> some View {
        CoverView(
            coverData: player.coverData,
            title: player.title,
            artist: player.artist,
            seed: player.queue.indices.contains(player.index) ? player.queue[player.index].songKey : (player.title.isEmpty ? "mondrop" : player.title)
        )
        .frame(width: layout.coverSide, height: layout.coverSide)
        .clipShape(RoundedRectangle(cornerRadius: layout.isWide ? 24 : 18, style: .continuous))
        .shadow(color: .black.opacity(0.5), radius: 26, y: 14)
        .padding(.top, layout.gap + 4)
        .accessibilityHidden(true)
    }

    private func titles(_ layout: PlayerLayout) -> some View {
        VStack(spacing: 6) {
            Text(player.title.isEmpty ? "Niente in coda" : player.title)
                .font(layout.isWide ? .largeTitle.bold() : .title2.bold())
                .foregroundStyle(Color(PlayerPalette.text))
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
            Text(player.artist.isEmpty ? "Cerca cosa suonare" : player.artist)
                .font(layout.isWide ? .title3 : .subheadline)
                .foregroundStyle(secondary)
                .lineLimit(1)
            statusLine
        }
        .padding(.horizontal, layout.margin)
        .padding(.top, layout.gap + 6)
    }

    private func progress(_ layout: PlayerLayout) -> some View {
        VStack(spacing: 6) {
            Slider(
                value: Binding(
                    get: { player.currentTime },
                    set: { player.seek(to: $0) }
                ),
                in: 0...max(player.duration, 0.1)
            )
            .tint(Color(PlayerPalette.accent))
            .accessibilityLabel("Posizione nel brano")
            HStack {
                Text(fmt(player.currentTime))
                Spacer()
                Text(fmt(player.duration))
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(secondary)
        }
        .padding(.horizontal, layout.margin)
        .padding(.top, layout.gap + 6)
    }

    private func transport(_ layout: PlayerLayout) -> some View {
        HStack(spacing: layout.isWide ? 56 : 40) {
            Button { player.previous() } label: {
                Image(systemName: "backward.fill").font(.system(size: layout.isWide ? 32 : 26))
            }
            .accessibilityLabel("Brano precedente")
            Button { player.toggle() } label: {
                Image(systemName: player.playing ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: layout.isWide ? 92 : 76))
                    .foregroundStyle(Color(PlayerPalette.accent))
            }
            .accessibilityLabel(player.playing ? "Pausa" : "Riproduci")
            Button { player.next() } label: {
                Image(systemName: "forward.fill").font(.system(size: layout.isWide ? 32 : 26))
            }
            .accessibilityLabel("Brano successivo")
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color(PlayerPalette.text))
        .padding(.top, layout.gap + 8)
    }

    /// «Parole» and «In coda»: side by side when there is room, one under the other when there is not.
    private func actions(_ layout: PlayerLayout) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) { lyricsButton; queueButton }
            VStack(spacing: 12) { lyricsButton; queueButton }
        }
        .padding(.top, layout.gap + 8)
    }

    private var lyricsButton: some View {
        Button {
            lyricsDraft = player.lyrics
            showLyrics = true
        } label: {
            Label {
                Text(player.lyrics.isEmpty ? "Parole / lyrics" : "Vedi parole")
            } icon: {
                Image(systemName: "text.alignleft").foregroundStyle(Color(PlayerPalette.accent))
            }
        }
        .buttonStyle(PlayerPillStyle())
    }

    /// The secondary text, as the palette says it (the same on every appearance).
    private var secondary: Color { Color(PlayerPalette.text).opacity(PlayerPalette.secondaryTextOpacity) }

    /// «In coda: Album · Thriller · 3 / 9» (tap: the queue, with the state of every song), or — nothing chosen yet —
    /// the way to «Cerca».
    @ViewBuilder
    private var queueButton: some View {
        if player.queue.isEmpty {
            Button(action: onChoose) {
                Label {
                    Text("Cerca musica")
                } icon: {
                    Image(systemName: "magnifyingglass").foregroundStyle(Color(PlayerPalette.accent))
                }
            }
            .buttonStyle(PlayerPillStyle())
        } else {
            Button { showQueue = true } label: {
                Label {
                    Text(queueTitle).lineLimit(1)
                } icon: {
                    Image(systemName: "list.bullet").foregroundStyle(Color(PlayerPalette.accent))
                }
            }
            .buttonStyle(PlayerPillStyle())
            .accessibilityLabel("In coda")
        }
    }

    private var queueTitle: String {
        let position = "\(player.index + 1) / \(player.queue.count)"
        guard let label = player.queueLabel else { return "In coda · \(position)" }
        return "In coda: \(label) · \(position)"
    }

    /// "Preparo il brano…" / "In streaming · scarico 40 %" / "Dal telefono" / the error.
    @ViewBuilder
    private var statusLine: some View {
        if let line = PlaybackStatusText.make(
            status: player.playbackStatus,
            progress: player.currentSongKey.flatMap { engine.progress[$0] }
        ) {
            HStack(spacing: 6) {
                if player.playbackStatus == .preparing { ProgressView().controlSize(.small).tint(Color(PlayerPalette.text)) }
                Text(line.text)
                    .font(.footnote)
                    .foregroundStyle(line.isError ? Color(PlayerPalette.error) : secondary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private func fmt(_ s: Double) -> String {
        guard s.isFinite && s >= 0 else { return "0:00" }
        let m = Int(s) / 60
        let r = Int(s) % 60
        return "\(m):\(String(format: "%02d", r))"
    }
}

/// The real cover when SoundReel has found one (the image comes from the server, kept on the phone), else a drawn one.
private struct CoverView: View {
    let coverData: Data?
    let title: String
    let artist: String
    let seed: String

    var body: some View {
        ZStack {
            GeneratedCover(title: title, artist: artist, seed: seed)
            if let coverData, let image = Self.image(from: coverData) {
                image.resizable().scaledToFill()
            }
        }
    }

    private static func image(from data: Data) -> Image? {
        #if canImport(UIKit)
        return UIImage(data: data).map { Image(uiImage: $0) }
        #elseif canImport(AppKit)
        return NSImage(data: data).map { Image(nsImage: $0) }
        #else
        return nil
        #endif
    }
}

private struct GeneratedCover: View {
    let title: String
    let artist: String
    let seed: String

    var body: some View {
        let h = Double(seed.unicodeScalars.reduce(UInt32(0)) { ($0 &* 31) &+ $1.value } % 360) / 360
        ZStack {
            LinearGradient(
                colors: [
                    Color(hue: h, saturation: 0.55, brightness: 0.35),
                    Color(hue: (h + 0.12).truncatingRemainder(dividingBy: 1), saturation: 0.7, brightness: 0.55),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            VStack(spacing: 8) {
                if title.isEmpty {
                    // nothing queued yet: a note, not a letter
                    Image(systemName: "music.note")
                        .font(.system(size: 88, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))
                } else {
                    Text(String(title.prefix(1)).uppercased())
                        .font(.system(size: 96, weight: .black, design: .rounded))
                        .foregroundStyle(.white.opacity(0.9))
                }
                Text(artist)
                    .font(.headline)
                    .foregroundStyle(.white.opacity(0.75))
                    .lineLimit(1)
                    .padding(.horizontal)
            }
        }
    }
}

/// «Parole», «Cerca musica», «In coda»: a translucent white pill with a fine edge. One shape, drawn by the style itself, so a system
/// that adds its own shapes behind buttons (Accessibility → Button Shapes) finds nothing to add to.
private struct PlayerPillStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color(PlayerPalette.text))
            .padding(.horizontal, 18)
            .padding(.vertical, 11)
            .background(Color.white.opacity(configuration.isPressed ? 0.22 : PlayerPalette.pillFillOpacity), in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.16), lineWidth: 1))
            .contentShape(Capsule())
    }
}

private extension Color {
    init(_ rgb: RGB) {
        self.init(red: rgb.red, green: rgb.green, blue: rgb.blue)
    }
}
