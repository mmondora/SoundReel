// SyncSizeGuard.swift — the question asked BEFORE the first download of a big sync (Michele, 10 November: «Deve fare il sync. Se sono molti gb deve
// avvisare oppure limitare, da internet in Wi-Fi deve solo avvisare dei gb con la possibilità di annullare o limitare - oppure i max gb possono essere
// una configurazione»; and, trying build 15 on 11 November: «Il sync deve girare solo per playlist che sto suonando»: the sync is the one of the playlist
// that plays; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U2).
//
// Pure: the bytes of what is still to download and the limit the user set in the Settings go in, a decision comes out. The warning is the same
// wherever the phone is and it never blocks (rule P: the app does not tell where it is, and chooses no source).

import Foundation

/// «Avvisa sopra»: the size above which a sync asks before it starts (Impostazioni → Sync). Decimal gigabytes, like every size the app shows.
public enum SyncWarnLimit: Int, CaseIterable, Identifiable, Sendable {
    case gb1 = 1
    case gb2 = 2
    case gb5 = 5
    case gb10 = 10
    case gb20 = 20
    case gb50 = 50
    /// «Mai»: it never asks.
    case never = 0

    public var id: Int { rawValue }

    /// The limit a phone starts with.
    public static let `default`: SyncWarnLimit = .gb2

    /// What the Settings stored (nothing, an old build's value or a damaged one all give the starting limit).
    public init(stored: Int?) {
        if let stored, let limit = SyncWarnLimit(rawValue: stored) {
            self = limit
        } else {
            self = .default
        }
    }

    public var bytes: Int? { self == .never ? nil : rawValue * 1_000_000_000 }

    public var title: String { self == .never ? "Mai" : "\(rawValue) GB" }
}

/// «Da scaricare 3,4 GB (812 brani)»: what the question says.
public struct SyncSizeQuestion: Equatable, Sendable {
    /// Songs still to download.
    public let songs: Int
    /// Their size, as far as the manifests say.
    public let bytes: Int
    public let limit: SyncWarnLimit
    /// The playlist the question is about: it can come up over any screen.
    public let playlistName: String?

    public init(songs: Int, bytes: Int, limit: SyncWarnLimit, playlistName: String? = nil) {
        self.songs = songs
        self.bytes = bytes
        self.limit = limit
        self.playlistName = playlistName
    }

    public var limitBytes: Int { limit.bytes ?? 0 }

    public var title: String {
        "Da scaricare \(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)) (\(songs) \(songs == 1 ? "brano" : "brani"))"
    }

    public var message: String {
        let which = playlistName.map { "Playlist «\($0)». " } ?? ""
        return "\(which)Il limite che hai scelto è \(limit.title) (Impostazioni → Sync, «Avvisa sopra»). Con «Limita» scarico i brani nell'ordine della playlist fino a quel limite; gli altri restano online."
    }

    public var allButtonTitle: String { "Scarica tutto" }
    public var limitButtonTitle: String { "Limita a \(limit.title)" }
    public var cancelButtonTitle: String { "Annulla" }
}

public enum SyncSizeDecision: Equatable, Sendable {
    /// Nothing to download.
    case nothing
    /// Under the limit (or no limit set): it starts without asking.
    case proceed
    case ask(SyncSizeQuestion)
}

/// What the user answered.
public enum SyncSizeChoice: Equatable, Sendable {
    case all
    case limit
    case cancel
}

public enum SyncSizeGuard {
    /// `download` is what a sync WOULD download (`SyncEngine.plan(...).download`). A song whose size the manifest does not give weighs nothing here but
    /// is counted as a song. Exactly the limit is still under it.
    public static func decide(download: [OfflineTrack], limit: SyncWarnLimit, playlistName: String? = nil) -> SyncSizeDecision {
        guard !download.isEmpty else { return .nothing }
        guard let limitBytes = limit.bytes else { return .proceed }
        let total = download.reduce(0) { $0 + ($1.bytes ?? 0) }
        guard total > limitBytes else { return .proceed }
        return .ask(SyncSizeQuestion(songs: download.count, bytes: total, limit: limit, playlistName: playlistName))
    }

    /// «Limita»: the songs in the order they come (the order of the playlist), as many as fit under the limit. It stops at the
    /// first song that does not fit: the order is the promise, a small song further down never jumps the queue. A song of unknown size rides along.
    public static func limited(_ tracks: [OfflineTrack], limitBytes: Int) -> [OfflineTrack] {
        var used = 0
        var chosen: [OfflineTrack] = []
        for track in tracks {
            let size = track.bytes ?? 0
            guard used + size <= limitBytes else { break }
            used += size
            chosen.append(track)
        }
        return chosen
    }

    /// The songs to download after the answer.
    public static func apply(_ choice: SyncSizeChoice, to tracks: [OfflineTrack], limit: SyncWarnLimit) -> [OfflineTrack] {
        switch choice {
        case .all:
            return tracks
        case .cancel:
            return []
        case .limit:
            guard let limitBytes = limit.bytes else { return tracks }
            return limited(tracks, limitBytes: limitBytes)
        }
    }
}
