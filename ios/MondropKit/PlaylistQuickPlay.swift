// PlaylistQuickPlay.swift — the play on the card of a playlist (Michele, 12 November: «in mondrop voglio avere il bottone play, in homepage, direttamente sulla play list, in un angolo -
// oppure con una gesture»; spec 2026-11-12-mondrop-home-play-loop-reels-design.md M1).
//
// From a playlist the first page shows to the queue that plays, without opening the page of the playlist: the queue is built the way «Suona» builds it on that page — the songs that are on
// the phone first, then the online ones (`SongSort.state`), the playlist's own order inside each group; «Mescola» mixes each group on its own, the phone's first — from the list the phone
// kept (`PlaylistManifestCache`) or, when it has none (or none of its songs can play), from SoundReel. «Suona in loop» puts the loop on the whole queue before it starts; the other two leave
// the loop the person chose alone.
//
// It only builds the queue and starts it. It does not prepare the playlist and it queues no download: the sync of the playlist that plays starts by itself, as always (U2).

import Foundation

/// What starts a queue (the player; a fake in tests).
@MainActor
public protocol QueuePlaying: AnyObject {
    func start(_ queue: PlayQueue)
    func setRepeatMode(_ mode: RepeatMode)
}

extension LocalAudioPlayer: QueuePlaying {}

@MainActor
public final class PlaylistQuickPlay: ObservableObject {
    public enum Outcome: Equatable, Sendable {
        /// The queue is playing.
        case started
        /// The same playlist is already being read: this tap does nothing.
        case busy
        /// The playlist has no song that can play.
        case nothingToPlay
        /// The phone has no list of it and SoundReel did not answer.
        case unreadable

        /// The line shown at the bottom when it did not start; nil when it did.
        public func message(playlistName: String) -> String? {
            switch self {
            case .started, .busy: return nil
            case .nothingToPlay: return "Niente da suonare in «\(playlistName)»."
            case .unreadable: return "Non riesco a leggere la playlist."
            }
        }
    }

    /// The playlist whose list is being read: its button shows a spinner.
    @Published public private(set) var loadingId: String?

    private let api: MondropAPIProtocol
    private let cache: PlaylistManifestCaching
    private let player: QueuePlaying
    private let isLocal: (String) -> Bool
    private let state: (OfflineTrack) -> SongState

    /// `isLocal` and `state` say what the phone holds and how each song stands (the same words as the page of the playlist): the app gives them from the store and the engine.
    public init(
        api: MondropAPIProtocol,
        cache: PlaylistManifestCaching,
        player: QueuePlaying,
        isLocal: @escaping (String) -> Bool,
        state: @escaping (OfflineTrack) -> SongState
    ) {
        self.api = api
        self.cache = cache
        self.player = player
        self.isLocal = isLocal
        self.state = state
    }

    @discardableResult
    public func play(playlistId: String, name: String, shuffled: Bool = false, loop: Bool = false) async -> Outcome {
        guard loadingId != playlistId else { return .busy }
        loadingId = playlistId
        defer { loadingId = nil }

        // the list the phone kept answers at once (and offline); if nothing in it can play, or there is none, SoundReel is asked
        let kept = cache.load(playlistId: playlistId)
        if let kept, let queue = queue(for: kept, name: name, shuffled: shuffled) {
            begin(queue, loop: loop)
            return .started
        }
        do {
            let fresh = try await api.offlineManifest(playlistId: playlistId)
            cache.save(fresh)
            guard let queue = queue(for: fresh, name: name, shuffled: shuffled) else { return .nothingToPlay }
            begin(queue, loop: loop)
            return .started
        } catch {
            return kept == nil ? .unreadable : .nothingToPlay
        }
    }

    private func queue(for manifest: OfflineManifest, name: String, shuffled: Bool) -> PlayQueue? {
        let arranged = SongSort.sorted(manifest.tracks, by: .state, order: SongSort.state.naturalOrder, state: state)
        return LibraryQueueBuilder.make(
            choice: .playlist(id: manifest.playlistId, name: name),
            tracks: arranged,
            startAt: nil,
            shuffled: shuffled,
            localFirst: shuffled,
            isLocal: isLocal
        )
    }

    private func begin(_ queue: PlayQueue, loop: Bool) {
        if loop { player.setRepeatMode(.all) }
        player.start(queue)
    }
}
