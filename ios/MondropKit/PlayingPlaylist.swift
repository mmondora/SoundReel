// PlayingPlaylist.swift — which playlist the sync looks at: the one that is PLAYING (Michele, 11 November, trying build 15: «Il sync deve girare solo per
// playlist che sto suonando. Non di tutti in assoluto.»; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U2).
//
// Pure: what the player is doing goes in, what the sync has to do comes out. Nothing here touches the player, the server or the phone.
//
// «Playing» is read from the player as it is: a song is really playing (`isPlaying`) in a queue that was STARTED from a playlist (`playlistId`). A queue that is
// only loaded — the one a relaunch brings back, paused, on the song the user was on — is not playing: nothing is synced until the user presses play. A queue that
// came from anything else (a song found in Cerca, a choice of the library, the songs of the phone) has no playlist, and no playlist is synced for it.

import Foundation

/// What the player is doing, as far as the sync is concerned.
public struct PlaybackContext: Equatable, Sendable {
    /// A song is really playing. The player says «not playing» for an instant between two songs, and while it is paused or only loaded.
    public var isPlaying: Bool
    /// The playlist the queue was started from (`LocalAudioPlayer.queuePlaylistId`); nil for every other queue.
    public var playlistId: String?

    public init(isPlaying: Bool, playlistId: String?) {
        self.isPlaying = isPlaying
        self.playlistId = playlistId
    }
}

/// What the sync has to do about it.
public enum PlaylistSyncAction: Equatable, Sendable {
    /// This playlist has begun to play: prepare it and download what is missing from the phone.
    case sync(String)
    /// The queue went on to something else: whatever the sync of this playlist is waiting for (a reading, the answer to a question) stops.
    case leave(String)
}

/// The rule that turns what the player says into `PlaylistSyncAction`s. It asks for a playlist ONCE for as long as the queue stays on it: the pauses between
/// songs, pausing and playing again, or starting another song of the same playlist ask for nothing new; going to another playlist or to a queue that is
/// not a playlist (Cerca) ends it, and coming back to the playlist asks again.
public struct PlaylistSyncTrigger: Equatable, Sendable {
    /// The playlist of the queue, as last seen.
    private var queuePlaylist: String?
    /// The sync of `queuePlaylist` has been asked for.
    private var fired = false

    public init() {}

    public mutating func observe(_ context: PlaybackContext) -> [PlaylistSyncAction] {
        var actions: [PlaylistSyncAction] = []
        let playlist = Self.clean(context.playlistId)
        if playlist != queuePlaylist {
            if let old = queuePlaylist, fired { actions.append(.leave(old)) }
            queuePlaylist = playlist
            fired = false
        }
        if context.isPlaying, let playlist, !fired {
            fired = true
            actions.append(.sync(playlist))
        }
        return actions
    }

    /// The sync of `id` did not get through (offline, the server answered with an error). If `id` is still the queue, the next change the player reports
    /// asks for it again — the next song, not right away — instead of waiting for the user to leave the playlist and come back.
    public mutating func rearm(_ id: String) {
        if queuePlaylist == id { fired = false }
    }

    private static func clean(_ id: String?) -> String? {
        guard let trimmed = id?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }
}
