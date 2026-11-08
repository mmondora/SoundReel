// PlayerStyle.swift — the geometry of the player screen, as plain numbers (spec 2026-11-08-mondrop-ipad-player-design.md). Michele,
// 8 November, with a screenshot of the iPad: «Questa la home su ipad - colori sbagliati e spazi da rivedere». The colours live in
// MondropPalette.swift: since the Home (spec 2026-11-08-mondrop-home-spotify-design.md) they are the whole app's.
//
// What was wrong: on an iPad the cover was a tall rectangle (a square asked of a frame that only capped the width), the slider ran
// edge to edge under a narrow column and everything hung from the top of a tall screen. The geometry is here so that it can be tested.

import Foundation

/// How the player screen is laid out in the space it is given. Pure, so it can be tested for an iPhone, an iPad in both
/// orientations and a small window.
public struct PlayerLayout: Equatable, Sendable {
    /// A tablet-wide space (an iPad, a Mac window): bigger type, more air.
    public let isWide: Bool
    /// The width of the one centred column everything sits in: the slider and the buttons never run edge to edge on an iPad.
    public let column: Double
    /// The side of the SQUARE cover.
    public let coverSide: Double
    /// The vertical gap between the groups (cover, titles, slider, controls, buttons).
    public let gap: Double
    /// The space between the edge of the column and the slider and the titles: an iPhone's column is as wide as the screen.
    public let margin: Double

    public init(width: Double, height: Double) {
        let wide = width >= 600
        isWide = wide
        column = min(width, wide ? 560 : 480)
        // The cover takes what the column allows but never more than a third of the height: the rest has to fit under it.
        let byHeight = height * (wide ? 0.36 : 0.32)
        coverSide = max(160, min(column - 48, byHeight, wide ? 440 : 340))
        gap = wide ? 28 : 18
        margin = wide ? 32 : 24
    }
}
