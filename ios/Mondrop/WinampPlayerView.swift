import SwiftUI

/// The Player: cover, transport, lyrics, the queue. No video. Since the Home (spec 2026-11-08-mondrop-home-spotify-design.md H2) it is
/// not a tab: it opens at full screen from the mini player and closes with the arrow at the top.
struct WinampPlayerView: View {
    @ObservedObject private var player = LocalAudioPlayer.shared
    @ObservedObject private var engine = SyncEngine.shared
    @State private var showLyrics = false
    @State private var lyricsDraft = ""
    @State private var editingLyrics = false
    @State private var showQueue = false

    /// The arrow at the top (and a pull down on the header): back to where the user was.
    var onClose: () -> Void = {}

    var body: some View {
        playerSurface
        #if DEBUG
        .onAppear {
            if DemoData.opensLyricsSheet {
                lyricsDraft = player.lyrics
                showLyrics = true
            }
            if DemoData.opensQueueSheet { showQueue = true }
        }
        #endif
        .sheet(isPresented: $showQueue) { QueueView() }
        .sheet(isPresented: $showLyrics) {
            NavigationStack {
                Group {
                    if editingLyrics {
                        TextEditor(text: $lyricsDraft)
                            .padding()
                    } else if player.lyricsSearching && player.lyrics.isEmpty && lyricsDraft.isEmpty {
                        VStack(spacing: 12) {
                            ProgressView()
                            Text("Cerco il testo…").foregroundStyle(secondary)
                        }
                    } else if player.lyricsOrigin == .instrumental {
                        ContentUnavailableView("Brano strumentale", systemImage: "music.note", description: Text("Non ha parole."))
                    } else if player.lyrics.isEmpty && lyricsDraft.isEmpty {
                        ContentUnavailableView(
                            "Nessun testo",
                            systemImage: "text.quote",
                            description: Text("Non l’ho trovato né nel post né su Internet: puoi incollarlo tu.")
                        )
                    } else {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 14) {
                                Text(lyricsDraft.isEmpty ? player.lyrics : lyricsDraft)
                                    .font(.body)
                                // Where the words come from: a text found on the Internet can have mistakes or miss lines.
                                if let origin = lyricsOriginLine {
                                    Text(origin)
                                        .font(.footnote)
                                        .foregroundStyle(secondary)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding()
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
    /// `MondropPalette` (never the system's dynamic ones: black in light mode) and the controls are told to draw dark too.
    private var playerSurface: some View {
        ZStack {
            LinearGradient(
                colors: [Color(MondropPalette.backgroundTop), Color(MondropPalette.backgroundBottom)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            GeometryReader { geo in
                let layout = PlayerLayout(width: geo.size.width, height: geo.size.height)
                VStack(spacing: 0) {
                    header(layout)
                    VStack(spacing: 0) {
                        Spacer(minLength: 8)
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
        }
        .environment(\.colorScheme, .dark)
        .tint(Color(MondropPalette.accent))
    }

    /// The arrow that closes the Player (a pull down on the header does too) and the name of the app.
    private func header(_ layout: PlayerLayout) -> some View {
        ZStack {
            wordmark(layout)
            HStack {
                Button(action: onClose) {
                    Image(systemName: "chevron.down")
                        .font(.title3.weight(.semibold))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color(MondropPalette.text))
                .accessibilityLabel("Chiudi il Player")
                Spacer()
            }
        }
        .padding(.horizontal, 12)
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 20).onEnded { value in
            if value.translation.height > 80 { onClose() }
        })
    }

    private func wordmark(_ layout: PlayerLayout) -> some View {
        Text("MONDROP")
            .font(.system(size: layout.isWide ? 15 : 13, weight: .heavy, design: .monospaced))
            .tracking(4)
            .foregroundStyle(Color(MondropPalette.accent))
            .accessibilityHidden(true)
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
                .foregroundStyle(Color(MondropPalette.text))
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
            if !player.artist.isEmpty {
                Text(player.artist)
                    .font(layout.isWide ? .title3 : .subheadline)
                    .foregroundStyle(secondary)
                    .lineLimit(1)
            }
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
            .tint(Color(MondropPalette.accent))
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

    /// The transport in the middle (it stays centred: both sides weigh the same), the loop on its left and the heart on its right
    /// (spec 2026-11-10-mondrop-like-and-repeat-design.md L2, L4): no row of its own, so the Player is no taller than it was.
    private func transport(_ layout: PlayerLayout) -> some View {
        HStack(spacing: 0) {
            RepeatButton(size: layout.isWide ? 26 : 22)
            Spacer(minLength: 8)
            Button { player.previous() } label: {
                Image(systemName: "backward.fill").font(.system(size: layout.isWide ? 32 : 26))
            }
            .accessibilityLabel("Brano precedente")
            Spacer(minLength: 8)
            Button { player.toggle() } label: {
                Image(systemName: player.playing ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: layout.isWide ? 92 : 76))
                    .foregroundStyle(Color(MondropPalette.accent))
            }
            .accessibilityLabel(player.playing ? "Pausa" : "Riproduci")
            Spacer(minLength: 8)
            Button { player.next() } label: {
                Image(systemName: "forward.fill").font(.system(size: layout.isWide ? 32 : 26))
            }
            .accessibilityLabel("Brano successivo")
            Spacer(minLength: 8)
            LikeButton(songKey: player.currentSongKey, size: layout.isWide ? 28 : 24)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color(MondropPalette.text))
        .padding(.horizontal, layout.margin - 6)
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
                Text(lyricsButtonTitle)
            } icon: {
                Image(systemName: "text.alignleft").foregroundStyle(Color(MondropPalette.accent))
            }
        }
        .buttonStyle(PlayerPillStyle())
    }

    /// «Vedi parole» when there are words, «Cerco il testo…» while SoundReel is being asked, «Brano strumentale» for an instrumental.
    private var lyricsButtonTitle: String {
        if player.lyricsOrigin == .instrumental { return "Brano strumentale" }
        if !player.lyrics.isEmpty { return "Vedi parole" }
        return player.lyricsSearching ? "Cerco il testo…" : "Parole / lyrics"
    }

    /// The line under the words that says where they come from (nil for none).
    private var lyricsOriginLine: String? {
        switch player.lyricsOrigin {
        case .internet: return "Testo trovato su Internet: può avere errori o righe mancanti."
        case .transcript: return "Trascrizione del post."
        case .typed: return "Scritto da te."
        case .none, .instrumental: return nil
        }
    }

    /// The secondary text, as the palette says it (the same on every appearance).
    private var secondary: Color { Color(MondropPalette.text).opacity(MondropPalette.secondaryTextOpacity) }

    /// «In coda: Album · Thriller · 3 / 9» (tap: the queue, with the state of every song). With nothing queued there is nothing to open.
    @ViewBuilder
    private var queueButton: some View {
        if !player.queue.isEmpty {
            Button { showQueue = true } label: {
                Label {
                    Text(queueTitle).lineLimit(1)
                } icon: {
                    Image(systemName: "list.bullet").foregroundStyle(Color(MondropPalette.accent))
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
                if player.playbackStatus == .preparing { ProgressView().controlSize(.small).tint(Color(MondropPalette.text)) }
                Text(line.text)
                    .font(.footnote)
                    .foregroundStyle(line.isError ? Color(MondropPalette.error) : secondary)
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

/// «Parole», «In coda»: a translucent white pill with a fine edge. One shape, drawn by the style itself, so a system
/// that adds its own shapes behind buttons (Accessibility → Button Shapes) finds nothing to add to.
private struct PlayerPillStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color(MondropPalette.text))
            .padding(.horizontal, 18)
            .padding(.vertical, 11)
            .background(Color.white.opacity(configuration.isPressed ? 0.22 : MondropPalette.pillFillOpacity), in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.16), lineWidth: 1))
            .contentShape(Capsule())
    }
}
