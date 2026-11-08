// MondropPalette.swift — the colours of the whole app, as plain numbers (specs 2026-11-08-mondrop-ipad-player-design.md and
// 2026-11-08-mondrop-home-spotify-design.md H9–H10). Michele, 8 November: «colori sbagliati» (the Player) and, about the yellow of the
// new icon being the accent of everything, «A, si giallo».
//
// The app is DARK whatever the device's appearance is: the yellow does not read on white (contrast 1.4, the minimum is 4.5). So
// every screen takes its colours from here (never the system's dynamic ones, which are black in light mode on a dark surface), and
// the contrast of each pair that is drawn is tested.

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

public enum MondropPalette {
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

    /// What is drawn ON the yellow (the glyph of a play button, the label of a prominent button): black. White on this yellow is 1.4:1.
    public static let onAccent = RGB(0, 0, 0)
    /// A card of the Home (a playlist, a resume card): white at this opacity over the background.
    public static let cardFillOpacity = 0.08

    /// The backgrounds iOS paints in dark mode behind the lists and rows of the other screens (systemBackground,
    /// secondarySystemBackground, tertiarySystemBackground): where the yellow of the links, the tab bar and the switches must be read.
    public static let systemDarkBackgrounds = [RGB(0, 0, 0), RGB(0.110, 0.110, 0.118), RGB(0.173, 0.173, 0.180)]

    /// The fill of a card over `background`.
    public static func cardFill(over background: RGB) -> RGB { text.over(background, alpha: cardFillOpacity) }

    /// The colour of the secondary text as it really looks over `background`.
    public static func secondaryText(over background: RGB) -> RGB { text.over(background, alpha: secondaryTextOpacity) }

    /// The fill of a pill over `background`.
    public static func pillFill(over background: RGB) -> RGB { text.over(background, alpha: pillFillOpacity) }
}
