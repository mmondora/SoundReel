// ios/SoundReelKit/Settings.swift

import Foundation

public final class Settings {
    public static let shared = Settings()

    private let defaults: UserDefaults

    private init() {
        self.defaults = UserDefaults(suiteName: "group.com.mmondora.soundreel") ?? .standard
    }

    public var backendBaseUrl: String {
        get { defaults.string(forKey: "backendBaseUrl") ?? "https://soundreel.casamon.dev" }
        set { defaults.set(newValue, forKey: "backendBaseUrl") }
    }

    public var targetDisplayName: String {
        get { defaults.string(forKey: "targetDisplayName") ?? "SoundReel" }
        set { defaults.set(newValue, forKey: "targetDisplayName") }
    }
}

public extension String {
    var trimmedTrailingSlash: String { hasSuffix("/") ? String(dropLast()) : self }
}
