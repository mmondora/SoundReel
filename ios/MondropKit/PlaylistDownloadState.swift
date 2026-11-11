// PlaylistDownloadState.swift — what the «Scarica tutta» of a playlist page shows and whether it is there (Michele, 11 November, after build 18: «Inoltre su una playlist voglio
// anche il bottone 'scarica tutta'»; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md §12, U20).
//
// Pure: the songs of the playlist and what the phone knows about them go in, the state of the button comes out. The songs that COULD come to the phone are the ones that are not
// on it, were not taken off it on purpose and are not stuck (a song SoundReel could not find a source for, or failed on, has its own «Riprova» and «Link» on the row).

import Foundation

public struct PlaylistDownloadState: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// Nothing to bring (the playlist is on the phone, or what is missing cannot come): no button.
        case none
        /// `songs` songs could come; `bytes` is what SoundReel said of the ones it has ready (0 when it said nothing).
        case available(songs: Int, bytes: Int)
        /// A sync of this playlist is at work: `left` songs are not on the phone yet.
        case working(left: Int)
    }

    public let kind: Kind

    public init(kind: Kind) { self.kind = kind }

    public static func make(
        tracks: [OfflineTrack],
        isLocal: (String) -> Bool,
        isSkipped: (String) -> Bool,
        progress: (String) -> TrackProgress?,
        busy: Bool
    ) -> PlaylistDownloadState {
        var seen = Set<String>()
        var wanted = 0
        var bytes = 0
        var onTheWay = 0
        for track in tracks where seen.insert(track.songKey).inserted {
            guard !isLocal(track.songKey), !isSkipped(track.songKey) else { continue }
            switch track.resolvedState {
            case .failed, .noSource: continue                       // stuck: «Riprova» and «Link» are on its row
            case .ready: bytes += track.bytes ?? 0
            case .preparing, .missing: break                        // SoundReel is asked to prepare it, and it comes when it is ready
            }
            wanted += 1
            switch progress(track.songKey) {
            case .queued?, .downloading?: onTheWay += 1
            default: break
            }
        }
        guard wanted > 0 else { return PlaylistDownloadState(kind: .none) }
        if busy || onTheWay > 0 { return PlaylistDownloadState(kind: .working(left: wanted)) }
        return PlaylistDownloadState(kind: .available(songs: wanted, bytes: bytes))
    }

    /// The words on the button: «Scarica tutta», or «Scarico…» while it is at work.
    public var title: String {
        switch kind {
        case .none: return ""
        case .available: return "Scarica tutta"
        case .working: return "Scarico…"
        }
    }

    /// The line under it: «5 brani · 420 MB», or «ancora 3 brani».
    public var detail: String? {
        switch kind {
        case .none:
            return nil
        case .available(let songs, let bytes):
            let count = "\(songs) \(songs == 1 ? "brano" : "brani")"
            guard bytes > 0 else { return count }
            return "\(count) · \(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))"
        case .working(let left):
            return "ancora \(left) \(left == 1 ? "brano" : "brani")"
        }
    }
}
