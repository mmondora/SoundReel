// LikeButton.swift — the heart and the loop (spec 2026-11-10-mondrop-like-and-repeat-design.md L2, L4; Michele, 10 November: «in mondrop
// voglio il like sulla canzone e il loop»). The state is not decided here: the likes are `LikesStore`'s (it shows at once and sends when
// there is a network), the loop is the player's. These views only draw them, with the colours of `MondropPalette` (yellow when on).

import SwiftUI

/// The heart of a song: a tap gives the like or takes it back. Full and yellow when the song is liked.
struct LikeButton: View {
    @ObservedObject private var likes = LikesStore.shared
    /// The song it is for; nil (nothing playing) leaves it dimmed and does nothing.
    let songKey: String?
    var size: CGFloat = 22
    var side: CGFloat = 44
    var idle: Color = Color(MondropPalette.text)

    var body: some View {
        let liked = songKey.map(likes.isLiked) ?? false
        Button {
            guard let songKey else { return }
            likes.toggle(songKey: songKey)
        } label: {
            Image(systemName: liked ? "heart.fill" : "heart")
                .font(.system(size: size))
                .foregroundStyle(liked ? Color(MondropPalette.accent) : idle)
                .symbolEffect(.bounce, value: liked)
                .frame(width: side, height: side)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(songKey == nil)
        .opacity(songKey == nil ? 0.4 : 1)
        .sensoryFeedback(.selection, trigger: liked)
        .accessibilityLabel(liked ? "Non mi piace più" : "Mi piace")
        .accessibilityAddTraits(liked ? .isSelected : [])
    }
}

/// A small full heart at the end of the row of a liked song. Nothing for the others, so a list of songs stays as quiet as it was.
struct LikedMark: View {
    @ObservedObject private var likes = LikesStore.shared
    let songKey: String

    var body: some View {
        if likes.isLiked(songKey) {
            Image(systemName: "heart.fill")
                .font(.caption)
                .foregroundStyle(Color(MondropPalette.accent))
                .accessibilityLabel("Mi piace")
        }
    }
}

/// The item of the long-press menu of a song: «Mi piace» or «Non mi piace più». It reads the state when the menu opens.
struct LikeMenuButton: View {
    let songKey: String
    /// Told the new state after the tap (the toast of the lists).
    var onToggle: (Bool) -> Void = { _ in }

    var body: some View {
        let liked = LikesStore.shared.isLiked(songKey)
        Button {
            onToggle(LikesStore.shared.toggle(songKey: songKey))
        } label: {
            Label(liked ? "Non mi piace più" : "Mi piace", systemImage: liked ? "heart.slash" : "heart")
        }
    }
}

/// The menu of the loop that opens with a long press on the play (the mini player, «Riprendi»; spec 2026-11-12-mondrop-home-play-loop-reels-design.md M2; Michele, 12 November: «sul play voglio
/// anche il "loop" del singolo o della playlist»): three lines — none, the playlist (or the queue), this song — and the one in use has a checkmark.
struct RepeatMenuItems: View {
    @ObservedObject private var player = LocalAudioPlayer.shared

    var body: some View {
        ForEach(RepeatChoice.all(current: player.repeatMode, forPlaylist: player.queuePlaylistId != nil)) { choice in
            Button { player.setRepeatMode(choice.mode) } label: {
                Label(choice.title, systemImage: choice.systemImage)
            }
        }
    }
}

/// The small mark on the play while the loop is on («repeat» for the queue, «repeat.1» for this song); nothing when it is off. On a yellow button (`onYellow`) it is dark with a yellow
/// ring, so that it reads on it; on the dark bar it is yellow.
struct RepeatIndicator: View {
    @ObservedObject private var player = LocalAudioPlayer.shared
    var onYellow = false

    var body: some View {
        if let symbol = player.repeatMode.indicatorSymbol {
            Image(systemName: symbol)
                .font(.system(size: 9, weight: .heavy))
                .foregroundStyle(Color(onYellow ? MondropPalette.accent : MondropPalette.onAccent))
                .padding(3)
                .background(Color(onYellow ? MondropPalette.onAccent : MondropPalette.accent), in: Circle())
                .overlay(Circle().strokeBorder(Color(onYellow ? MondropPalette.accent : MondropPalette.backgroundTop), lineWidth: 1))
                .allowsHitTesting(false)
                .accessibilityLabel(player.repeatMode.indicatorLabel ?? "")
        }
    }
}

/// The loop of the Player: none, the whole queue, this song. Dim when off, yellow when on.
struct RepeatButton: View {
    @ObservedObject private var player = LocalAudioPlayer.shared
    var size: CGFloat = 22
    var side: CGFloat = 44

    var body: some View {
        Button { player.cycleRepeatMode() } label: {
            Image(systemName: player.repeatMode == .one ? "repeat.1" : "repeat")
                .font(.system(size: size))
                .foregroundStyle(player.repeatMode == .off ? Color(MondropPalette.text).opacity(MondropPalette.secondaryTextOpacity) : Color(MondropPalette.accent))
                .frame(width: side, height: side)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: player.repeatMode)
        .accessibilityLabel(player.repeatMode.accessibilityLabel)
        .accessibilityHint("Cambia la ripetizione")
    }
}
