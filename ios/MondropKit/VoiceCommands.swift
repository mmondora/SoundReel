// VoiceCommands.swift — what Siri can ask of the player (spec 2026-11-10-mondrop-like-and-repeat-design.md L9). Over Bluetooth the Tesla shows
// only previous / pause / next: no repeat, no heart. The voice works whatever the head unit shows: «Ehi Siri, mi piace questa canzone su
// Mondrop». What is decided here (nothing playing, already liked, what is said back) is plain code; the App Intents of the app target only
// carry the request to the player and the likes the app already has, and speak the answer.
//
// A voice command is not the button of the car: «mi piace» twice stays a like (the button of a liked song takes it back), and «non mi piace
// più» on a song that is not liked changes nothing.

import Foundation

/// A request of the voice.
public enum VoiceCommand: Equatable, Sendable {
    case like, unlike
    case repeatMode(RepeatMode)

    /// How the list in the Settings calls it: «Siri: Mi piace». The same list as the commands of the car, so that it says what arrived and from where.
    public var logName: String {
        switch self {
        case .like: return "Siri: Mi piace"
        case .unlike: return "Siri: Non mi piace più"
        case .repeatMode(let mode): return "Siri: " + mode.accessibilityLabel
        }
    }
}

/// The song the voice talks about: the one the queue is on (playing or paused: «questa canzone» is the one on the screen).
public struct CurrentSong: Equatable, Sendable {
    public let songKey: String
    public let title: String

    public init(songKey: String, title: String) {
        self.songKey = songKey
        self.title = title
    }
}

/// What happened, as a value: Siri says it in Italian, in one short sentence.
public enum VoiceOutcome: Equatable, Sendable {
    case nothingPlaying
    case liked(title: String)
    case alreadyLiked(title: String)
    case unliked(title: String)
    case wasNotLiked(title: String)
    case repeatSet(RepeatMode)

    public var spoken: String {
        switch self {
        case .nothingPlaying: return "Non c'è nessun brano in riproduzione."
        case .liked(let title): return "Fatto: ti piace «\(title)»."
        case .alreadyLiked(let title): return "Ti piace già «\(title)»."
        case .unliked(let title): return "Fatto: «\(title)» non ti piace più."
        case .wasNotLiked(let title): return "«\(title)» non era tra i brani che ti piacciono."
        case .repeatSet(let mode):
            switch mode {
            case .one: return "Ripetizione: questo brano."
            case .all: return "Ripetizione: tutta la coda."
            case .off: return "Ripetizione: spenta."
            }
        }
    }
}

public enum VoiceDecision {
    /// A like (`wanted`) or an unlike of the current song, and whether the likes must change: never when it already is so, never without a song.
    public static func like(wanted: Bool, current: CurrentSong?, isLiked: Bool) -> (outcome: VoiceOutcome, change: Bool) {
        guard let current else { return (.nothingPlaying, false) }
        let trimmed = current.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = trimmed.isEmpty ? "questo brano" : trimmed
        if wanted {
            return isLiked ? (.alreadyLiked(title: title), false) : (.liked(title: title), true)
        }
        return isLiked ? (.unliked(title: title), true) : (.wasNotLiked(title: title), false)
    }
}

// MARK: - Choosing what to play (L10)

/// «Metti la playlist X» and «metti un brano»: what was asked, for the list of the Settings («Siri: playlist Road trip»).
public enum VoicePlayRequest: Equatable, Sendable {
    case playlist(String)
    case song(String)

    public var logName: String {
        switch self {
        case .playlist(let name): return "Siri: playlist " + name.trimmingCharacters(in: .whitespacesAndNewlines)
        case .song(let words): return "Siri: brano " + words.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
}

/// What came of it, as a value: Siri says it in Italian, in one short sentence.
public enum VoicePlayOutcome: Equatable, Sendable {
    case playlistStarted(name: String)
    case playlistNotFound
    case playlistEmpty(name: String)
    case playlistUnreachable(name: String)
    case songStarted(title: String, artist: String)
    case songNotFound
    case nothingAsked

    public var spoken: String {
        switch self {
        case .playlistStarted(let name): return "Metto la playlist «\(name)»."
        case .playlistNotFound: return "Non trovo nessuna playlist che si chiama così."
        case .playlistEmpty(let name): return "La playlist «\(name)» non ha brani da ascoltare."
        case .playlistUnreachable(let name): return "Non riesco a leggere la playlist «\(name)»: il server non risponde."
        case .songStarted(let title, let artist):
            return artist.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Metto «\(title)»." : "Metto «\(title)» di \(artist)."
        case .songNotFound: return "Non ho trovato niente."
        case .nothingAsked: return "Non ho capito che brano vuoi."
        }
    }
}
