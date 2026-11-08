// PlayerStyle.swift — the colours and the geometry of the player screen, as plain numbers (spec
// 2026-11-08-mondrop-ipad-player-design.md). Michele, 8 November, with a screenshot of the iPad: «Questa la home su ipad - colori
// sbagliati e spazi da rivedere».
//
// What was wrong: the screen has a DARK gradient whatever the device's appearance is, but its text took the system's dynamic colours,
// which are BLACK in light mode (the title, the artist, the times and the transport icons were black on dark blue-green), the buttons
// were blue on grey, the play button green and the slider's track invisible: three accents, none of them the yellow of the new icon.
// So the screen now takes every colour from here, and the contrast is tested. The geometry is here for the same reason: on an iPad the
// cover was a tall rectangle (a square asked of a frame that only capped the width), the slider ran edge to edge under a narrow column
// and everything hung from the top of a tall screen.

import Foundation

/// A colour as red, green and blue between 0 and 1: enough to compute what the eye sees and how well text can be read on it.
public struct RGB: Equatable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double

    public init(_ red: Double, _ green: Double, _ blue: Double) {
        self.red = red
        self.green = green
        self.blue = blue
    }

    /// WCAG relative luminance.
    public var luminance: Double {
        func linear(_ c: Double) -> Double { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }

    /// This colour drawn at `alpha` over `background`: what a translucent text or fill really looks like.
    public func over(_ background: RGB, alpha: Double) -> RGB {
        let a = min(max(alpha, 0), 1)
        return RGB(red * a + background.red * (1 - a), green * a + background.green * (1 - a), blue * a + background.blue * (1 - a))
    }

    /// WCAG contrast ratio, 1 (none) to 21 (black on white). Text needs 4.5, large text and icons 3.
    public static func contrast(_ a: RGB, _ b: RGB) -> Double {
        let (hi, lo) = (max(a.luminance, b.luminance), min(a.luminance, b.luminance))
        return (hi + 0.05) / (lo + 0.05)
    }
}

public enum PlayerPalette {
    /// The two ends of the background: midnight blue to near black, like the dark version of the icon.
    public static let backgroundTop = RGB(0.14, 0.16, 0.27)
    public static let backgroundBottom = RGB(0.03, 0.035, 0.065)
    /// Mondrop's yellow (the icon's drop): the play button, the slider, the wordmark, the icons of the buttons.
    public static let accent = RGB(1.0, 0.84, 0.04)
    public static let text = RGB(1, 1, 1)
    /// The artist, the status line, the times: white at this opacity (tested against both ends of the background).
    public static let secondaryTextOpacity = 0.72
    /// The fill of the pill buttons («Parole», «In coda»): white at this opacity.
    public static let pillFillOpacity = 0.12
    /// An error in the status line: a red that can be read on dark.
    public static let error = RGB(1.0, 0.55, 0.50)

    /// The colour of the secondary text as it really looks over `background`.
    public static func secondaryText(over background: RGB) -> RGB { text.over(background, alpha: secondaryTextOpacity) }

    /// The fill of a pill over `background`.
    public static func pillFill(over background: RGB) -> RGB { text.over(background, alpha: pillFillOpacity) }
}

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
