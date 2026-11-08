import XCTest
@testable import Mondrop

/// Smoke: BackendClient.share reaches production /api/share from the Simulator network.
final class ShareClientTests: XCTestCase {
    func testShareEnqueue() async throws {
        let key = ShareKeyFixture.value.trimmingCharacters(in: .whitespacesAndNewlines)
        try XCTSkipIf(key.isEmpty || key.contains("REPLACE"), "Generate MondropTests/ShareKey.generated.swift")

        Settings.shared.apiKey = key
        Settings.shared.backendBaseUrl = "https://soundreel.casamon.dev"

        let stamp = Int(Date().timeIntervalSince1970)
        let url = "https://www.youtube.com/watch?v=mondropTest\(stamp)"
        let resp = try await BackendClient().share(
            url: url,
            comment: "#mondrop xctest",
            tags: nil
        )
        XCTAssertTrue(resp.success, resp.error ?? "share failed")
        XCTAssertEqual(resp.status, "queued")
        XCTAssertNotNil(resp.entryId)
        XCTAssertTrue((resp.tags ?? []).contains(where: { $0.lowercased().contains("mondrop") }))
    }
}
