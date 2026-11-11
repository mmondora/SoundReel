// LibraryQueue.swift — the choice the user makes in «Libreria» becomes the play queue («In coda»).
//
// One playlist, one album, an artist, a tipo, a decade or a single song (spec 2026-11-08-player-selection-and-filters
// §X1). Pure: the same rule for every kind of choice, tested without a player.

import Foundation

public enum LibraryChoice: Equatable, Sendable {
    case playlist(id: String, name: String)
    case album(String)
    case artist(String)
    case genre(String)
    case decade(DecadeFilter)
    /// A single song (the queue is just that song).
    case song(title: String)
    /// Whatever the search box matched.
    case search(String)
    /// Every song downloaded on this phone.
    case onPhone
    case everything
    /// A row of songs the SERVER chose and named («Ascoltati di recente», «Nuovi dai tuoi reel» on the Home): the queue is called what the row is.
    case collection(String)

    /// The words shown as «In coda: …».
    public var label: String {
        switch self {
        case .playlist(_, let name): return "Playlist · \(name)"
        case .album(let name): return "Album · \(name)"
        case .artist(let name): return "Autore · \(name)"
        case .genre(let name): return "Tipo · \(name)"
        case .decade(let decade): return decade.label
        case .song(let title): return "Brano · \(title)"
        case .search(let text): return "Ricerca · «\(text.trimmingCharacters(in: .whitespacesAndNewlines))»"
        case .onPhone: return "Sul telefono"
        case .everything: return "Tutta la libreria"
        case .collection(let name): return name
        }
    }

    /// The library filters that select this choice (a playlist and a single song are not filters).
    public var filters: LibraryFilters {
        switch self {
        case .album(let name): return LibraryFilters(album: name)
        case .artist(let name): return LibraryFilters(artist: name)
        case .genre(let name): return LibraryFilters(genre: name)
        case .decade(let decade): return LibraryFilters(decade: decade)
        case .search(let text): return LibraryFilters(q: text)
        case .playlist, .song, .onPhone, .everything, .collection: return .none
        }
    }

    /// The playlist a listen is credited to (listening stats), nil for everything else.
    public var playlistId: String? {
        if case .playlist(let id, _) = self { return id }
        return nil
    }
}

/// What `LocalAudioPlayer.setQueue` needs.
public struct PlayQueue: Equatable, Sendable {
    public let items: [QueueItem]
    public let startIndex: Int
    public let label: String
    public let playlistId: String?
}

public enum LibraryQueueBuilder {
    /// A track the server found no source for cannot play unless it is already on the phone — same rule as the
    /// playlist screen. (A `failed` / `missing` one is asked again by the first-play logic.)
    public static func isPlayable(_ track: OfflineTrack, isLocal: Bool) -> Bool {
        track.resolvedState != .noSource || isLocal
    }

    /// The queue for `choice` over `tracks`, starting at `startAt` (a songKey) or at the first one.
    /// nil when nothing is playable, or when the song asked for is not (a «da cercare» row does nothing).
    /// `shuffled` mixes the order; the song asked for, if any, still plays first.
    /// `localFirst` («Vanno privilegiati i file già scaricati», Michele, 11 November; spec ...-simplify-playlists-and-song-states-design.md U10): the songs that are on the
    /// phone play before the ones that are only online, each group in the order it came in — or, with `shuffled`, each group mixed on its own, the phone's first.
    public static func make<G: RandomNumberGenerator>(
        choice: LibraryChoice,
        tracks: [OfflineTrack],
        startAt songKey: String? = nil,
        shuffled: Bool = false,
        localFirst: Bool = false,
        using generator: inout G,
        isLocal: (String) -> Bool
    ) -> PlayQueue? {
        var seen = Set<String>()
        var playable = tracks.filter { track in
            isPlayable(track, isLocal: isLocal(track.songKey)) && seen.insert(track.songKey).inserted
        }
        guard !playable.isEmpty else { return nil }
        if let songKey, !playable.contains(where: { $0.songKey == songKey }) { return nil }
        if shuffled {
            if localFirst {
                var onPhone = playable.filter { isLocal($0.songKey) }
                var online = playable.filter { !isLocal($0.songKey) }
                onPhone.shuffle(using: &generator)
                online.shuffle(using: &generator)
                playable = onPhone + online
            } else {
                playable.shuffle(using: &generator)
            }
            if let songKey, let at = playable.firstIndex(where: { $0.songKey == songKey }), at != 0 {
                playable.swapAt(0, at)
            }
        } else if localFirst {
            playable = LocalFirst.stable(playable) { isLocal($0.songKey) ? 0 : 1 }
        }
        let start = songKey.flatMap { key in playable.firstIndex(where: { $0.songKey == key }) } ?? 0
        return PlayQueue(
            items: playable.map { QueueItem(track: $0) },
            startIndex: start,
            label: choice.label,
            playlistId: choice.playlistId
        )
    }

    public static func make(
        choice: LibraryChoice,
        tracks: [OfflineTrack],
        startAt songKey: String? = nil,
        shuffled: Bool = false,
        localFirst: Bool = false,
        isLocal: (String) -> Bool
    ) -> PlayQueue? {
        var generator = SystemRandomNumberGenerator()
        return make(choice: choice, tracks: tracks, startAt: songKey, shuffled: shuffled, localFirst: localFirst, using: &generator, isLocal: isLocal)
    }
}
