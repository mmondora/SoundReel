// ios/MondropKit/Settings.swift

import Foundation
#if canImport(UIKit)
import UIKit
#endif
#if canImport(AppKit)
import AppKit
#endif

public final class Settings {
    public static let shared = Settings()

    public static let appGroupId = "group.it.mikesoft.mondrop"

    /// Authelia usernames (casamon) — must match `geekom-hub/authelia/config/users.yml`.
    public static let autheliaUsers: [(id: String, label: String)] = [
        ("mike", "Michele (mike)"),
        ("archi", "Archimede (archi)"),
        ("sara", "Sara (sara)"),
    ]

    private let defaults: UserDefaults

    private init() {
        #if targetEnvironment(simulator)
        self.defaults = .standard
        #else
        self.defaults = UserDefaults(suiteName: Self.appGroupId) ?? .standard
        #endif
        if autheliaUsername.isEmpty {
            autheliaUsername = Self.suggestAutheliaUsername()
        }
    }

    public var backendBaseUrl: String {
        get { defaults.string(forKey: "backendBaseUrl") ?? "https://soundreel.casamon.dev" }
        set { defaults.set(newValue, forKey: "backendBaseUrl") }
    }

    public var targetDisplayName: String {
        get { defaults.string(forKey: "targetDisplayName") ?? "Mondrop" }
        set { defaults.set(newValue, forKey: "targetDisplayName") }
    }

    /// Personal ingest key (`X-SoundReel-Key`). App Group so Share Extension can read it.
    public var apiKey: String {
        get { defaults.string(forKey: "apiKey") ?? "" }
        set { defaults.set(newValue, forKey: "apiKey") }
    }

    /// Authelia username (`mike` / `archi` / `sara`). Editable; OIDC will lock this later.
    public var autheliaUsername: String {
        get { defaults.string(forKey: "autheliaUsername") ?? "" }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), forKey: "autheliaUsername") }
    }

    /// "Scarica anche con rete cellulare". Off by default: sync downloads are Wi-Fi only.
    public var allowCellularDownloads: Bool {
        get { defaults.bool(forKey: "allowCellularDownloads") }
        set { defaults.set(newValue, forKey: "allowCellularDownloads") }
    }

    /// «Avvisami a sync finito»: a local notification when a sync ends while the app is not in front. ON by default
    /// (a missing key means ON — `bool(forKey:)` would say OFF); iOS is only asked for permission when it is first needed.
    public var syncNotificationsEnabled: Bool {
        get { (defaults.object(forKey: "syncNotificationsEnabled") as? Bool) ?? true }
        set { defaults.set(newValue, forKey: "syncNotificationsEnabled") }
    }

    public var recentTags: [String] {
        get { defaults.stringArray(forKey: "recentTags") ?? [] }
        set { defaults.set(Array(newValue.prefix(24)), forKey: "recentTags") }
    }

    public func rememberTags(_ tags: [String]) {
        var next = recentTags
        for tag in tags.reversed() {
            let t = tag.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { continue }
            next.removeAll { $0.caseInsensitiveCompare(t) == .orderedSame }
            next.insert(t, at: 0)
        }
        recentTags = Array(next.prefix(24))
    }

    public static func deviceDisplayName() -> String {
        #if canImport(UIKit) && !os(watchOS)
        return UIDevice.current.name
        #elseif canImport(AppKit)
        return Host.current().localizedName ?? "Mac"
        #else
        return "device"
        #endif
    }

    public static func deviceModel() -> String {
        #if canImport(UIKit) && !os(watchOS)
        return UIDevice.current.model
        #else
        return "Mac"
        #endif
    }

    public static func systemVersion() -> String {
        #if canImport(UIKit) && !os(watchOS)
        return "iOS \(UIDevice.current.systemVersion)"
        #elseif canImport(AppKit)
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
        #else
        return "unknown"
        #endif
    }

    /// Guess Authelia id from device name (editable afterwards).
    public static func suggestAutheliaUsername() -> String {
        let name = deviceDisplayName().lowercased()
        if name.contains("archi") || name.contains("archimede") { return "archi" }
        if name.contains("sara") { return "sara" }
        if name.contains("michele") || name.contains("mike") || name.contains("mondora") { return "mike" }
        return "mike"
    }
}

public extension String {
    var trimmedTrailingSlash: String { hasSuffix("/") ? String(dropLast()) : self }
}
