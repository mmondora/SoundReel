// CoverArt.swift — the covers every screen draws: the Player (big), the mini player and the cards of the Home (small). The image comes
// from SoundReel only (ADR-0019, rule P: `CoverLoader` asks the server, which finds it); when there is none, a tile is drawn, so a
// song without a cover still has a face. Moved out of the Player's file when the Home needed the same pieces.

import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The real cover when there is one, else a drawn one. The size is the caller's: it sizes the frame.
struct CoverView: View {
    let coverData: Data?
    let title: String
    let artist: String
    let seed: String
    /// A small tile has no room for the artist's name.
    var showsText = true

    var body: some View {
        ZStack {
            GeneratedCover(title: title, artist: artist, seed: seed, showsText: showsText)
            if let coverData, let image = Self.image(from: coverData) {
                image.resizable().scaledToFill()
            }
        }
    }

    static func image(from data: Data) -> Image? {
        #if canImport(UIKit)
        return UIImage(data: data).map { Image(uiImage: $0) }
        #elseif canImport(AppKit)
        return NSImage(data: data).map { Image(nsImage: $0) }
        #else
        return nil
        #endif
    }
}

/// The tile drawn when there is no cover: a gradient whose hue comes from the song, a letter (or a note when nothing is chosen) that
/// scales with the tile, and the artist when there is room for it.
struct GeneratedCover: View {
    let title: String
    let artist: String
    let seed: String
    var showsText = true
    /// A symbol instead of a letter (a playlist has no initial worth drawing).
    var symbol: String?

    var body: some View {
        let h = Double(seed.unicodeScalars.reduce(UInt32(0)) { ($0 &* 31) &+ $1.value } % 360) / 360
        GeometryReader { geo in
            let side = min(geo.size.width, geo.size.height)
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
                    if let symbol {
                        Image(systemName: symbol)
                            .font(.system(size: side * 0.34, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.85))
                    } else if title.isEmpty {
                        // nothing queued yet: a note, not a letter
                        Image(systemName: "music.note")
                            .font(.system(size: side * 0.34, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.85))
                    } else {
                        Text(String(title.prefix(1)).uppercased())
                            .font(.system(size: side * 0.38, weight: .black, design: .rounded))
                            .foregroundStyle(.white.opacity(0.9))
                    }
                    if showsText, side >= 140, !artist.isEmpty {
                        Text(artist)
                            .font(.headline)
                            .foregroundStyle(.white.opacity(0.75))
                            .lineLimit(1)
                            .padding(.horizontal)
                    }
                }
            }
        }
    }
}

/// The cover of one song, asked of SoundReel when it comes into view (the phone keeps what it has seen, so a downloaded song shows it
/// offline). The tile is drawn until the image arrives, and stays when the server has none.
struct AsyncCover: View {
    let songKey: String
    var coverPath: String?
    var title = ""
    var artist = ""
    var showsText = false
    @State private var data: Data?

    var body: some View {
        CoverView(coverData: data, title: title, artist: artist, seed: songKey, showsText: showsText)
            .task(id: songKey) {
                data = await CoverLoader.shared.data(songKey: songKey, coverPath: coverPath)
            }
    }
}

/// The cover of a playlist: the covers of its first songs as a 2 × 2 mosaic (the server picks the songs: `coverKeys`); with fewer
/// than four, the first song's cover alone; with none, a drawn tile with the symbol of a list.
struct PlaylistMosaic: View {
    let seed: String
    let keys: [String]

    var body: some View {
        if keys.count >= 4 {
            let tile = { (key: String) in AsyncCover(songKey: key).clipped() }
            VStack(spacing: 1) {
                HStack(spacing: 1) { tile(keys[0]); tile(keys[1]) }
                HStack(spacing: 1) { tile(keys[2]); tile(keys[3]) }
            }
        } else if let first = keys.first {
            AsyncCover(songKey: first, title: "", artist: "", showsText: false)
        } else {
            GeneratedCover(title: "", artist: "", seed: seed, showsText: false, symbol: "music.note.list")
        }
    }
}
