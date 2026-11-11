// LibrarySync.swift — the sync of EVERY playlist at once: at the first access (Michele, 10 November: «al primo accesso viene fatto un sync automatico … Se
// sono molti gb deve avvisare oppure limitare») and from the «Sync» of the first page (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U2).
//
// It reads every playlist the way the «Sync» inside one playlist does (`prepare`: the server prepares what is missing and answers with the manifest), works
// out what is still to download, and BEFORE the first download asks if it is above the limit the user set (`SyncSizeGuard`). The warning is the same
// wherever the phone is and it never blocks: rule P, the app neither tells where it is nor chooses a source. Cellular stays off for downloads, as ever:
// that is the engine's business.

import Foundation

@MainActor
public final class LibrarySyncCoordinator: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case idle
        /// Reading the playlists and deciding.
        case reading
        /// The question is on screen: the run waits for `answer`.
        case asking(SyncSizeQuestion)
    }

    @Published public private(set) var phase: Phase = .idle
    /// What the last run did, or what went wrong, in a line.
    @Published public private(set) var message: String = ""

    private let api: MondropAPIProtocol
    private let engine: SyncEngine
    private let limit: () -> SyncWarnLimit
    private let hasKey: () -> Bool
    private let isFirstSyncDone: () -> Bool
    private let markFirstSyncDone: () -> Void
    private let onSyncStarted: @MainActor () -> Void
    private var pending: CheckedContinuation<SyncSizeChoice, Never>?

    public init(
        api: MondropAPIProtocol,
        engine: SyncEngine,
        limit: @escaping () -> SyncWarnLimit,
        hasKey: @escaping () -> Bool,
        isFirstSyncDone: @escaping () -> Bool,
        markFirstSyncDone: @escaping () -> Void,
        onSyncStarted: @escaping @MainActor () -> Void = {}
    ) {
        self.api = api
        self.engine = engine
        self.limit = limit
        self.hasKey = hasKey
        self.isFirstSyncDone = isFirstSyncDone
        self.markFirstSyncDone = markFirstSyncDone
        self.onSyncStarted = onSyncStarted
    }

    public var isBusy: Bool { phase != .idle }

    // MARK: - Entry points

    /// Once per phone: the first time the app is opened with a key. With no key it waits for the next opening; an error that stops it halfway waits too.
    /// iOS is NOT asked for notifications here: that happens when the user presses «Sync», never behind their back.
    public func runFirstSyncIfNeeded() async {
        guard !isFirstSyncDone(), hasKey(), phase == .idle else { return }
        await run(firstAccess: true)
    }

    /// The «Sync» of the first page: every playlist, the same question over the same limit.
    public func syncAll() async {
        guard phase == .idle else { return }
        onSyncStarted()
        await run(firstAccess: false)
    }

    /// The user's answer to the question on screen. Only the first answer counts; one that arrives when nothing is asked is ignored.
    public func answer(_ choice: SyncSizeChoice) {
        guard let waiting = pending else { return }
        pending = nil
        waiting.resume(returning: choice)
    }

    // MARK: - The run

    private func run(firstAccess: Bool) async {
        phase = .reading
        message = "Leggo le playlist…"
        var complete = false
        do {
            let playlists = try await api.listPlaylists()
            var manifests: [OfflineManifest] = []
            var unread = 0
            for playlist in playlists {
                do {
                    let manifest = try await api.prepare(playlistId: playlist.id, retryFailed: false)
                    remember(manifest, of: playlist)
                    manifests.append(manifest)
                } catch {
                    unread += 1           // one playlist that cannot be read does not stop the others
                }
            }
            // A playlist deleted on the server stops protecting its songs only when the picture is whole.
            if unread == 0 { engine.store.pruneMemberships(keeping: Set(playlists.map(\.id))) }

            let tracks = manifests.flatMap(\.tracks)
            let plan = engine.plan(tracks)
            let adopt = tracks.filter { plan.adopt.contains($0.songKey) }
            var chosen = plan.download
            var cancelled = false
            switch SyncSizeGuard.decide(download: plan.download, limit: limit()) {
            case .nothing, .proceed:
                break
            case .ask(let question):
                let choice = await ask(question)
                chosen = SyncSizeGuard.apply(choice, to: plan.download, limit: limit())
                cancelled = choice == .cancel
            }
            if !chosen.isEmpty || !adopt.isEmpty { engine.enqueue(adopt + chosen) }

            var line = Self.summary(chosen: chosen, of: plan.download, cancelled: cancelled)
            if unread > 0 { line += " · \(unread) \(unread == 1 ? "playlist non letta" : "playlist non lette")" }
            message = line
            complete = unread == 0
        } catch {
            message = PlaylistSyncCoordinator.describe(error)
        }
        // «Annulla» counts as done too (the question is not asked again at every opening); an error or an unread playlist does not.
        if firstAccess && complete { markFirstSyncDone() }
        phase = .idle
    }

    private func ask(_ question: SyncSizeQuestion) async -> SyncSizeChoice {
        phase = .asking(question)
        let choice = await withCheckedContinuation { (continuation: CheckedContinuation<SyncSizeChoice, Never>) in
            pending = continuation
        }
        phase = .reading
        return choice
    }

    /// What the phone learns from a playlist it has just read: which songs it holds and which failed (the mark of the playlist), the listening numbers,
    /// the album, genres and year of each song.
    private func remember(_ manifest: OfflineManifest, of playlist: MondropPlaylist) {
        engine.store.recordPlaylist(id: playlist.id, name: manifest.name, songKeys: manifest.tracks.map(\.songKey), failedKeys: manifest.failedKeys)
        engine.store.recordServerNumbers(from: manifest)
        engine.store.recordMetadata(from: manifest.tracks)
    }

    static func summary(chosen: [OfflineTrack], of all: [OfflineTrack], cancelled: Bool) -> String {
        if cancelled { return "Sync annullato: non scarico niente" }
        if chosen.isEmpty { return "Nulla da scaricare" }
        let size = ByteCountFormatter.string(fromByteCount: Int64(chosen.reduce(0) { $0 + ($1.bytes ?? 0) }), countStyle: .file)
        var line = "Scarico \(chosen.count) \(chosen.count == 1 ? "brano" : "brani") (\(size))"
        if chosen.count < all.count { line += " · gli altri \(all.count - chosen.count) restano online" }
        return line
    }
}
