// LocalFirst.swift — what is on the phone comes first (Michele, 11 November, trying build 16: «Su Mondrop le playlist e i brani devono essere in ordine di scaricati in
// locale e poi online. […] Vanno privilegiati i file già scaricati.»; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U10).
//
// Pure: the songs of a list, or the playlists of a list, go in; the same ones come out with the ones on the phone first, then the online ones, then (for songs) the
// ones in error. Nothing is dropped and nothing is sorted by name or by date: inside each group the order is the one the server gave. What is on the phone is the
// phone's own knowledge — the server cannot know which files this phone holds — so this is the one place where a list is reordered by the client (rule P stays:
// where a file COMES FROM is still the server's business, and nothing here looks at the network).

import Foundation

public enum LocalFirst {
    /// A STABLE partition: lower ranks first, and the items of the same rank keep the order they came in.
    public static func stable<T>(_ items: [T], rank: (T) -> Int) -> [T] {
        let ranks = items.map(rank)
        return items.indices.sorted { (ranks[$0], $0) < (ranks[$1], $1) }.map { items[$0] }
    }

    // MARK: songs

    /// 0 on the phone, 1 online (a download in progress is still online: the file is not there yet), 2 error.
    public static func rank(_ state: SongState) -> Int {
        switch state {
        case .local: return 0
        case .online: return 1
        case .error: return 2
        }
    }

    /// The songs of a list, the ones on the phone first. `state` is what the row would show for the song.
    public static func songs(_ tracks: [OfflineTrack], state: (OfflineTrack) -> SongState) -> [OfflineTrack] {
        stable(tracks) { rank(state($0)) }
    }

    // MARK: playlists

    /// 0 every song of the playlist is on the phone, 1 some of them, 2 none (it is online), 3 it has no songs. A playlist the phone has not read yet (`record` nil)
    /// is online if the server says it has songs. An error on one song does not move a playlist: what counts is how much of it is on the phone.
    public static func rank(songCount: Int, record: OfflineStore.PlaylistRecord?, local: Set<String>) -> Int {
        guard let record else { return songCount > 0 ? 2 : 3 }
        guard !record.songKeys.isEmpty else { return 3 }
        let onPhone = record.songKeys.filter { local.contains($0) }.count
        if onPhone == record.songKeys.count { return 0 }
        return onPhone > 0 ? 1 : 2
    }
}

extension PlaylistMarks {
    /// The playlists of a list (the Home's row, the whole list, «Sfoglia»), the ones on the phone first. `songCount` is what the server said of each.
    public func ordered<P>(_ playlists: [P], id: (P) -> String, songCount: (P) -> Int) -> [P] {
        LocalFirst.stable(playlists) { LocalFirst.rank(songCount: songCount($0), record: records[id($0)], local: local) }
    }
}
