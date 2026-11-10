// RemoteCommandLog.swift — what Bluetooth, the car and the lock screen can press, and the list the phone keeps of what really arrived
// (spec 2026-11-10-mondrop-like-and-repeat-design.md L5, L6). Nobody could say what a car sends to an app that is not its own: this list, in
// the Settings, says it. The commands are named in one place and written down in one place (`LocalAudioPlayer.perform`).

import Foundation

/// A command that reached the player from outside the app.
public enum RemoteCommand: Equatable, Sendable {
    case play, pause, togglePlayPause, next, previous
    /// The loop the system asks for.
    case repeatMode(RepeatMode)
    /// The heart; `negative` is the system saying «take the like back».
    case like(negative: Bool)

    /// How the list in the Settings calls it.
    public var logName: String {
        switch self {
        case .play: return "Play"
        case .pause: return "Pausa"
        case .togglePlayPause: return "Play/Pausa"
        case .next: return "Avanti"
        case .previous: return "Indietro"
        case .repeatMode(let mode): return mode.accessibilityLabel
        case .like(let negative): return negative ? "Non mi piace più" : "Mi piace"
        }
    }
}

/// One line of the list: the name of the command and when it arrived.
public struct RemoteCommandRecord: Codable, Equatable, Sendable {
    public let name: String
    public let at: Date

    public init(name: String, at: Date) {
        self.name = name
        self.at = at
    }
}

public enum RemoteCommandHistory {
    /// The last twenty are kept.
    public static let capacity = 20

    /// The new one in front, the oldest ones gone.
    public static func adding(_ name: String, at: Date, to list: [RemoteCommandRecord]) -> [RemoteCommandRecord] {
        Array(([RemoteCommandRecord(name: name, at: at)] + list).prefix(capacity))
    }
}

/// The list, kept in the App Group defaults like the other small settings, newest first.
@MainActor
public final class RemoteCommandLog: ObservableObject {
    public static let key = "remoteCommandLog"
    public static let shared = RemoteCommandLog(defaults: Settings.shared.storage)

    @Published public private(set) var entries: [RemoteCommandRecord]

    private let defaults: UserDefaults
    private let now: () -> Date

    public init(defaults: UserDefaults, now: @escaping () -> Date = { Date() }) {
        self.defaults = defaults
        self.now = now
        if let data = defaults.data(forKey: Self.key), let kept = try? EventCoding.decoder().decode([RemoteCommandRecord].self, from: data) {
            entries = Array(kept.prefix(RemoteCommandHistory.capacity))
        } else {
            entries = []
        }
    }

    public func record(_ name: String) {
        entries = RemoteCommandHistory.adding(name, at: now(), to: entries)
        save()
    }

    public func clear() {
        entries = []
        defaults.removeObject(forKey: Self.key)
    }

    private func save() {
        guard let data = try? EventCoding.encoder().encode(entries) else { return }
        defaults.set(data, forKey: Self.key)
    }
}
