// PlaylistPicker.swift — «Aggiungi a playlist» (long press on a song of «Cerca»). The server decides who may edit what
// (docs/mondrop-sync.md "POST /api/mondrop/playlists/:id/songs"): only the user's OWN STATIC playlists take songs by
// hand (`canEdit`). The song may exist only as a file: a playlist holds song KEYS, not journal entries (ADR-0018).

import Foundation

/// `POST /api/mondrop/playlists/:id/songs` → `{ ok, playlist: { id, name, songs }, user }`
public struct PlaylistAddAck: Equatable, Sendable, Decodable {
    public let playlistId: String
    public let name: String
    /// How many songs the playlist has now.
    public let songs: Int

    public init(playlistId: String, name: String, songs: Int) {
        self.playlistId = playlistId
        self.name = name
        self.songs = songs
    }

    private enum CodingKeys: String, CodingKey { case playlist }
    private struct Playlist: Decodable {
        let id: String?
        let name: String?
        let songs: Int?
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let playlist = (try? c.decodeIfPresent(Playlist.self, forKey: .playlist)) ?? nil
        playlistId = playlist?.id ?? ""
        name = playlist?.name ?? ""
        songs = playlist?.songs ?? 0
    }
}

/// What the picker needs from the backend (a fake in tests).
public protocol PlaylistPickerTransport: Sendable {
    func listPlaylists() async throws -> [MondropPlaylist]
    func addSong(songKey: String, toPlaylist id: String) async throws -> PlaylistAddAck
}

extension MondropAPI: PlaylistPickerTransport {
    public func addSong(songKey: String, toPlaylist id: String) async throws -> PlaylistAddAck {
        struct Body: Encodable { let songKey: String }
        let body = try JSONEncoder().encode(Body(songKey: songKey))
        let path = "/api/mondrop/playlists/\(Self.encodeSongKey(id))/songs"
        let data = try await sendRequest(path: path, method: "POST", body: body, timeout: 30)
        // A 200 with a body we cannot read still means «added»: never ask again because of a decode problem.
        return (try? decodeBody(PlaylistAddAck.self, from: data)) ?? PlaylistAddAck(playlistId: id, name: "", songs: 0)
    }
}

@MainActor
public final class PlaylistPickerModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case loading
        case ready
        /// Adding to the playlist with this id.
        case adding(String)
        /// Done: the line to show, then the sheet closes.
        case added(String)
        case failed(String)
    }

    @Published public private(set) var playlists: [MondropPlaylist] = []
    @Published public private(set) var phase: Phase = .loading

    private let api: PlaylistPickerTransport
    private let songKey: String

    public init(api: PlaylistPickerTransport, songKey: String) {
        self.api = api
        self.songKey = songKey
    }

    /// The playlists that take songs by hand: the user's own static ones. An older backend does not say (`canEdit` nil):
    /// then none is offered — better no choice than one the server refuses.
    public func load() async {
        phase = .loading
        do {
            playlists = try await api.listPlaylists().filter { $0.canEdit == true }
            phase = .ready
        } catch {
            if Self.isCancellation(error) { return }
            playlists = []
            phase = .failed(Self.describe(error))
        }
    }

    /// true when the song is in the playlist now (also when it already was: the server answers the same).
    @discardableResult
    public func add(to playlist: MondropPlaylist) async -> Bool {
        phase = .adding(playlist.id)
        do {
            let ack = try await api.addSong(songKey: songKey, toPlaylist: playlist.id)
            let name = ack.name.isBlank ? playlist.name : ack.name
            phase = .added("Aggiunto a «\(name)»")
            return true
        } catch {
            if Self.isCancellation(error) { phase = .ready; return false }
            phase = .failed(Self.describe(error))
            return false
        }
    }

    static func isCancellation(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }

    /// The server's refusals in words a person can act on.
    static func describe(_ error: Error) -> String {
        switch error as? MondropAPIError {
        case .http(404, let body)?:
            if body?.contains("song not found") == true { return "Il server non conosce questo brano." }
            return "Questa playlist non è tua o non esiste più: aggiorna l'elenco."
        case .http(409, _)?:
            return "Questa playlist è dinamica: la decide una regola, non si aggiungono brani a mano."
        case .http(400, _)?:
            return "Il server non ha accettato la richiesta."
        default:
            return (error as? MondropAPIError)?.description ?? error.localizedDescription
        }
    }
}
