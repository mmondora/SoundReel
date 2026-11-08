import XCTest
@testable import Mondrop

/// The whole app is dark and yellow (spec 2026-11-08-mondrop-home-spotify-design.md H9–H10). Michele, 8 November: «A, si giallo» — the yellow of
/// the new icon is the accent of EVERYTHING: the tab bar, the links, the buttons. The yellow does not read on white (1.4:1; 4.5 is the minimum),
/// so the app is dark whatever the phone's appearance is, and every pair of colours that is drawn has its contrast tested.
final class MondropPaletteTests: XCTestCase {
    private let gradientEnds = [MondropPalette.backgroundTop, MondropPalette.backgroundBottom]
    private var allBackgrounds: [RGB] { gradientEnds + MondropPalette.systemDarkBackgrounds }

    // MARK: why the app is dark

    func testTheYellowDoesNotReadOnWhite() {
        XCTAssertLessThan(RGB.contrast(MondropPalette.accent, RGB(1, 1, 1)), 2, "that is the reason the whole app is dark")
    }

    func testWhiteOnTheYellowDoesNotReadEitherSoWhatIsOnTheYellowIsBlack() {
        XCTAssertLessThan(RGB.contrast(MondropPalette.text, MondropPalette.accent), 2)
        XCTAssertGreaterThanOrEqual(RGB.contrast(MondropPalette.onAccent, MondropPalette.accent), 7, "the glyph of the yellow play button, the label of a yellow pill")
    }

    // MARK: the yellow and the words, on every dark background the app has

    func testTheYellowReadsOnEveryBackgroundOfTheApp() {
        for background in allBackgrounds {
            XCTAssertGreaterThanOrEqual(RGB.contrast(MondropPalette.accent, background), 7, "links, the tab bar, switches, the slider")
        }
    }

    func testTheWordsReadOnEveryBackgroundOfTheApp() {
        for background in allBackgrounds {
            XCTAssertGreaterThanOrEqual(RGB.contrast(MondropPalette.text, background), 7)
            XCTAssertGreaterThanOrEqual(RGB.contrast(MondropPalette.secondaryText(over: background), background), 4.5)
        }
    }

    func testTheCardsOfTheHomeCanBeRead() {
        for background in gradientEnds {
            let card = MondropPalette.cardFill(over: background)
            XCTAssertGreaterThanOrEqual(RGB.contrast(MondropPalette.text, card), 7, "playlist and song titles")
            XCTAssertGreaterThanOrEqual(RGB.contrast(MondropPalette.secondaryText(over: card), card), 4.5, "artists and the line under «Riprendi»")
            XCTAssertGreaterThanOrEqual(RGB.contrast(MondropPalette.accent, card), 7, "«RIPRENDI» and the download arrows")
        }
    }

    func testTheErrorReadsOnEveryBackgroundOfTheApp() {
        for background in allBackgrounds {
            XCTAssertGreaterThanOrEqual(RGB.contrast(MondropPalette.error, background), 4.5)
        }
    }

    // MARK: the places where the palette has to be the app's, not just a table of numbers

    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    private func text(_ relative: String) throws -> String {
        try String(contentsOf: iosRoot.appendingPathComponent(relative), encoding: .utf8)
    }

    /// The «AccentColor» of the asset catalog is what UIKit-drawn parts take (alerts, the share sheet buttons, menus): it must be the palette's.
    func testTheAccentOfTheAssetCatalogIsThePalettesYellow() throws {
        let data = try Data(contentsOf: iosRoot.appendingPathComponent("Mondrop/Assets.xcassets/AccentColor.colorset/Contents.json"))
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let colors = try XCTUnwrap(root["colors"] as? [[String: Any]])
        let color = try XCTUnwrap(colors.first?["color"] as? [String: Any])
        let components = try XCTUnwrap(color["components"] as? [String: String])
        func value(_ name: String) throws -> Double { try XCTUnwrap(Double(try XCTUnwrap(components[name]))) }
        XCTAssertEqual(try value("red"), MondropPalette.accent.red, accuracy: 0.005)
        XCTAssertEqual(try value("green"), MondropPalette.accent.green, accuracy: 0.005)
        XCTAssertEqual(try value("blue"), MondropPalette.accent.blue, accuracy: 0.005)
        XCTAssertNil(colors.first?["appearances"], "one yellow for every appearance: there is only one appearance")
    }

    func testTheAppIsDarkWhateverThePhonesAppearanceIs() throws {
        XCTAssertTrue(try text("Mondrop/Info.plist").contains("<key>UIUserInterfaceStyle</key>\n\t<string>Dark</string>"))
        let app = try text("Mondrop/MondropApp.swift")
        XCTAssertTrue(app.contains(".preferredColorScheme(.dark)"), "the Mac has no Info.plist key for it")
        XCTAssertTrue(app.contains(".tint(Color(MondropPalette.accent))"))
    }

    /// `.borderedProminent` paints a WHITE label: on the yellow that is 1.4:1. In the app only a red one (a destructive action) may use it;
    /// a yellow button is `MondropPillStyle`, with black words. (The Share extension, which keeps the system's blue, is not the app.)
    func testNoYellowButtonHasWhiteWords() throws {
        let directory = iosRoot.appendingPathComponent("Mondrop", isDirectory: true)
        let walker = try XCTUnwrap(FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil))
        var checked = 0
        for case let file as URL in walker where file.pathExtension == "swift" {
            let lines = try String(contentsOf: file, encoding: .utf8).components(separatedBy: "\n")
            for (index, line) in lines.enumerated() where line.contains(".borderedProminent") && !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
                checked += 1
                let before = lines[max(0, index - 4)...index].joined(separator: "\n")
                XCTAssertTrue(before.contains("role: .destructive"), "\(file.lastPathComponent):\(index + 1): a yellow button with a white label; use MondropPillStyle(prominent: true)")
            }
        }
        XCTAssertGreaterThan(checked, 0, "the scan must find the one red button it is allowed")
    }

    /// The colours of the screens that are always dark come from the palette, not from the system (black in light mode, which is no longer
    /// possible, but the rule keeps the screens independent of the system's choices).
    func testTheHomeTakesItsColoursFromThePalette() throws {
        for file in ["Mondrop/HomeView.swift", "Mondrop/MiniPlayer.swift"] {
            let source = try text(file)
            let code = source.components(separatedBy: "\n").map { $0.components(separatedBy: "//")[0] }.joined(separator: "\n")
            for banned in [".foregroundStyle(.primary)", ".foregroundStyle(.secondary)", "Color.secondary", "Color.primary", "Color.red", ".foregroundColor("] {
                XCTAssertFalse(code.contains(banned), "\(file): «\(banned)» — use MondropPalette")
            }
            XCTAssertTrue(code.contains("MondropPalette"), file)
        }
    }
}
