import XCTest

/// The icons ship as committed PNGs, drawn by `ios/scripts/make_app_icon.mjs` (spec 2026-11-08-mondrop-app-icon-design.md).
/// App Store Connect refuses a marketing icon that is not 1024×1024 or that has an alpha channel, and finds out only at
/// upload: so the files are read here, like `DeletionPlacesTests` reads the sources.
final class AppIconAssetsTests: XCTestCase {
    /// `ios/` as found from this file: it sits at `ios/MondropTests/`.
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    private struct Catalog: Decodable {
        struct Image: Decodable {
            struct Appearance: Decodable { var appearance: String; var value: String }
            var filename: String?
            var idiom: String
            var platform: String?
            var size: String
            var scale: String?
            var appearances: [Appearance]?
        }
        var images: [Image]
    }

    private struct Header { var width: Int; var height: Int; var colorType: Int }

    private func catalog(_ target: String) throws -> (dir: URL, images: [Catalog.Image]) {
        let dir = iosRoot.appendingPathComponent("\(target)/Assets.xcassets/AppIcon.appiconset")
        let data = try Data(contentsOf: dir.appendingPathComponent("Contents.json"))
        return (dir, try JSONDecoder().decode(Catalog.self, from: data).images)
    }

    /// Width, height and colour type of a PNG, read from its IHDR chunk (colour type 2 = RGB, 6 = RGB with alpha).
    private func header(_ url: URL) throws -> Header {
        let data = try Data(contentsOf: url)
        XCTAssertGreaterThan(data.count, 33, "\(url.lastPathComponent) is not a PNG")
        XCTAssertEqual(Array(data.prefix(8)), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], "\(url.lastPathComponent) is not a PNG")
        func word(_ at: Int) -> Int { data[at ..< at + 4].reduce(0) { $0 << 8 | Int($1) } }
        return Header(width: word(16), height: word(20), colorType: Int(data[25]))
    }

    private func mode(_ image: Catalog.Image) -> String { image.appearances?.first?.value ?? "default" }

    func testTheAppIconHasALightADarkAndATintedPictureAndNoneHasAlpha() throws {
        let (dir, images) = try catalog("Mondrop")
        let ios = images.filter { $0.platform == "ios" }
        XCTAssertEqual(ios.map(mode), ["default", "dark", "tinted"], "iOS 18 asks for the three appearances")
        for image in ios {
            let name = try XCTUnwrap(image.filename)
            let head = try header(dir.appendingPathComponent(name))
            XCTAssertEqual(head.width, 1024, name)
            XCTAssertEqual(head.height, 1024, name)
            XCTAssertEqual(head.colorType, 2, "\(name) must be RGB without alpha: App Store Connect refuses an icon with transparency")
            XCTAssertEqual(image.size, "1024x1024", name)
        }
    }

    func testTheShareSheetIconIsOneOpaque1024() throws {
        let (dir, images) = try catalog("MondropShare")
        let ios = images.filter { $0.platform == "ios" }
        XCTAssertEqual(ios.map(mode), ["default"])
        let name = try XCTUnwrap(ios.first?.filename)
        let head = try header(dir.appendingPathComponent(name))
        XCTAssertEqual([head.width, head.height, head.colorType], [1024, 1024, 2], name)
    }

    func testBothMacSetsHaveTheTenSizesAtTheirPixels() throws {
        for target in ["Mondrop", "MondropShare"] {
            let (dir, images) = try catalog(target)
            let mac = images.filter { $0.idiom == "mac" }
            XCTAssertEqual(mac.count, 10, "\(target): 16, 32, 128, 256 and 512 pt at 1× and 2×")
            for image in mac {
                let name = try XCTUnwrap(image.filename)
                let points = try XCTUnwrap(Int(image.size.split(separator: "x").first ?? ""))
                let scale = try XCTUnwrap(Int(image.scale?.dropLast() ?? ""))
                let head = try header(dir.appendingPathComponent(name))
                XCTAssertEqual([head.width, head.height], [points * scale, points * scale], "\(target)/\(name)")
                XCTAssertEqual(head.colorType, 6, "\(target)/\(name): the macOS tile has transparent corners")
            }
        }
    }
}
