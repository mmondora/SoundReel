// PlaylistConsistency.swift — the check of the playlists the phone holds (Michele, 11 November, trying build 16: «Voglio un check di consistenza con sync sulle
// impostazioni che verifica tutte le playlist locali o già scaricate se hanno tutti i file e scaricano quelli che mancano»; spec
// 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U15).
//
// The one place where the sync is visible on purpose (everywhere else it is automatic and quiet): a button in the Settings. It looks at every playlist the phone
// holds — the ones that are on it, or mostly on it —, asks SoundReel what each one has NOW, and downloads what the phone is missing: songs added to the playlist
// since, files that are not the ones the server has (truncated, an older version), songs that were never fetched. It asks SoundReel to prepare the songs the server
// has not prepared yet (the same call the playlist that plays makes). It never brings back a song the user deleted from the phone on purpose, never touches a playlist
// that is not on the phone, and — when what is missing is more than the limit of the Settings — asks ONCE for the whole check: Scarica tutto, Limita, Annulla.
// Where the songs come from is, as always, SoundReel's business (rule P).

import Foundation

/// Which playlists «the phone holds»: the ones that are completely on it, or at least half. A playlist with a few songs on the phone only because it shares them with
/// another one (a dynamic playlist of a genre with two hundred songs, three of which were played) is not «downloaded»: the check would fetch songs nobody asked for.
public enum ConsistencyScope {
    /// `record` is what the phone saw of the playlist the last time it read it (nil: never read).
    public static func holds(record: OfflineStore.PlaylistRecord?, local: Set<String>) -> Bool {
        guard let record, !record.songKeys.isEmpty else { return false }
        let onPhone = record.songKeys.filter { local.contains($0) }.count
        return onPhone > 0 && onPhone * 2 >= record.songKeys.count
    }
}

/// What the check found and did, in numbers and in words.
public struct ConsistencyReport: Equatable, Sendable {
    /// The playlists it looked at (the ones the phone holds), the ones it could not read included.
    public var playlists = 0
    /// Playlists that have every song the user wants on the phone.
    public var complete = 0
    /// Playlists with something still to bring: songs to download, or that SoundReel cannot give yet.
    public var toComplete = 0
    /// What it sent to download (after the answer to the question, if there was one), and how much that is.
    public var songsToDownload = 0
    public var bytesToDownload = 0
    /// Songs that stayed online because the user chose «Limita».
    public var leftOut = 0
    /// Songs SoundReel has not prepared yet (it was asked to), has no source for, or failed.
    public var notReadyOnServer = 0
    public var withoutSource = 0
    public var failedOnServer = 0
    /// The playlists it could not read (their names); the others were checked.
    public var unreadable: [String] = []
    public var cancelled = false
    /// Why nothing was checked: the list of the playlists could not be read, or there is no key.
    public var listFailure: String?

    public init() {}

    /// What the Settings say, one line each.
    public var lines: [String] {
        if let listFailure { return ["Non riesco a leggere le playlist: \(listFailure). Riprova."] }
        if playlists == 0 {
            return ["Sul telefono non c'è ancora nessuna playlist da controllare: suonane una e la scarico da sola."]
        }
        var out: [String] = []
        let looked = playlists == 1 ? "Controllata 1 playlist" : "Controllate \(playlists) playlist"
        if toComplete == 0 && complete == playlists {
            out.append(playlists == 1 ? "\(looked): ha già tutti i brani." : "\(looked): tutte hanno già tutti i brani.")
        } else {
            var parts: [String] = []
            if complete > 0 { parts.append(complete == 1 ? "1 completa" : "\(complete) complete") }
            if toComplete > 0 { parts.append("\(toComplete) da completare") }
            out.append(parts.isEmpty ? "\(looked)." : "\(looked): \(parts.joined(separator: ", ")).")
        }
        if cancelled {
            out.append("Annullato: non ho scaricato niente.")
        } else if songsToDownload > 0 {
            let size = bytesToDownload > 0 ? " (\(ByteCountFormatter.string(fromByteCount: Int64(bytesToDownload), countStyle: .file)))" : ""
            out.append("Scarico \(songsToDownload) \(songsToDownload == 1 ? "brano" : "brani")\(size).")
        }
        if leftOut > 0 { out.append("Lasciati online per il limite: \(leftOut).") }
        if notReadyOnServer > 0 { out.append("Non ancora pronti sul server: \(notReadyOnServer) (li ho chiesti: riprova più tardi).") }
        if withoutSource > 0 { out.append("Senza sorgente: \(withoutSource).") }
        if failedOnServer > 0 { out.append("Con errore sul server: \(failedOnServer).") }
        if !unreadable.isEmpty { out.append("Non riesco a leggere: \(unreadable.map { "«\($0)»" }.joined(separator: ", ")).") }
        return out
    }
}

/// The check. One object for the app (`PlaylistConsistencyCheck.shared`), observed by the Settings, which show where it is and put its question on the display.
@MainActor
public final class PlaylistConsistencyCheck: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case idle
        /// Reading the playlists, one after the other.
        case checking(done: Int, total: Int)
        /// More to download than the limit: the question is on screen and the check waits for `answer`.
        case asking(SyncSizeQuestion)
        case finished(ConsistencyReport)
    }

    @Published public private(set) var phase: Phase = .idle

    private let api: MondropAPIProtocol
    private let engine: SyncEngine
    private let limit: () -> SyncWarnLimit
    private let hasKey: () -> Bool
    private let cache: PlaylistManifestCaching?
    private let activity: SyncActivity?
    private var task: Task<Void, Never>?
    /// The question on screen waits here for its answer; nil when none is asked.
    private var pending: CheckedContinuation<SyncSizeChoice?, Never>?

    public init(
        api: MondropAPIProtocol,
        engine: SyncEngine,
        limit: @escaping () -> SyncWarnLimit,
        hasKey: @escaping () -> Bool,
        cache: PlaylistManifestCaching? = nil,
        activity: SyncActivity? = nil
    ) {
        self.api = api
        self.engine = engine
        self.limit = limit
        self.hasKey = hasKey
        self.cache = cache
        self.activity = activity
    }

    public var isBusy: Bool {
        switch phase {
        case .checking, .asking: return true
        case .idle, .finished: return false
        }
    }

    /// The question that is on screen, if any.
    public var question: SyncSizeQuestion? {
        if case .asking(let question) = phase { return question }
        return nil
    }

    // MARK: - What the user does

    /// The button. Does nothing while a check is already going.
    public func start() {
        guard !isBusy, task == nil else { return }
        task = Task { [weak self] in
            await self?.run()
            self?.task = nil
        }
    }

    /// The user's answer to the question on screen. Only the first answer counts; one that arrives when nothing is asked is ignored.
    public func answer(_ choice: SyncSizeChoice) {
        guard let waiting = pending else { return }
        pending = nil
        waiting.resume(returning: choice)
    }

    /// Stops the check: what it was waiting for (an answer) is given up, and nothing is downloaded.
    public func cancel() {
        task?.cancel()
        guard let waiting = pending else { return }
        pending = nil
        waiting.resume(returning: nil)
    }

    // MARK: - The check

    func run() async {
        guard !isBusy else { return }
        var report = ConsistencyReport()
        guard hasKey() else {
            report.listFailure = "manca la API key (Impostazioni → API key)"
            phase = .finished(report)
            return
        }
        phase = .checking(done: 0, total: 0)
        let all: [MondropPlaylist]
        do {
            all = try await api.listPlaylists()
        } catch {
            report.listFailure = PlaylistSyncCoordinator.describe(error)
            phase = .finished(report)
            return
        }
        let records = engine.store.playlistRecords()
        let local = engine.store.localSongKeys()
        let candidates = all.filter { ConsistencyScope.holds(record: records[$0.id], local: local) }
        report.playlists = candidates.count
        phase = .checking(done: 0, total: candidates.count)

        // What is missing, across all the playlists: a song that two of them hold is brought once.
        var wanted: [OfflineTrack] = []
        var wantedKeys = Set<String>()
        var adopt: [OfflineTrack] = []
        var adoptKeys = Set<String>()
        var notReady = Set<String>()
        var noSource = Set<String>()
        var failed = Set<String>()

        func settle(cancelled: Bool, downloading admitted: [OfflineTrack] = [], leftOut: Int = 0) {
            report.cancelled = cancelled
            report.songsToDownload = admitted.count
            report.bytesToDownload = admitted.reduce(0) { $0 + ($1.bytes ?? 0) }
            report.leftOut = leftOut
            report.notReadyOnServer = notReady.count
            report.withoutSource = noSource.count
            report.failedOnServer = failed.count
            if !admitted.isEmpty || (!adopt.isEmpty && !cancelled) { engine.enqueue(adopt + admitted, origin: .sync) }
            phase = .finished(report)
        }

        for (index, playlist) in candidates.enumerated() {
            if Task.isCancelled { return settle(cancelled: true) }
            do {
                var manifest = try await api.offlineManifest(playlistId: playlist.id)
                var plan = engine.plan(manifest.tracks)
                // Songs SoundReel never prepared: it is asked to, like the playlist that plays does. The ones it can give at once come back ready.
                if !plan.missing.isEmpty, let prepared = try? await api.prepare(playlistId: playlist.id, retryFailed: false) {
                    manifest = prepared
                    plan = engine.plan(prepared.tracks)
                }
                engine.store.remember(manifest)
                cache?.save(manifest)
                activity?.observe(manifest.tracks)
                for track in plan.download where wantedKeys.insert(track.songKey).inserted { wanted.append(track) }
                for track in manifest.tracks where plan.adopt.contains(track.songKey) && adoptKeys.insert(track.songKey).inserted { adopt.append(track) }
                notReady.formUnion(plan.preparing)
                notReady.formUnion(plan.missing)
                noSource.formUnion(plan.noSource)
                failed.formUnion(plan.failed)
                let somethingLeft = !(plan.download.isEmpty && plan.inFlight.isEmpty && plan.preparing.isEmpty && plan.missing.isEmpty && plan.failed.isEmpty && plan.noSource.isEmpty)
                if somethingLeft { report.toComplete += 1 } else { report.complete += 1 }
            } catch {
                if Task.isCancelled { return settle(cancelled: true) }
                report.unreadable.append(playlist.name)
            }
            phase = .checking(done: index + 1, total: candidates.count)
        }

        // One question for the whole check, over the limit of the Settings.
        var admitted = wanted
        switch SyncSizeGuard.decide(download: wanted, limit: limit(), playlistName: nil) {
        case .nothing:
            admitted = []
        case .proceed:
            break
        case .ask(let question):
            phase = .asking(question)
            guard let choice = await ask() else { return settle(cancelled: true) }
            if choice == .cancel { return settle(cancelled: true) }
            admitted = SyncSizeGuard.apply(choice, to: wanted, limit: limit())
        }
        settle(cancelled: false, downloading: admitted, leftOut: wanted.count - admitted.count)
    }

    private func ask() async -> SyncSizeChoice? {
        await withCheckedContinuation { (continuation: CheckedContinuation<SyncSizeChoice?, Never>) in
            pending = continuation
        }
    }
}
