// HomeModel.swift — the Home of Mondrop (spec 2026-11-08-mondrop-home-spotify-design.md, ADR-0020): loading the sections the server
// decided, the greeting, and the «Riprendi» card, which is the phone's own queue (the one thing on the Home that is not the server's).
// Pure where it can be (greeting, card, screen state), so the words and the rules are tested without a screen.

import Foundation

/// «Buongiorno, Michele»: by the hour of the PHONE (the server does not know where the phone is), with the name when there is one.
public enum HomeGreeting {
    /// 5–12 «Buongiorno», 13–17 «Buon pomeriggio», from 18 and through the night «Buonasera».
    public static func word(hour: Int) -> String {
        switch hour {
        case 5..<13: return "Buongiorno"
        case 13..<18: return "Buon pomeriggio"
        default: return "Buonasera"
        }
    }

    public static func make(hour: Int, name: String?) -> String {
        let who = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return who.isEmpty ? word(hour: hour) : "\(word(hour: hour)), \(who)"
    }

    public static func make(at date: Date = Date(), calendar: Calendar = .current, name: String?) -> String {
        make(hour: calendar.component(.hour, from: date), name: name)
    }
}

/// The «Riprendi» card: where the user was. Built from the player's queue, which survives a relaunch (`QueueSnapshot`) and comes back
/// PAUSED — the play is never automatic.
public struct ResumeCard: Equatable, Sendable {
    public let songKey: String
    public let title: String
    public let artist: String
    public let coverPath: String?
    /// «Playlist · Road trip · 2 / 7»: what the queue is and where in it. Just the position when the queue has no name.
    public let queueLine: String
    /// How far into the song, 0…1 (0 when the length is not known yet).
    public let progress: Double
    public let isPlaying: Bool

    public static func make(
        queue: [QueueItem], index: Int, label: String?, currentTime: Double, duration: Double, playing: Bool
    ) -> ResumeCard? {
        guard queue.indices.contains(index) else { return nil }
        let item = queue[index]
        var parts: [String] = []
        if let name = label?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { parts.append(name) }
        if queue.count > 1 { parts.append("\(index + 1) / \(queue.count)") }
        let fraction = duration > 0 && duration.isFinite && currentTime.isFinite ? min(max(currentTime / duration, 0), 1) : 0
        return ResumeCard(
            songKey: item.songKey, title: item.title, artist: item.artist, coverPath: item.coverPath,
            queueLine: parts.isEmpty ? "In coda" : parts.joined(separator: " · "),
            progress: fraction, isPlaying: playing
        )
    }
}

/// What the Home shows, decided from what it has (so that the cases are tested, not guessed by the view).
public enum HomeScreenState: Equatable, Sendable {
    /// The first answer has not come yet: nothing to show.
    case loading
    /// Sections to draw. A reload that fails leaves them in place: a stale Home is better than a blank one.
    case sections
    /// The server answered and has nothing for this user (a new user, an empty journal).
    case empty
    /// Nothing to show and the server did not answer.
    case failed(String)

    public static func make(phase: HomeModel.Phase, sections: [HomeSection]) -> HomeScreenState {
        if !sections.isEmpty { return .sections }
        switch phase {
        case .idle, .loading: return .loading
        case .loaded: return .empty
        case .failed(let message): return .failed(message)
        }
    }
}

@MainActor
public final class HomeModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    @Published public private(set) var phase: Phase = .idle
    /// The sections to draw, in the order the server gave them.
    @Published public private(set) var sections: [HomeSection] = []
    @Published public private(set) var displayName: String?

    private let transport: HomeTransport

    public init(transport: HomeTransport) {
        self.transport = transport
    }

    public var state: HomeScreenState { HomeScreenState.make(phase: phase, sections: sections) }

    /// The line under «Non riesco a caricare la Home» (what went wrong), or nil.
    public var failure: String? {
        if case .failed(let message) = phase { return message }
        return nil
    }

    /// Loads, or reloads, the Home. One load at a time. A failure keeps what was on screen and says what went wrong.
    public func load() async {
        guard phase != .loading else { return }
        let before = phase
        phase = .loading
        do {
            let response = try await transport.home()
            sections = response.renderableSections
            let name = response.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            displayName = name.isEmpty ? nil : name
            phase = .loaded
        } catch {
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
                phase = before                                       // the user left the screen: nothing went wrong
                return
            }
            phase = .failed((error as? MondropAPIError)?.description ?? error.localizedDescription)
        }
    }
}
