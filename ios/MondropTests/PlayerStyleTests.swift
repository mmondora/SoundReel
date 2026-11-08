import XCTest
@testable import Mondrop

/// The player screen (spec 2026-11-08-mondrop-ipad-player-design.md). Michele, 8 November, with a screenshot of the iPad: «Questa la home
/// su ipad - colori sbagliati e spazi da rivedere». The title, the artist and the transport icons were BLACK on a dark gradient (the
/// system's dynamic colours, in light mode), the accents were three (green, blue, black) and none was the icon's yellow, the cover was a
/// 320 × 650 rectangle and the slider ran edge to edge under a narrow column.
final class PlayerStyleTests: XCTestCase {
    private let ends = [MondropPalette.backgroundTop, MondropPalette.backgroundBottom]

    // MARK: the maths

    func testContrastIsTheWCAGRatio() {
        XCTAssertEqual(RGB.contrast(RGB(0, 0, 0), RGB(1, 1, 1)), 21, accuracy: 0.001)
        XCTAssertEqual(RGB.contrast(RGB(0.3, 0.4, 0.5), RGB(0.3, 0.4, 0.5)), 1, accuracy: 0.001)
        XCTAssertEqual(RGB.contrast(RGB(1, 1, 1), RGB(0, 0, 0)), RGB.contrast(RGB(0, 0, 0), RGB(1, 1, 1)), accuracy: 0.001)
    }

    func testATranslucentColourIsBlendedWithWhatIsBehindIt() {
        let half = RGB(1, 1, 1).over(RGB(0, 0, 0), alpha: 0.5)
        XCTAssertEqual(half.red, 0.5, accuracy: 0.001)
        XCTAssertEqual(RGB(1, 1, 1).over(RGB(0.2, 0.2, 0.2), alpha: 0).red, 0.2, accuracy: 0.001)
        XCTAssertEqual(RGB(1, 1, 1).over(RGB(0.2, 0.2, 0.2), alpha: 1).red, 1, accuracy: 0.001)
    }

    // MARK: the colours can be read, on both ends of the background

    func testTheTextIsReadableOnTheBackground() {
        for background in ends {
            XCTAssertGreaterThanOrEqual(RGB.contrast(MondropPalette.text, background), 7, "the title was black on this")
        }
    }

    func testTheSecondaryTextIsStillReadable() {
        for background in ends {
            XCTAssertGreaterThanOrEqual(RGB.contrast(MondropPalette.secondaryText(over: background), background), 4.5,
                                        "the artist, the status line and the times")
        }
    }

    func testTheAccentAndTheErrorAreReadableOnTheBackground() {
        for background in ends {
            XCTAssertGreaterThanOrEqual(RGB.contrast(MondropPalette.accent, background), 7, "the play button, the slider, the wordmark")
            XCTAssertGreaterThanOrEqual(RGB.contrast(MondropPalette.error, background), 4.5)
        }
    }

    func testThePillsCanBeRead() {
        for background in ends {
            let fill = MondropPalette.pillFill(over: background)
            XCTAssertGreaterThanOrEqual(RGB.contrast(MondropPalette.text, fill), 4.5, "the words of «Parole» and «In coda»")
            XCTAssertGreaterThanOrEqual(RGB.contrast(MondropPalette.accent, fill), 3, "their icons")
        }
    }

    func testTheBackgroundIsDarkAndTheAccentIsTheYellowOfTheIcon() {
        for background in ends { XCTAssertLessThan(background.luminance, 0.05) }
        XCTAssertGreaterThan(MondropPalette.accent.red, 0.95)
        XCTAssertGreaterThan(MondropPalette.accent.green, 0.7)
        XCTAssertLessThan(MondropPalette.accent.blue, 0.2)
    }

    // MARK: the geometry

    func testAnIPadInPortraitHasOneCentredColumnAndASquareCover() {
        let layout = PlayerLayout(width: 820, height: 1050)
        XCTAssertTrue(layout.isWide)
        XCTAssertEqual(layout.column, 560)                    // not edge to edge: the slider and the buttons live in it
        XCTAssertEqual(layout.coverSide, 378, accuracy: 0.5)  // a third of the height, and never more than the column allows
        XCTAssertLessThanOrEqual(layout.coverSide, layout.column - 48)
    }

    func testAnIPadInLandscapeShrinksTheCoverSoEverythingStillFits() {
        let layout = PlayerLayout(width: 1180, height: 700)
        XCTAssertTrue(layout.isWide)
        XCTAssertEqual(layout.column, 560)
        XCTAssertEqual(layout.coverSide, 252, accuracy: 0.5)
    }

    func testAnIPhoneHasTheScreenForItsColumnAndMarginsAroundTheContent() {
        let layout = PlayerLayout(width: 393, height: 760)
        XCTAssertFalse(layout.isWide)
        XCTAssertEqual(layout.column, 393)
        XCTAssertEqual(layout.coverSide, 243.2, accuracy: 0.5)
        XCTAssertEqual(layout.margin, 24)                     // the slider no longer touches the edges of the screen
        XCTAssertLessThanOrEqual(layout.coverSide, layout.column - 48)
    }

    func testTheCoverIsNeverTinyAndNeverHuge() {
        XCTAssertEqual(PlayerLayout(width: 320, height: 300).coverSide, 160)       // a small window: still a cover
        XCTAssertEqual(PlayerLayout(width: 1366, height: 3000).coverSide, 440)     // a big iPad Pro: capped
        for (w, h) in [(375.0, 667.0), (430.0, 932.0), (744.0, 1133.0), (1024.0, 1366.0), (1366.0, 1024.0)] {
            let layout = PlayerLayout(width: w, height: h)
            XCTAssertGreaterThanOrEqual(layout.coverSide, 160)
            XCTAssertLessThanOrEqual(layout.coverSide, 440)
        }
    }

    // MARK: the sources, like RulePTests: a plain text scan

    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    func testThePlayerScreenTakesNoColourFromTheSystem() throws {
        let text = try String(contentsOf: iosRoot.appendingPathComponent("Mondrop/WinampPlayerView.swift"), encoding: .utf8)
        let code = text.components(separatedBy: "\n").map { $0.components(separatedBy: "//")[0] }.joined(separator: "\n")
        for banned in [".foregroundStyle(.primary)", ".foregroundStyle(.secondary)", "Color.secondary", "Color.primary", "Color.red",
                       ".ultraThinMaterial", ".foregroundColor(", "Color(red: 0.24"] {
            XCTAssertFalse(code.contains(banned),
                           "«\(banned)»: the player is dark whatever the device's appearance is; its colours come from MondropPalette")
        }
        XCTAssertTrue(code.contains("MondropPalette"))
        XCTAssertTrue(code.contains(".environment(\\.colorScheme, .dark)"), "the controls are told to draw dark too (the slider's track)")
        XCTAssertTrue(code.contains(".frame(width: layout.coverSide, height: layout.coverSide)"), "the cover is a square asked of the frame itself")
        XCTAssertFalse(code.contains(".aspectRatio(1, contentMode: .fit)"), "that, after a frame(maxWidth:), made a 320 × 650 rectangle on an iPad")
    }
}
