// StateMarks.swift — the marks of the three states: on the phone, online, error (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U3, U9).
// The choice of the mark is pure code in MondropKit (`SongState`, `PlaylistState`); these views only draw it, with the colours of the palette: the yellow for
// what is on the phone, the quiet white for what is online, the soft red for an error.

import SwiftUI

private var quiet: Color { Color(MondropPalette.text).opacity(MondropPalette.secondaryTextOpacity) }

/// Next to a song inside a playlist: a tick (on the phone), a cloud (online; the percent while the phone downloads it), a triangle (error).
struct SongStateMark: View {
    let state: SongState

    var body: some View {
        switch state {
        case .local:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Color(MondropPalette.accent))
                .accessibilityLabel(state.accessibilityLabel)
        case .online(let percent?):
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("\(percent) %")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(quiet)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(state.accessibilityLabel)
        case .online(nil):
            Image(systemName: "icloud")
                .foregroundStyle(quiet)
                .accessibilityLabel(state.accessibilityLabel)
        case .error:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Color(MondropPalette.error))
                .accessibilityLabel(state.accessibilityLabel)
        }
    }
}

/// The ONE mark of a playlist: the same three symbols and the same words as its songs. Nothing is drawn for a playlist with no songs.
struct PlaylistStateMark: View {
    let state: PlaylistState?
    var font: Font = .footnote

    var body: some View {
        if let state {
            Image(systemName: symbol(state))
                .font(font)
                .foregroundStyle(color(state))
                .accessibilityLabel(state.accessibilityLabel)
        }
    }

    private func symbol(_ state: PlaylistState) -> String {
        switch state {
        case .local: return "checkmark.circle.fill"
        case .online: return "icloud"
        case .error: return "exclamationmark.triangle.fill"
        }
    }

    private func color(_ state: PlaylistState) -> Color {
        switch state {
        case .local: return Color(MondropPalette.accent)
        case .online: return quiet
        case .error: return Color(MondropPalette.error)
        }
    }
}
