// PlaylistEntity.swift — a playlist as Siri knows it (spec 2026-11-10-mondrop-like-and-repeat-design.md L10). The names are the ones the app
// already keeps (`PlaylistCatalog`, fed wherever the app reads the whole list: dynamic and automatic playlists included); matching what was
// said to them is `PlaylistMatcher` (accents and case do not count, a part of the name is enough, two that fit equally are two answers and
// Siri asks which). The query is a STRING query: Siri passes it the spoken name.

import AppIntents

struct PlaylistEntity: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Playlist")
    static let defaultQuery = PlaylistEntityQuery()

    let id: String
    let name: String

    init(_ playlist: KnownPlaylist) {
        id = playlist.id
        name = playlist.name
    }

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct PlaylistEntityQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [PlaylistEntity] {
        let wanted = Set(identifiers)
        let known = await SiriPlaylists.known()
        return known.filter { wanted.contains($0.id) }.map(PlaylistEntity.init)
    }

    /// What Siri heard when it could not tell which playlist was meant: the best fits, one or several.
    func entities(matching string: String) async throws -> [PlaylistEntity] {
        let known = await SiriPlaylists.known()
        return PlaylistMatcher.candidates(for: string, in: known).map(PlaylistEntity.init)
    }

    /// Every playlist, so that Siri can learn their names.
    func suggestedEntities() async throws -> [PlaylistEntity] {
        let known = await SiriPlaylists.known()
        return known.sorted { $0.name.lowercased() < $1.name.lowercased() }.map(PlaylistEntity.init)
    }
}

/// Where the names come from: what the app kept at its last opening; and, if it has kept nothing yet, one question to SoundReel.
enum SiriPlaylists {
    static func known() async -> [KnownPlaylist] {
        let user = Settings.shared.autheliaUsername
        let kept = PlaylistCatalog.shared.playlists(forUser: user)
        if !kept.isEmpty { return kept }
        guard let all = try? await MondropAPI().listPlaylists() else { return [] }
        PlaylistCatalog.shared.remember(all, user: user)
        return PlaylistCatalog.shared.playlists(forUser: user)
    }
}
