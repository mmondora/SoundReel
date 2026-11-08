import XCTest
@testable import Mondrop

/// Pure parsing/URL tests for the "login from the device" key flow (no network).
final class KeyConnectTests: XCTestCase {
    private let sampleKey = "sr_abcdefghijklmnopqrstuvwxyz012345"

    func testConnectURLBuildsConnectPathWithDevice() {
        let url = KeyConnect.connectURL(base: "https://soundreel.casamon.dev/", device: "iPhone di Michele")
        XCTAssertEqual(
            url?.absoluteString,
            "https://soundreel.casamon.dev/mondrop/connect?device=iPhone%20di%20Michele"
        )
    }

    func testConnectURLRequiresHttps() {
        XCTAssertNil(KeyConnect.connectURL(base: "http://soundreel.casamon.dev", device: "x"))
        XCTAssertNil(KeyConnect.connectURL(base: "not a url", device: "x"))
        XCTAssertNil(KeyConnect.connectURL(base: "", device: "x"))
    }

    func testParseCallbackReadsKeyUserAndDevice() throws {
        let url = try XCTUnwrap(URL(string: "mondrop://auth?key=\(sampleKey)&user=Mike&device=iPhone%20di%20Michele"))
        XCTAssertEqual(
            KeyConnect.parseCallback(url),
            KeyConnect.Issued(key: sampleKey, user: "mike", device: "iPhone di Michele")
        )
    }

    func testParseCallbackRejectsOtherLinks() throws {
        let share = try XCTUnwrap(URL(string: "mondrop://share?url=https://example.com"))
        let wrongScheme = try XCTUnwrap(URL(string: "https://auth?key=\(sampleKey)&user=mike"))
        let badKey = try XCTUnwrap(URL(string: "mondrop://auth?key=nope&user=mike"))
        let noUser = try XCTUnwrap(URL(string: "mondrop://auth?key=\(sampleKey)"))
        XCTAssertNil(KeyConnect.parseCallback(share))
        XCTAssertNil(KeyConnect.parseCallback(wrongScheme))
        XCTAssertNil(KeyConnect.parseCallback(badKey))
        XCTAssertNil(KeyConnect.parseCallback(noUser))
    }
}
