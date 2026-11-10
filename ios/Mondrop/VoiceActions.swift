// VoiceActions.swift — where the App Intents meet the app (spec 2026-11-10-mondrop-like-and-repeat-design.md L9, L10). Everything the voice
// starts goes through the code the screens use: the same queue builders, the same search, the same entry point of the player. An intent of the
// app target runs in the app's own process (the one that plays in the car): a second copy of the player, the likes or the search would be a
// second state, so there is none.

import Foundation

@MainActor
enum VoiceActions {
    /// The like and the loop: does what the voice asked on THE player and THE likes of the app, and returns what Siri says.
    static func run(_ command: VoiceCommand, on player: LocalAudioPlayer = .shared) -> String {
        player.perform(voice: command).spoken
    }

    /// «Metti la playlist X»: the playlist as the queue, built by the rule of the playlist screen (a song the server found no source for is left
    /// out unless it is already on the phone) and started by the player's own entry point, like a tap on it. The first play of every song is the
    /// player's: the file on the phone first, else SoundReel. `start` is for the tests.
    static func playPlaylist(
        id: String, name: String, api: MondropAPIProtocol = MondropAPI(), store: OfflineStore = .shared,
        player: LocalAudioPlayer = .shared, start: ((PlayQueue) -> Void)? = nil
    ) async -> String {
        player.recordCommand(named: VoicePlayRequest.playlist(name).logName)
        let manifest: OfflineManifest
        do {
            manifest = try await api.offlineManifest(playlistId: id)
        } catch {
            return VoicePlayOutcome.playlistUnreachable(name: name).spoken
        }
        guard let queue = LibraryQueueBuilder.make(
            choice: .playlist(id: id, name: name), tracks: manifest.tracks, isLocal: { store.fileURL(songKey: $0) != nil }
        ) else { return VoicePlayOutcome.playlistEmpty(name: name).spoken }
        (start ?? { player.start($0) })(queue)
        return VoicePlayOutcome.playlistStarted(name: name).spoken
    }

    /// «Metti un brano»: what the person answered is searched like the box of Cerca searches (the model of Cerca: SoundReel's search, and the
    /// songs on the phone when the server cannot be reached), and the best match starts with the songs that follow it in the list, like a tap
    /// on it. A match that cannot play (no source, not on the phone) is skipped for the next one. `start` is for the tests.
    static func playSong(
        spoken: String, transport: SearchTransport = MondropAPI(), store: OfflineStore = .shared,
        player: LocalAudioPlayer = .shared, start: ((PlayQueue) -> Void)? = nil
    ) async -> String {
        let words = spoken.trimmingCharacters(in: .whitespacesAndNewlines)
        player.recordCommand(named: VoicePlayRequest.song(words).logName)
        guard !words.isEmpty else { return VoicePlayOutcome.nothingAsked.spoken }
        let model = SearchModel(api: transport, store: store, text: words)
        await model.reload()
        let local = store.localSongKeys()
        let choice = SearchPlayback.choice(text: words, artist: "", album: "")
        for track in model.tracks {
            guard let queue = SearchPlayback.queue(choice: choice, tracks: model.tracks, tapped: track.songKey, isLocal: { local.contains($0) }) else { continue }
            (start ?? { player.start($0) })(queue)
            return VoicePlayOutcome.songStarted(title: track.title, artist: track.artist).spoken
        }
        return VoicePlayOutcome.songNotFound.spoken
    }
}
