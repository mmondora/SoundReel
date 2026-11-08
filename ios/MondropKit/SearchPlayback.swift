// SearchPlayback.swift — what a tap, «Riproduci», «Casuale» and «Aggiungi in coda» do with the songs «Cerca» shows
// (spec 2026-11-08-mondrop-search-spotify-style-design.md S3, S4). Pure: the same rules for a result list, an artist page
// and an album page, tested without a player.

import Foundation

public enum SearchPlayback {
    /// The words shown as «In coda: …»: an album page is «Album · …», an artist page «Autore · …», a search «Ricerca · «…»».
    public static func choice(text: String, artist: String, album: String) -> LibraryChoice {
        if !album.isBlank { return .album(album.trimmingCharacters(in: .whitespacesAndNewlines)) }
        if !artist.isBlank { return .artist(artist.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return .search(text)
    }

    /// «Suona e accoda i seguenti»: a tap starts THAT song and queues the ones that follow it in the same list (what comes
    /// before it is not queued). nil when the song is not in the list or cannot play (a «da cercare» row does nothing).
    public static func queue(
        choice: LibraryChoice, tracks: [OfflineTrack], tapped songKey: String, isLocal: (String) -> Bool
    ) -> PlayQueue? {
        guard let at = tracks.firstIndex(where: { $0.songKey == songKey }) else { return nil }
        return LibraryQueueBuilder.make(
            choice: choice, tracks: Array(tracks[at...]), startAt: songKey, shuffled: false, isLocal: isLocal
        )
    }

    /// «Riproduci» (in order) and «Casuale» (mixed): the whole list.
    public static func queue(
        choice: LibraryChoice, tracks: [OfflineTrack], shuffled: Bool, isLocal: (String) -> Bool
    ) -> PlayQueue? {
        LibraryQueueBuilder.make(choice: choice, tracks: tracks, startAt: nil, shuffled: shuffled, isLocal: isLocal)
    }
}

/// «Aggiungi in coda»: after the songs already queued. A song already in the queue stays where it is (the queue holds a song
/// once: its key is its identity), and one that cannot play is not queued.
public enum QueueAppend {
    public enum Outcome: Equatable, Sendable {
        case added(Int)
        /// The queue was empty: it is loaded and waits for «Riproduci» (the play is never automatic).
        case addedToEmptyQueue(Int)
        case alreadyQueued
        case notPlayable

        /// The line shown after the long press.
        public var message: String {
            switch self {
            case .added(let n): return n == 1 ? "Aggiunto in coda" : "Aggiunti in coda: \(n) brani"
            case .addedToEmptyQueue(let n):
                return n == 1 ? "Aggiunto in coda. Premi ▶ nel mini player" : "Aggiunti in coda: \(n) brani. Premi ▶ nel mini player"
            case .alreadyQueued: return "È già in coda"
            case .notPlayable: return "Non si può ascoltare: nessuna sorgente trovata"
            }
        }
    }

    public struct Result: Equatable, Sendable {
        public let queue: [QueueItem]
        public let outcome: Outcome

        public var added: Int {
            switch outcome {
            case .added(let n), .addedToEmptyQueue(let n): return n
            case .alreadyQueued, .notPlayable: return 0
            }
        }
    }

    public static func merge(existing: [QueueItem], adding tracks: [OfflineTrack], isLocal: (String) -> Bool) -> Result {
        var queue = existing
        var known = Set(existing.map(\.songKey))
        var added = 0
        var duplicates = 0
        var unplayable = 0
        for track in tracks {
            guard LibraryQueueBuilder.isPlayable(track, isLocal: isLocal(track.songKey)) else {
                unplayable += 1
                continue
            }
            guard known.insert(track.songKey).inserted else {
                duplicates += 1
                continue
            }
            queue.append(QueueItem(track: track))
            added += 1
        }
        if added > 0 { return Result(queue: queue, outcome: .added(added)) }
        return Result(queue: existing, outcome: duplicates > 0 ? .alreadyQueued : .notPlayable)
    }
}
