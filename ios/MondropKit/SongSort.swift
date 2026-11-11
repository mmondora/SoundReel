// SongSort.swift — the songs of a playlist in the order the person asks for (Michele, 11 November, after build 18: «Voglio in tutte le playlist anche degli ordinamenti
// tipo : data di creazione, nome, stato ( locali o online )»; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md §12, U18).
//
// Pure: the songs of a playlist go in, the same songs come out in the chosen order. «Stato» is the phone's own knowledge (which files it holds: the same partition as
// `LocalFirst`, now a choice); «Ordine della playlist» is what SoundReel sent; «Nome» is the title; «Data di aggiunta» is when the song was put in the playlist (SoundReel
// 2.26.0 sends it: `OfflineTrack.addedAt`). Nothing is dropped or repeated.

import Foundation

public enum SongSort: String, CaseIterable, Identifiable, Sendable {
    case state, playlist, name, added

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .state: return "Stato (sul telefono / online)"
        case .playlist: return "Ordine della playlist"
        case .name: return "Nome"
        case .added: return "Data di aggiunta"
        }
    }

    /// On the phone first, as the playlist is, A to Z; the newest first for the date.
    public var naturalOrder: PlaylistOrder { self == .added ? .desc : .asc }

    /// What the two directions mean for this sort, in words.
    public func orderTitle(_ order: PlaylistOrder) -> String {
        switch (self, order) {
        case (.state, .asc): return "Sul telefono prima"
        case (.state, .desc): return "Online prima"
        case (.playlist, .asc): return "Come nella playlist"
        case (.playlist, .desc): return "Dall'ultimo al primo"
        case (.name, .asc): return "Da A a Z"
        case (.name, .desc): return "Da Z a A"
        case (.added, .desc): return "Più recenti prima"
        case (.added, .asc): return "Più vecchie prima"
        }
    }

    /// The sorts this playlist can be shown in: «Data di aggiunta» only when SoundReel said when at least one song was added (an older server, or a dynamic playlist, says nothing).
    public static func available(for tracks: [OfflineTrack]) -> [SongSort] {
        tracks.contains { $0.addedDate != nil } ? allCases : allCases.filter { $0 != .added }
    }

    /// `tracks` in the order of `sort`; `state` says what each row would show (on the phone, online, error).
    public static func sorted(_ tracks: [OfflineTrack], by sort: SongSort, order: PlaylistOrder, state: (OfflineTrack) -> SongState) -> [OfflineTrack] {
        switch sort {
        case .playlist:
            return order == .asc ? tracks : Array(tracks.reversed())
        case .state:
            // the partition of `LocalFirst`: on the phone, online, error — or, the other way, online first; an error is last either way, it is not a place to be in
            return LocalFirst.stable(tracks) { track in
                let rank = LocalFirst.rank(state(track))
                guard order == .desc else { return rank }
                return rank == 2 ? 2 : 1 - rank
            }
        case .name:
            // by title, the way a person reads it (no case, no accents, 2 before 10), then by artist, then as the playlist has them; the other direction is the exact reverse
            let ascending = tracks.enumerated().sorted { left, right in
                let byTitle = left.element.title.localizedStandardCompare(right.element.title)
                if byTitle != .orderedSame { return byTitle == .orderedAscending }
                let byArtist = left.element.artist.localizedStandardCompare(right.element.artist)
                if byArtist != .orderedSame { return byArtist == .orderedAscending }
                return left.offset < right.offset
            }.map(\.element)
            return order == .asc ? ascending : Array(ascending.reversed())
        case .added:
            // the dated songs by date, the undated ones after them in the order of the playlist in both directions; two songs added together keep the order of the playlist
            let dated = tracks.enumerated().compactMap { offset, track in track.addedDate.map { (offset: offset, track: track, date: $0) } }
            let undated = tracks.filter { $0.addedDate == nil }
            let ordered = dated.sorted { left, right in
                if left.date != right.date { return order == .desc ? left.date > right.date : left.date < right.date }
                return left.offset < right.offset
            }.map(\.track)
            return ordered + undated
        }
    }
}
