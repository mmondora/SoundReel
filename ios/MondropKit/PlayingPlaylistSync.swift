// PlayingPlaylistSync.swift — the sync of the playlist that is PLAYING (Michele, 10 November: «Deve fare il sync. Se sono molti gb deve avvisare oppure
// limitare», then, trying build 15 on 11 November: «Il sync deve girare solo per playlist che sto suonando. Non di tutti in assoluto.»; spec
// 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U2).
//
// When a queue starts from a playlist, or the queue that plays goes on to another playlist, SoundReel is asked to prepare THAT playlist and the songs that are
// missing from the phone are downloaded in the background while it plays: the ones not on the phone yet play online and become «sul telefono» as they land.
// It is the sync of a playlist as the «Sync» inside the playlist does it (`PlaylistSyncCoordinator`: prepare, queue, keep reading while the server prepares),
// plus a gate before the downloads: if the missing songs are more than the limit of the Settings the user is asked — «Da scaricare N GB (M brani)»: Scarica
// tutto, Limita a X GB, Annulla — and the answer holds for that playlist. «Annulla» is remembered until the app is opened again.
//
// Nothing is downloaded for a playlist that does not play, nor for a queue that did not start from a playlist. The warning is the same wherever the phone is
// and it never blocks (rule P: the app does not tell where it is and chooses no source); the download itself keeps the rules of the engine (cellular off).
//
// The decisions are pure or injected (`PlaylistSyncTrigger`, `SyncSizeGuard`, the clock, the api, the limit): the tests drive them with fakes.

import Foundation

/// The playlists the user said «Annulla» to, for as long as this object lives. The app keeps one for the whole run: opening the app again asks again.
@MainActor
public final class SyncDeclines {
    private var declined = Set<String>()

    /// Nonisolated: it is the default of an argument, which is evaluated where the call is made.
    public nonisolated init() {}

    public func decline(_ playlistId: String) { declined.insert(playlistId) }

    public func isDeclined(_ playlistId: String) -> Bool { declined.contains(playlistId) }
}

/// The gate of ONE sync of a playlist: which of the songs it wants may be downloaded. Under the limit everything goes without a word; over it the user is asked,
/// once, and what was answered holds for the rest of that sync (the songs that turn ready later):
/// «Scarica tutto» → everything, «Limita» → the first songs of the playlist up to the limit and nothing more, «Annulla» → nothing, and the playlist is
/// remembered as declined. A question that was withdrawn (the user went on to another playlist) says nothing about the playlist and is not remembered.
@MainActor
public final class PlayingSyncGate: DownloadGate {
    private let playlistId: String
    private let limit: () -> SyncWarnLimit
    private let declines: SyncDeclines
    /// Puts the question to the user; nil when it was withdrawn.
    private let ask: (SyncSizeQuestion) async -> SyncSizeChoice?
    private var answered: SyncSizeChoice?
    public private(set) var isClosed = false

    public init(
        playlistId: String,
        limit: @escaping () -> SyncWarnLimit,
        declines: SyncDeclines,
        ask: @escaping (SyncSizeQuestion) async -> SyncSizeChoice?
    ) {
        self.playlistId = playlistId
        self.limit = limit
        self.declines = declines
        self.ask = ask
    }

    /// From now on nothing is admitted and nothing is asked.
    public func close() { isClosed = true }

    public func admit(_ wanted: [OfflineTrack], in manifest: OfflineManifest) async -> [OfflineTrack] {
        guard !isClosed, !wanted.isEmpty else { return [] }
        if answered == .all { return wanted }
        switch SyncSizeGuard.decide(download: wanted, limit: limit(), playlistName: manifest.name) {
        case .nothing:
            return []
        case .proceed:
            return wanted
        case .ask(let question):
            guard let choice = await ask(question) else {
                isClosed = true
                return []
            }
            answered = choice
            switch choice {
            case .all:
                return wanted
            case .limit:
                isClosed = true
                return SyncSizeGuard.apply(.limit, to: wanted, limit: limit())
            case .cancel:
                declines.decline(playlistId)
                isClosed = true
                return []
            }
        }
    }
}

/// Listens to what the player does and syncs the playlist that plays. One object for the app (`PlayingPlaylistSync.shared`), observed by the screen that puts the
/// question on the display.
@MainActor
public final class PlayingPlaylistSync: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case idle
        /// The question is on screen: the sync of that playlist waits for `answer`.
        case asking(SyncSizeQuestion)
    }

    @Published public private(set) var phase: Phase = .idle

    private let api: MondropAPIProtocol
    private let engine: SyncEngine
    private let limit: () -> SyncWarnLimit
    private let hasKey: () -> Bool
    private let declines: SyncDeclines
    private let clock: PreparationClock
    private let pollInterval: TimeInterval
    private let pollTimeout: TimeInterval
    private let activity: SyncActivity?
    private let onSyncStarted: @MainActor () -> Void
    /// Keeps the list of the playlist that plays, so that its page opens at once (`PlaylistManifestCache`).
    private let cache: PlaylistManifestCaching?

    private var trigger = PlaylistSyncTrigger()

    private struct Run {
        let token: UUID
        let task: Task<Void, Never>
        let gate: PlayingSyncGate
    }

    /// The sync that is going for each playlist (at most one).
    private var runs: [String: Run] = [:]
    /// Syncs that were told to stop and have not finished unwinding yet.
    private var retired: [UUID: Task<Void, Never>] = [:]
    /// The question that is on screen waits here for its answer. One at a time: only the playlist that plays has a sync that can ask.
    private var pending: CheckedContinuation<SyncSizeChoice?, Never>?

    public init(
        api: MondropAPIProtocol,
        engine: SyncEngine,
        limit: @escaping () -> SyncWarnLimit,
        hasKey: @escaping () -> Bool,
        declines: SyncDeclines = SyncDeclines(),
        clock: PreparationClock = .real,
        pollInterval: TimeInterval = 5,
        pollTimeout: TimeInterval = 600,
        activity: SyncActivity? = nil,
        onSyncStarted: @escaping @MainActor () -> Void = {},
        cache: PlaylistManifestCaching? = nil
    ) {
        self.api = api
        self.engine = engine
        self.limit = limit
        self.hasKey = hasKey
        self.declines = declines
        self.clock = clock
        self.pollInterval = pollInterval
        self.pollTimeout = pollTimeout
        self.activity = activity
        self.onSyncStarted = onSyncStarted
        self.cache = cache
    }

    /// The playlists whose sync is going now.
    public var runningPlaylists: Set<String> { Set(runs.keys) }

    /// The question that is on screen, if any.
    public var question: SyncSizeQuestion? {
        if case .asking(let question) = phase { return question }
        return nil
    }

    // MARK: - What the player says

    /// The player changed: a song started or stopped, or the queue is another one. Never waits for anything: the sync runs on its own, playback does not
    /// depend on it.
    public func playbackChanged(_ context: PlaybackContext) {
        for action in trigger.observe(context) {
            switch action {
            case .sync(let id): startSync(of: id)
            case .leave(let id): stopSync(of: id)
            }
        }
    }

    /// The user's answer to the question on screen. Only the first answer counts; one that arrives when nothing is asked is ignored.
    public func answer(_ choice: SyncSizeChoice) {
        guard let waiting = pending else { return }
        pending = nil
        phase = .idle
        waiting.resume(returning: choice)
    }

    /// Waits until every sync that was started, or told to stop, has finished (the tests).
    func settled() async {
        while true {
            let tasks = runs.values.map(\.task) + Array(retired.values)
            guard !tasks.isEmpty else { return }
            for task in tasks { await task.value }
        }
    }

    // MARK: - A sync

    /// Starts the sync of `id`, unless one is already going for it, the user said «Annulla» to it or there is no key. Idempotent.
    func startSync(of id: String) {
        guard hasKey(), runs[id] == nil, !declines.isDeclined(id) else { return }
        let token = UUID()
        let gate = PlayingSyncGate(
            playlistId: id, limit: limit, declines: declines,
            ask: { [weak self] question in await self?.ask(question) }
        )
        let sync = PlaylistSyncCoordinator(
            playlist: MondropPlaylist(id: id, name: "", songCount: 0),
            api: api, engine: engine, clock: clock, pollInterval: pollInterval, pollTimeout: pollTimeout,
            activity: activity, onSyncStarted: onSyncStarted, gate: gate, cache: cache, origin: .automatic
        )
        let task = Task { [weak self] in
            await sync.sync()
            self?.finished(id, token: token, failed: sync.errorText != nil)
        }
        runs[id] = Run(token: token, task: task, gate: gate)
    }

    /// The queue left `id`: its sync stops reading, and the question it may be asking goes away without being answered. What is already queued for download
    /// stays queued.
    private func stopSync(of id: String) {
        guard let run = runs.removeValue(forKey: id) else { return }
        retired[run.token] = run.task
        run.gate.close()
        run.task.cancel()
        withdraw()      // the question on screen, if any, is the one of the playlist that was playing: the one that was just left
    }

    /// A sync that was stopped is no longer in `runs` (and never comes back to it), so only one that ended by itself gets here as the current run: a failure
    /// of the one that was stopped is nobody's business.
    private func finished(_ id: String, token: UUID, failed: Bool) {
        retired.removeValue(forKey: token)
        guard runs[id]?.token == token else { return }
        runs.removeValue(forKey: id)
        if failed { trigger.rearm(id) }
    }

    // MARK: - The question

    private func ask(_ question: SyncSizeQuestion) async -> SyncSizeChoice? {
        guard pending == nil else { return nil }      // one question at a time: the playlists that are not the playing one were left, and withdrew theirs
        phase = .asking(question)
        return await withCheckedContinuation { (continuation: CheckedContinuation<SyncSizeChoice?, Never>) in
            pending = continuation
        }
    }

    private func withdraw() {
        guard let waiting = pending else { return }
        pending = nil
        phase = .idle
        waiting.resume(returning: nil)
    }
}
