// RepeatMode.swift — the loop of the Player (spec 2026-11-10-mondrop-like-and-repeat-design.md L4; Michele, 10 November: «il loop da
// player bluetooth es dalla auto»): none, the whole queue, this song. What happens when a song ends by itself, and when «avanti» is
// pressed, is decided here as plain code; the player only does what `RepeatPolicy` says. The choice is kept between launches.

import Foundation
import MediaPlayer

public enum RepeatMode: String, CaseIterable, Codable, Sendable {
    /// The queue plays to its end and stops, as it always did.
    case off
    /// The whole queue: after the last song comes the first.
    case all
    /// This song, again and again.
    case one

    /// The button goes round: none → the whole queue → this song → none.
    public var next: RepeatMode {
        switch self {
        case .off: return .all
        case .all: return .one
        case .one: return .off
        }
    }

    /// What VoiceOver says of the button, and the name of the command in the list the phone keeps of what the car sent.
    public var accessibilityLabel: String {
        switch self {
        case .off: return "Ripeti: no"
        case .all: return "Ripeti: tutto"
        case .one: return "Ripeti: questo brano"
        }
    }
}

/// One line of the menu of the loop, which opens with a long press on the play of the mini player and of «Riprendi» (spec 2026-11-12-mondrop-home-play-loop-reels-design.md M2; Michele, 12 November:
/// «sul play voglio anche il "loop" del singolo o della playlist»): the three states of the Player's button, named. Plain data: the screen only draws it.
public struct RepeatChoice: Identifiable, Equatable, Sendable {
    public let mode: RepeatMode
    public let title: String
    /// The symbol of the line: a checkmark on the one in use, its own on the others.
    public let systemImage: String
    public let isSelected: Bool

    public var id: String { mode.rawValue }

    /// `forPlaylist`: the queue was started from a playlist («Ripeti la playlist»); for a search, an album or a row of the Home it is «la coda».
    public static func all(current: RepeatMode, forPlaylist: Bool) -> [RepeatChoice] {
        RepeatMode.allCases.map { mode in
            let selected = mode == current
            switch mode {
            case .off:
                return RepeatChoice(mode: mode, title: "Non ripetere", systemImage: selected ? "checkmark" : "arrow.forward", isSelected: selected)
            case .all:
                return RepeatChoice(mode: mode, title: forPlaylist ? "Ripeti la playlist" : "Ripeti la coda", systemImage: selected ? "checkmark" : "repeat", isSelected: selected)
            case .one:
                return RepeatChoice(mode: mode, title: "Ripeti questo brano", systemImage: selected ? "checkmark" : "repeat.1", isSelected: selected)
            }
        }
    }
}

extension RepeatMode {
    /// The small mark on the play button while the loop is on; nothing when it is off.
    public var indicatorSymbol: String? {
        switch self {
        case .off: return nil
        case .all: return "repeat"
        case .one: return "repeat.1"
        }
    }

    /// What VoiceOver says of the mark (the same words as the button of the Player).
    public var indicatorLabel: String? { indicatorSymbol == nil ? nil : accessibilityLabel }
}

extension RepeatMode {
    /// What the system (the car, the lock screen) calls the same three states.
    public init(_ system: MPRepeatType) {
        switch system {
        case .off: self = .off
        case .one: self = .one
        case .all: self = .all
        @unknown default: self = .off
        }
    }

    public var systemType: MPRepeatType {
        switch self {
        case .off: return .off
        case .all: return .all
        case .one: return .one
        }
    }
}

/// What the player does next. Pure: the table is tested without an AVPlayer.
public enum RepeatPolicy {
    public enum Step: Equatable, Sendable {
        /// Start the song at this place of the queue.
        case play(Int)
        /// The same song again, from the top.
        case replay
        /// Nothing comes after: the queue is over.
        case stop
    }

    /// A song reached its end by itself. With «questo brano» it starts again; with «tutto» the last is followed by the first (a queue of one
    /// song is then the same song again); with «nessuno» the queue ends.
    public static func whenSongEnds(mode: RepeatMode, index: Int, count: Int) -> Step {
        guard count > 0 else { return .stop }
        switch mode {
        case .one:
            return .replay
        case .all:
            if index + 1 < count { return .play(index + 1) }
            return count == 1 ? .replay : .play(0)
        case .off:
            return index + 1 < count ? .play(index + 1) : .stop
        }
    }

    /// «Avanti», from the button, the car or the lock screen: the song after, whatever the loop is. After the last one it wraps only with
    /// «tutto»; with «questo brano» it has nothing to go to, like with «nessuno».
    public static func whenNext(mode: RepeatMode, index: Int, count: Int) -> Step {
        guard count > 0 else { return .stop }
        if index + 1 < count { return .play(index + 1) }
        guard mode == .all else { return .stop }
        return count == 1 ? .replay : .play(0)
    }
}

/// Where the choice is kept.
public protocol RepeatModeStore: AnyObject {
    var mode: RepeatMode { get set }
}

public final class MemoryRepeatModeStore: RepeatModeStore {
    public var mode: RepeatMode
    public init(_ mode: RepeatMode = .off) { self.mode = mode }
}

/// In the App Group defaults, like the other small Mondrop settings. Anything unreadable is «nessuno»: the loop was never on by itself.
public final class DefaultsRepeatModeStore: RepeatModeStore {
    public static let key = "repeatMode"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults) { self.defaults = defaults }

    public var mode: RepeatMode {
        get { defaults.string(forKey: Self.key).flatMap(RepeatMode.init(rawValue:)) ?? .off }
        set { defaults.set(newValue.rawValue, forKey: Self.key) }
    }
}
