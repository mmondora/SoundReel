// ios/MondropKit/KeyConnect.swift
//
// "Login from the device". The app opens `<backend>/mondrop/connect` in a system
// web-auth sheet, the user signs in with Authelia, the page issues a personal API
// key for this device and redirects to `mondrop://auth?key=…&user=…&device=…`.
// Backend: backend/src/routes/mondropConnect.ts.

import Foundation

public enum KeyConnect {
    /// URL scheme the connect page redirects to (registered in Mondrop/Info.plist).
    public static let callbackScheme = "mondrop"

    /// Posted after a key has been stored, so open screens can refresh.
    public static let didChange = Notification.Name("it.mikesoft.mondrop.keyConnect.didChange")

    public struct Issued: Equatable {
        public let key: String
        public let user: String
        public let device: String?

        public init(key: String, user: String, device: String?) {
            self.key = key
            self.user = user
            self.device = device
        }
    }

    /// `<backend>/mondrop/connect?device=<name>`; nil unless the backend is a valid https URL.
    public static func connectURL(base: String, device: String) -> URL? {
        let trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var comps = URLComponents(string: trimmed),
              comps.scheme?.lowercased() == "https",
              let host = comps.host, !host.isEmpty else { return nil }
        comps.path = "/mondrop/connect"
        comps.fragment = nil
        comps.queryItems = [URLQueryItem(name: "device", value: device)]
        return comps.url
    }

    /// Parses `mondrop://auth?key=sr_…&user=mike&device=…`; nil for anything else.
    public static func parseCallback(_ url: URL) -> Issued? {
        guard url.scheme?.lowercased() == callbackScheme,
              (url.host ?? "").lowercased() == "auth",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else {
            return nil
        }
        func value(_ name: String) -> String? {
            items.first(where: { $0.name == name })?.value?
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let key = value("key"), key.hasPrefix("sr_"), key.count >= 16,
              let user = value("user")?.lowercased(), !user.isEmpty else {
            return nil
        }
        let device = value("device").flatMap { $0.isEmpty ? nil : $0 }
        return Issued(key: key, user: user, device: device)
    }

    /// Persist key + user (App Group, so the Share Extension sees them) and notify listeners.
    public static func apply(_ issued: Issued, to settings: Settings = .shared) {
        settings.apiKey = issued.key
        settings.autheliaUsername = issued.user
        NotificationCenter.default.post(name: didChange, object: nil)
    }
}
