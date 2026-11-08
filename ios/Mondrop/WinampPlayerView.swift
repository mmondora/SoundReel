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
        ZStack {
            LinearGradient(
                colors: [Color(red: 0.08, green: 0.09, blue: 0.12), Color(red: 0.05, green: 0.14, blue: 0.10)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            VStack(spacing: 20) {
                Text("MONDROP")
                    .font(.system(size: 13, weight: .heavy, design: .monospaced))
                    .tracking(4)
                    .foregroundStyle(Color(red: 0.24, green: 0.86, blue: 0.59))

                CoverView(
                    coverData: player.coverData,
                    title: player.title.isEmpty ? "—" : player.title,
                    artist: player.artist,
                    seed: player.queue.indices.contains(player.index)
                        ? player.queue[player.index].songKey : player.title
                )
                .frame(maxWidth: 320)
                .aspectRatio(1, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .shadow(color: .black.opacity(0.45), radius: 24, y: 12)

                VStack(spacing: 4) {
                    Text(player.title.isEmpty ? "Niente in coda" : player.title)
                        .font(.title2.bold())
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                    Text(player.artist.isEmpty ? "Cerca cosa suonare" : player.artist)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    statusLine
                }
                .padding(.horizontal)

                VStack(spacing: 6) {
                    Slider(
                        value: Binding(
                            get: { player.currentTime },
                            set: { player.seek(to: $0) }
                        ),
                        in: 0...max(player.duration, 0.1)
                    )
                    .tint(Color(red: 0.24, green: 0.86, blue: 0.59))
                    HStack {
                        Text(fmt(player.currentTime)).font(.caption.monospacedDigit())
                        Spacer()
                        Text(fmt(player.duration)).font(.caption.monospacedDigit())
                    }
                    .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 28)

                HStack(spacing: 36) {
                    Button { player.previous() } label: {
                        Image(systemName: "backward.fill").font(.title)
                    }
                    Button { player.toggle() } label: {
                        Image(systemName: player.playing ? "pause.circle.fill" : "play.circle.fill")
                            .font(.system(size: 72))
                            .foregroundStyle(Color(red: 0.24, green: 0.86, blue: 0.59))
                    }
                    Button { player.next() } label: {
                        Image(systemName: "forward.fill").font(.title)
                    }
                }
                .foregroundStyle(.primary)

                Button {
                    lyricsDraft = player.lyrics
                    showLyrics = true
                } label: {
                    Label(
                        player.lyrics.isEmpty ? "Parole / lyrics" : "Vedi parole",
                        systemImage: "text.alignleft"
                    )
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                }

                queueButton

                Spacer(minLength: 0)
            }
            .padding(.top, 12)
        }
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

    /// «In coda: Album · Thriller · 3 / 9» (tap: the queue, with the state of every song), or — nothing chosen yet —
    /// the way to «Cerca».
    @ViewBuilder
    private var queueButton: some View {
        if player.queue.isEmpty {
            Button(action: onChoose) {
                Label("Cerca musica", systemImage: "magnifyingglass")
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
            }
        } else {
            Button { showQueue = true } label: {
                Label(queueTitle, systemImage: "list.bullet")
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(.ultraThinMaterial, in: Capsule())
            }
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
                if player.playbackStatus == .preparing { ProgressView().controlSize(.small) }
                Text(line.text)
                    .font(.footnote)
                    .foregroundStyle(line.isError ? Color.red : Color.secondary)
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
                Text(String(title.prefix(1)).uppercased())
                    .font(.system(size: 96, weight: .black, design: .rounded))
                    .foregroundStyle(.white.opacity(0.9))
                Text(artist)
                    .font(.headline)
                    .foregroundStyle(.white.opacity(0.75))
                    .lineLimit(1)
                    .padding(.horizontal)
            }
        }
    }
}
