// PlaylistSync.swift — the sync of ONE playlist: prepare → plan → enqueue → keep re-reading the
// manifest while the server prepares tracks, downloading each one as soon as it turns ready.
// Plus the "Libera spazio" model (orphan cleanup, only on explicit request).

import Foundation

@MainActor
public final class PlaylistSyncCoordinator: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        /// `prepare` is in flight
        case syncing
        /// re-reading the manifest while tracks are `preparing`
        case polling
    }

    @Published public private(set) var manifest: OfflineManifest?
    @Published public private(set) var phase: Phase = .idle
    @Published public private(set) var message: String = ""
    @Published public private(set) var errorText: String?

    public let playlist: MondropPlaylist
    private let api: MondropAPIProtocol
    private let engine: SyncEngine
    private let clock: PreparationClock
    private let pollInterval: TimeInterval
    private let pollTimeout: TimeInterval
    private let activity: SyncActivity?
    private let onSyncStarted: @MainActor () -> Void

    /// Playlists the user pressed Sync on during this app run: if the view is reopened while the server is
    /// still preparing them, polling resumes WITH downloads (otherwise reopening only refreshes the list).
    private static var syncRequested = Set<String>()

    public init(
        playlist: MondropPlaylist,
        api: MondropAPIProtocol,
        engine: SyncEngine,
        clock: PreparationClock = .real,
        pollInterval: TimeInterval = 5,
        pollTimeout: TimeInterval = 600,
        activity: SyncActivity? = nil,
        onSyncStarted: @escaping @MainActor () -> Void = {}
    ) {
        self.playlist = playlist
        self.api = api
        self.engine = engine
        self.clock = clock
        self.pollInterval = pollInterval
        self.pollTimeout = pollTimeout
        self.activity = activity
        self.onSyncStarted = onSyncStarted
    }

    public var isBusy: Bool { phase != .idle }

    // MARK: - Load

    public func load() async {
        guard phase == .idle else { return }
        phase = .loading
        do {
            accept(try await api.offlineManifest(playlistId: playlist.id))
            errorText = nil
        } catch {
            errorText = Self.describe(error)
        }
        phase = .idle
        if let manifest, manifest.preparingCount > 0 {
            await pollWhilePreparing(download: Self.syncRequested.contains(playlist.id))
        }
    }

    // MARK: - Sync

    /// Idempotent: tracks already on the device (same version) or already in flight are skipped.
    public func sync(retryFailed: Bool = false) async {
        guard phase == .idle else { return }
        onSyncStarted()          // the right moment to ask iOS for notifications, once — never waited for
        phase = .syncing
        message = "Preparo la playlist…"
        errorText = nil
        do {
            let prepared = try await api.prepare(playlistId: playlist.id, retryFailed: retryFailed)
            Self.syncRequested.insert(playlist.id)
            accept(prepared)
            let plan = engine.enqueue(prepared.tracks)
            message = Self.summary(plan: plan, manifest: prepared)
            phase = .idle
            await pollWhilePreparing(download: true)
        } catch {
            errorText = Self.describeSyncFailure(error)
            phase = .idle
        }
    }

    /// A backend that predates the sync contract answers 404 to `prepare`: say so instead of "HTTP 404".
    static func describeSyncFailure(_ error: Error) -> String {
        if case .http(404, _)? = error as? MondropAPIError {
            return "Il server non supporta ancora il nuovo Sync (backend da aggiornare): niente da scaricare."
        }
        return describe(error)
    }

    /// Re-read every `pollInterval` while any track is `preparing`, for at most `pollTimeout`.
    private func pollWhilePreparing(download: Bool) async {
        guard phase == .idle, let first = manifest, first.preparingCount > 0 else { return }
        phase = .polling
        let started = clock.now()
        while let current = manifest, current.preparingCount > 0 {
            if clock.now().timeIntervalSince(started) >= pollTimeout {
                message = "Il server sta ancora preparando \(current.preparingCount) brani: riprova più tardi."
                break
            }
            do {
                try await clock.sleep(pollInterval)
            } catch {
                break   // cancelled (view closed)
            }
            if Task.isCancelled { break }
            do {
                let next = try await api.offlineManifest(playlistId: playlist.id)
                accept(next)
                if download {
                    let plan = engine.enqueue(next.tracks)
                    message = Self.summary(plan: plan, manifest: next)
                }
                errorText = nil
            } catch {
                errorText = Self.describe(error)
                break
            }
        }
        phase = .idle
    }

    // MARK: - Row actions

    /// `PUT …/source` with a YouTube link, then the usual prepare/poll/download.
    @discardableResult
    public func setYouTubeSource(songKey: String, urlText: String) async -> Bool {
        guard let url = Self.normalizedYouTubeURL(urlText) else {
            errorText = "Link YouTube non valido"
            return false
        }
        do {
            try await api.setSource(songKey: songKey, youtubeUrl: url.absoluteString)
        } catch {
            errorText = Self.describe(error)
            return false
        }
        await sync()
        return true
    }

    /// Device download failed → resume/retry locally; server failed → `prepare` with `retryFailed`.
    public func retry(songKey: String) async {
        if case .failed? = engine.progress[songKey] {
            engine.retry(songKey: songKey)
        } else {
            await sync(retryFailed: true)
        }
    }

    // MARK: - Helpers

    private func accept(_ next: OfflineManifest) {
        manifest = next
        engine.store.recordPlaylist(id: playlist.id, name: next.name, songKeys: next.tracks.map(\.songKey), failedKeys: next.failedKeys)
        engine.store.recordServerNumbers(from: next)      // plays / lastPlayedAt for the "meno ascoltate" ranking
        engine.store.recordMetadata(from: next.tracks)    // album / genres / year: «Libreria» browses the phone offline
        activity?.observe(next.tracks)                    // the line at the top: how many the server is preparing
    }

    /// "Riscarica": the user wants a song they deleted back. Clears the skip-list entry and downloads it now.
    public func redownload(songKey: String) async {
        guard let track = manifest?.tracks.first(where: { $0.songKey == songKey }) else { return }
        engine.redownload(track)
    }

    static func summary(plan: SyncPlan, manifest: OfflineManifest) -> String {
        var parts: [String] = []
        if !plan.download.isEmpty || !plan.inFlight.isEmpty { parts.append("\(plan.download.count + plan.inFlight.count) in download") }
        if !plan.skipped.isEmpty { parts.append("\(plan.skipped.count) già sul telefono") }
        if !plan.removedByUser.isEmpty { parts.append("\(plan.removedByUser.count) rimosse dal telefono") }
        if manifest.preparingCount > 0 { parts.append("\(manifest.preparingCount) in preparazione sul server") }
        let problems = manifest.failedCount + manifest.noSourceCount
        if problems > 0 { parts.append("\(problems) con problemi") }
        return parts.isEmpty ? "Nulla da scaricare" : parts.joined(separator: " · ")
    }

    static func describe(_ error: Error) -> String {
        (error as? MondropAPIError)?.description ?? error.localizedDescription
    }

    /// Accepts watch / youtu.be / music.youtube.com links (what the server accepts), nothing else.
    public static func normalizedYouTubeURL(_ text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", let host = url.host?.lowercased() else { return nil }
        let allowed: Set<String> = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]
        guard allowed.contains(host) else { return nil }
        return url
    }
}

// MARK: - Taking a song out of the list

extension PlaylistSyncCoordinator {
    /// The swipe «Togli dalla playlist» (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U7): the song leaves the page AT ONCE, the server
    /// is told, and if it says no (or cannot be reached) the song goes back where it was. Nothing is deleted from the phone: it only leaves the list.
    @discardableResult
    public func removeSong(songKey: String, using remover: PlaylistSongRemoving) async -> PlaylistRemoveOutcome {
        guard let before = manifest, let index = before.tracks.firstIndex(where: { $0.songKey == songKey }) else {
            return .failed("Questo brano non è più nella playlist.")
        }
        let track = before.tracks[index]
        var kept = before.tracks
        kept.remove(at: index)
        manifest = OfflineManifest(playlistId: before.playlistId, name: before.name, tracks: kept, user: before.user, dynamic: before.dynamic, generatedAt: before.generatedAt)
        do {
            let ack = try await remover.removeSong(songKey: songKey, fromPlaylist: playlist.id)
            let now = manifest ?? before
            engine.store.recordPlaylist(id: playlist.id, name: now.name, songKeys: now.tracks.map(\.songKey), failedKeys: now.failedKeys)
            let name = ack.name.isBlank ? now.name : ack.name
            return .removed("Tolto da «\(name)»")
        } catch {
            putBack(track, at: index)
            return PlaylistRemoveOutcome.refused(error)
        }
    }

    /// The song goes back at the place it had (or at the end if the list got shorter meanwhile), unless a re-read already brought it back.
    private func putBack(_ track: OfflineTrack, at index: Int) {
        guard let current = manifest, !current.tracks.contains(where: { $0.songKey == track.songKey }) else { return }
        var tracks = current.tracks
        tracks.insert(track, at: min(index, tracks.count))
        manifest = OfflineManifest(playlistId: current.playlistId, name: current.name, tracks: tracks, user: current.user, dynamic: current.dynamic, generatedAt: current.generatedAt)
    }
}

/// Re-reads EVERY playlist: which songs each one holds (orphan detection) and the listening numbers of each song.
public enum PlaylistSnapshots {
    /// Throws at the first playlist that cannot be read: a partial picture must never drive a deletion.
    @discardableResult
    public static func refreshAll(api: MondropAPIProtocol, store: OfflineStore) async throws -> [MondropPlaylist] {
        let playlists = try await api.listPlaylists()
        for playlist in playlists {
            let manifest = try await api.offlineManifest(playlistId: playlist.id)
            store.recordPlaylist(id: playlist.id, name: manifest.name, songKeys: manifest.tracks.map(\.songKey), failedKeys: manifest.failedKeys)
            store.recordServerNumbers(from: manifest)
            store.recordMetadata(from: manifest.tracks)
        }
        store.pruneMemberships(keeping: Set(playlists.map(\.id)))
        return playlists
    }
}

/// Songs in no known playlist (the older "Libera spazio" flow). Since Mondrop 1.4 the UI deletes through
/// `SpaceModel` / `SongDeleter` (double confirmation for blocks, audit event, skip-list); this type is kept for its
/// refresh-then-count logic and its tests, and `confirmRemoval` must not be wired to a button again.
/// Memberships are refreshed from EVERY playlist first, and the
/// user confirms the exact list — nothing is deleted from a stale or partial picture.
@MainActor
public final class LibraryCleaner: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case idle
        case checking
        case ready(count: Int, bytes: Int)
        case done(count: Int, bytes: Int)
        case failed(String)
    }

    @Published public private(set) var phase: Phase = .idle
    private var pending: [OfflineStore.Item] = []

    public init() {}

    public func check(api: MondropAPIProtocol, store: OfflineStore) async {
        phase = .checking
        pending = []
        do {
            try await PlaylistSnapshots.refreshAll(api: api, store: store)
            pending = store.orphans()
            let summary = store.orphanSummary()
            phase = .ready(count: pending.count, bytes: summary.bytes)
        } catch {
            phase = .failed("Non riesco a controllare tutte le playlist (\(PlaylistSyncCoordinator.describe(error))): non cancello niente.")
        }
    }

    public func confirmRemoval(store: OfflineStore) {
        let result = store.removeOrphans(confirmed: pending)
        pending = []
        phase = .done(count: result.count, bytes: result.bytes)
    }

    public func reset() {
        pending = []
        phase = .idle
    }
}
