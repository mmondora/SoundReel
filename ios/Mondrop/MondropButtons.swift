// MondropButtons.swift — the buttons of the app, in its colours (spec 2026-11-08-mondrop-home-spotify-design.md H9). The system's
// `.borderedProminent` paints its label WHITE, and white on the yellow is 1.4:1: unreadable. So a yellow button is this one, with black
// words (`MondropPalette.onAccent`, tested at 14:1); the system style stays only where it is red (a destructive action).

import SwiftUI

/// A capsule: yellow with black words when `prominent`, a quiet translucent one otherwise.
struct MondropPillStyle: ButtonStyle {
    let prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .foregroundStyle(prominent ? Color(MondropPalette.onAccent) : Color(MondropPalette.text))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(
                prominent ? Color(MondropPalette.accent) : Color.white.opacity(configuration.isPressed ? 0.22 : MondropPalette.pillFillOpacity),
                in: Capsule()
            )
            .opacity(prominent && configuration.isPressed ? 0.8 : 1)
            .contentShape(Capsule())
    }
}
