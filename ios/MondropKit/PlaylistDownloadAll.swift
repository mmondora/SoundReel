// PlaylistDownloadAll.swift — the «Scarica tutta» of the page of a playlist (Michele, 11 November, after build 18: «Inoltre su una playlist voglio anche il bottone 'scarica tutta'»;
// spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md §12, U20).
//
// The sync is automatic and quiet for the playlist that plays (U2, U12), and the Settings have the check of every playlist the phone holds (U15). This is the third way, the one
// the person asks for on a playlist: the same sync as always — SoundReel is asked to prepare the playlist, what is missing from the phone is queued, the songs the server is still
// preparing come as they turn ready — with the question over the limit of the Settings («Da scaricare 3,4 GB»: Scarica tutto, Limita, Annulla), announced when it ends because the
// person asked for it (`DownloadOrigin.sync`: «Sync finito» with the app closed). What the person took off the phone on purpose stays off (it has «Riscarica» on its row).

import Foundation

@MainActor
public final class PlaylistDownloadAll: ObservableObject {
    /// A download of this playlist is going: the button says so and does nothing more.
    @Published public private(set) var working = false
    /// Why the last one did not go (SoundReel did not answer…); nil after one that did.
    @Published public private(set) var errorText: String?

    private let playlist: MondropPlaylist
    private let api: MondropAPIProtocol
    private let engine: SyncEngine
    private let limit: () -> SyncWarnLimit
    private let questions: SizeQuestionPresenter
    private let clock: PreparationClock
    private let pollInterval: TimeInterval
    private let pollTimeout: TimeInterval
    private let activity: SyncActivity?
    private let onSyncStarted: @MainActor () -> Void
    private let cache: PlaylistManifestCaching?
    private let onFinished: @MainActor () async -> Void
    private var task: Task<Void, Never>?

    public init(
        playlist: MondropPlaylist,
        api: MondropAPIProtocol,
        engine: SyncEngine,
        limit: @escaping () -> SyncWarnLimit,
        questions: SizeQuestionPresenter,
        clock: PreparationClock = .real,
        pollInterval: TimeInterval = 5,
        pollTimeout: TimeInterval = 600,
        activity: SyncActivity? = nil,
        onSyncStarted: @escaping @MainActor () -> Void = {},
        cache: PlaylistManifestCaching? = nil,
        onFinished: @escaping @MainActor () async -> Void = {}
    ) {
        self.playlist = playlist
        self.api = api
        self.engine = engine
        self.limit = limit
        self.questions = questions
        self.clock = clock
        self.pollInterval = pollInterval
        self.pollTimeout = pollTimeout
        self.activity = activity
        self.onSyncStarted = onSyncStarted
        self.cache = cache
        self.onFinished = onFinished
    }

    /// The button. Does nothing while a download of this playlist is already going. The gate is new every time — the question over the limit, and what the person answers to it,
    /// belong to THIS press: an «Annulla» is not remembered for the next one.
    public func start() {
        guard !working else { return }
        working = true
        errorText = nil
        task = Task { [self] in
            let gate = PlayingSyncGate(
                playlistId: playlist.id, limit: limit, declines: SyncDeclines(),
                ask: { [questions] question in await questions.ask(question) }
            )
            let sync = PlaylistSyncCoordinator(
                playlist: playlist, api: api, engine: engine, clock: clock, pollInterval: pollInterval, pollTimeout: pollTimeout,
                activity: activity, onSyncStarted: onSyncStarted, gate: gate, cache: cache, origin: .sync
            )
            await sync.sync()
            errorText = sync.errorText
            working = false
            task = nil
            await onFinished()
        }
    }

    /// Waits for the download that is going (the tests).
    func settled() async {
        await task?.value
    }
}
