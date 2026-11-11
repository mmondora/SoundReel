// SongState.swift — the three marks a song and a playlist show: on the phone, online, in error (Michele, 10 November: «Dentro ogni playlist
// le canzoni devono avere uno stato ( online, errore, locale )», «Anche la playlist deve avere un simbolo/icona che dice online/errore/locale»;
// spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U3, U4, U9).
//
// Pure: the eight marks of `TrackRowStatus` fold into three, and a playlist gets ONE of the three from its songs. The views only draw them.

import Foundation

/// What one song shows inside a playlist.
public enum SongState: Equatable, Sendable {
    /// The file is on the phone.
    case local
    /// Not on the phone but played from SoundReel; `percent` while the phone is downloading it. A song the server has not prepared yet, or one whose
    /// source was not found or does not resolve, is ONLINE too: nothing is an error by itself, SoundReel decides where a song comes from (rule P).
    case online(percent: Int?)
    /// A real attempt failed (the download on the phone, or the preparation on the server); the words say which.
    case error(String)

    public init(_ status: TrackRowStatus) {
        switch status.kind {
        case .local:
            self = .local
        case .failed:
            self = .error(status.label)
        case .downloading:
            self = .online(percent: status.percent)
        case .queued, .preparing, .readyOnServer, .removedFromPhone, .noSource, .missing:
            self = .online(percent: nil)
        }
    }

    public var isLocal: Bool { self == .local }

    public var isError: Bool {
        if case .error = self { return true }
        return false
    }

    /// What VoiceOver says.
    public var accessibilityLabel: String {
        switch self {
        case .local: return "Sul telefono"
        case .online(let percent?): return "Online, scarico \(percent) %"
        case .online(nil): return "Online"
        case .error: return "Errore"
        }
    }

    /// The line under the title.
    public var rowText: String {
        switch self {
        case .local: return "sul telefono"
        case .online(let percent?): return "online · scarico \(percent) %"
        case .online(nil): return "online"
        case .error(let words): return words
        }
    }
}

/// The ONE mark of a playlist, from its songs: error if at least one song is in error; otherwise on the phone if EVERY song is; otherwise online
/// (also when some songs are already on the phone). A playlist with no songs has no mark.
public enum PlaylistState: Equatable, Sendable {
    case local
    case online
    case error

    public var accessibilityLabel: String {
        switch self {
        case .local: return "Sul telefono"
        case .online: return "Online"
        case .error: return "Errore"
        }
    }

    public static func make(songs: [SongState]) -> PlaylistState? {
        guard !songs.isEmpty else { return nil }
        if songs.contains(where: { $0.isError }) { return .error }
        if songs.allSatisfy({ $0.isLocal }) { return .local }
        return .online
    }

    /// For the cards of the Home and the rows of the full list, which only know a playlist by the keys of its songs: what the phone saw the last time
    /// it read it (`record`), the files it holds (`local`) and the downloads that failed on it (`failedOnPhone`). A playlist the app has not read yet
    /// is online if the server says it has songs, and has no mark if it has none.
    public static func make(songCount: Int, record: OfflineStore.PlaylistRecord?, local: Set<String>, failedOnPhone: Set<String>) -> PlaylistState? {
        guard let record else { return songCount > 0 ? .online : nil }
        let states = record.songKeys.map { key -> SongState in
            if record.failedKeys.contains(key) || failedOnPhone.contains(key) { return .error("errore") }
            return local.contains(key) ? .local : .online(percent: nil)
        }
        return make(songs: states)
    }
}

/// «12 di 20 sul telefono» at the top of the page of a playlist, and the mark beside it.
public struct PlaylistStateSummary: Equatable, Sendable {
    public let state: PlaylistState?
    public let localCount: Int
    public let total: Int

    public init(songs: [SongState]) {
        state = PlaylistState.make(songs: songs)
        localCount = songs.filter { $0.isLocal }.count
        total = songs.count
    }

    /// nil for an empty playlist: there is nothing to say.
    public var headerText: String? {
        total > 0 ? "\(localCount) di \(total) sul telefono" : nil
    }
}

/// What a list of playlists needs to draw the mark of each one, read once per drawing: what the phone saw of every playlist, the files it holds and the
/// downloads that failed on it.
public struct PlaylistMarks: Equatable, Sendable {
    public let records: [String: OfflineStore.PlaylistRecord]
    public let local: Set<String>
    public let failedOnPhone: Set<String>

    public init(records: [String: OfflineStore.PlaylistRecord], local: Set<String>, failedOnPhone: Set<String>) {
        self.records = records
        self.local = local
        self.failedOnPhone = failedOnPhone
    }

    /// The mark of the playlist with this id (and this many songs according to the list the server sent).
    public func state(id: String, songCount: Int) -> PlaylistState? {
        PlaylistState.make(songCount: songCount, record: records[id], local: local, failedOnPhone: failedOnPhone)
    }

    /// From the phone as it is now.
    @MainActor
    public static func current(store: OfflineStore, progress: [String: TrackProgress]) -> PlaylistMarks {
        current(store: store, local: store.localSongKeys(), progress: progress)
    }

    /// The same, for a screen that already keeps the keys of the files on the phone (reading them is a look at every file: not at every tick of a download).
    @MainActor
    public static func current(store: OfflineStore, local: Set<String>, progress: [String: TrackProgress]) -> PlaylistMarks {
        PlaylistMarks(
            records: store.playlistRecords(),
            local: local,
            failedOnPhone: Set(progress.compactMap { key, value -> String? in
                if case .failed = value { return key }
                return nil
            })
        )
    }
}
