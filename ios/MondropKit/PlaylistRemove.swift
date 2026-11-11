// PlaylistRemove.swift — «Togli dalla playlist»: the swipe on a song inside a playlist (Michele, 10 November: «il remove è in swipe sulla playlist»; spec
// 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U7). The call is `DELETE /api/mondrop/playlists/:id/songs/:songKey` (SoundReel 2.25.0, like
// the add-song call: idempotent, only the user's own static playlists); the page of the playlist takes the song away at once and puts it back if the server
// says no. Nothing is deleted from the phone by this: it only takes the song out of the list.

import Foundation

/// The playlist as it is now: the same shape the add-song call answers.
public typealias PlaylistRemoveAck = PlaylistAddAck

/// What the page of a playlist needs from the backend to take a song out (a fake in tests).
public protocol PlaylistSongRemoving: Sendable {
    func removeSong(songKey: String, fromPlaylist id: String) async throws -> PlaylistRemoveAck
}

extension MondropAPI: PlaylistSongRemoving {
    public func removeSong(songKey: String, fromPlaylist id: String) async throws -> PlaylistRemoveAck {
        let path = "/api/mondrop/playlists/\(Self.encodeSongKey(id))/songs/\(Self.encodeSongKey(songKey))"
        let data = try await sendRequest(path: path, method: "DELETE", body: nil, timeout: 30)
        // A 200 with a body we cannot read still means «removed»: never put the song back because of a decode problem.
        return (try? decodeBody(PlaylistRemoveAck.self, from: data)) ?? PlaylistRemoveAck(playlistId: id, name: "", songs: 0)
    }
}

/// Which rows of a playlist offer what. Pure, so a rule that decides who may take songs out is tested and not only drawn.
public enum PlaylistRowActions {
    /// The swipe «Togli dalla playlist»: only the user's own STATIC playlists (the server says so with `canEdit`; an older one does not, and then none is
    /// offered: better no choice than a refused one). Never a dynamic one, never an automatic one (the rule makes those), never one shared with the user.
    public static func canRemoveSongs(from playlist: MondropPlaylist, dynamicManifest: Bool) -> Bool {
        playlist.canEdit == true && !playlist.isDynamic && !dynamicManifest && !playlist.isAuto
    }
}

public enum PlaylistRemoveOutcome: Equatable, Sendable {
    /// Done: the line to show.
    case removed(String)
    /// The server does not have the route yet (it is older than 2.25.0): quiet, and the song stays.
    case unavailable
    /// Refused or failed: the words, and the song is back.
    case failed(String)

    public var message: String {
        switch self {
        case .removed(let words): return words
        case .unavailable: return "Non disponibile con questo server"
        case .failed(let words): return words
        }
    }

    /// The server's answers in words a person can act on. A 404 that names the playlist is the new route saying «not yours»; any other 404, and a 405, is
    /// a server that has no such route.
    static func refused(_ error: Error) -> PlaylistRemoveOutcome {
        switch error as? MondropAPIError {
        case .http(404, let body)?:
            if body?.contains("playlist not found") == true {
                return .failed("Questa playlist non è tua o non esiste più: aggiorna l'elenco.")
            }
            return .unavailable
        case .http(405, _)?:
            return .unavailable
        case .http(409, _)?:
            return .failed("Questa playlist è dinamica: la decide una regola, non si tolgono brani a mano.")
        default:
            return .failed((error as? MondropAPIError)?.description ?? error.localizedDescription)
        }
    }
}
