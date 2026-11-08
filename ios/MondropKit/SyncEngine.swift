// SyncEngine.swift — the download queue of the sync: at most 2 downloads at a time, skip-present,
// resume data, installs into the OfflineStore. Every download comes from SoundReel (rule P, ADR-0018).
//
// The engine knows nothing about URLSession: it talks to a `DownloadTransport`
// (BackgroundDownloadTransport in the app, a fake in tests).

import Foundation
import Combine

public enum TrackProgress: Equatable, Sendable {
    case queued
    /// nil = size not known yet
    case downloading(Double?)
    case failed(String)
}

public struct EngineConfig: Sendable, Equatable {
    public var baseURL: String
    public var apiKey: String
    public var user: String
    /// Settings toggle "Scarica anche con rete cellulare" (default off → Wi-Fi only).
    public var allowCellular: Bool

    public init(baseURL: String, apiKey: String, user: String, allowCellular: Bool = false) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.user = user
        self.allowCellular = allowCellular
    }

    public static func current() -> EngineConfig {
        let api = MondropAPIConfig.current()
        return EngineConfig(
            baseURL: api.baseURL,
            apiKey: api.apiKey,
            user: api.user,
            allowCellular: Settings.shared.allowCellularDownloads
        )
    }

    var api: MondropAPIConfig { MondropAPIConfig(baseURL: baseURL, apiKey: apiKey, user: user) }
}

/// Travels with every URLSession task (`taskDescription`), so a relaunched app can still install the
/// file of a download it did not start in this process. A description written by an older build may carry fields
/// this one no longer has (`kind`, `proxyPath`): decoding ignores them.
public struct JobInfo: Codable, Equatable, Sendable {
    public var songKey: String
    public var title: String
    public var artist: String
    public var coverUrl: String?
    public var lyrics: String?
    public var version: String?
    public var bytes: Int?
    /// Server numbers at the time of the download (docs/mondrop-stats.md §3); optional like every new field.
    public var plays: Int?
    public var lastPlayedAt: String?
    /// ADR-0013: what the server said about the song, kept with the file so «Libreria» can browse the phone offline.
    /// Optional: the description of a task started by an earlier build does not have them.
    public var album: String?
    public var genres: [String]?
    public var year: Int?

    public init(
        songKey: String, title: String, artist: String, coverUrl: String? = nil, lyrics: String? = nil,
        version: String? = nil, bytes: Int? = nil,
        plays: Int? = nil, lastPlayedAt: String? = nil,
        album: String? = nil, genres: [String]? = nil, year: Int? = nil
    ) {
        self.songKey = songKey
        self.title = title
        self.artist = artist
        self.coverUrl = coverUrl
        self.lyrics = lyrics
        self.version = version
        self.bytes = bytes
        self.plays = plays
        self.lastPlayedAt = lastPlayedAt
        self.album = album
        self.genres = genres
        self.year = year
    }
}

public struct TransportJob: @unchecked Sendable {
    public let info: JobInfo
    public let request: URLRequest
    public let resumeData: Data?

    public init(info: JobInfo, request: URLRequest, resumeData: Data?) {
        self.info = info
        self.request = request
        self.resumeData = resumeData
    }
}

public protocol DownloadTransport: AnyObject {
    var handler: DownloadTransportHandler? { get set }
    func start(_ job: TransportJob)
    func cancel(songKey: String)
    /// Downloads still alive in the (background) session, e.g. after the app was relaunched.
    func reattach(_ completion: @escaping @Sendable ([JobInfo]) -> Void)
}

/// Callbacks may arrive on any thread; the engine hops to the main actor itself.
public protocol DownloadTransportHandler: AnyObject {
    func transportProgress(songKey: String, fraction: Double?)
    /// `stagedFile` is already in our own staging directory (the system temp file is gone after the callback).
    func transportFinished(info: JobInfo, stagedFile: URL, httpStatus: Int?)
    func transportFailed(info: JobInfo, message: String, resumeData: Data?, requestURL: URL?, cancelled: Bool)
}

/// Why a download was queued. Only a `sync` is announced when it ends (SyncBatch): the download a first play starts
/// in parallel is not.
public enum DownloadOrigin: Sendable {
    case sync
    case play
}

/// One song waiting in the queue. The queue file of an older build also has a flag per job (where the phone was): ignored.
struct QueuedJob: Codable, Equatable {
    var track: OfflineTrack
}

@MainActor
public final class SyncEngine: ObservableObject, DownloadTransportHandler {
    public static let shared = SyncEngine(
        transport: BackgroundDownloadTransport.shared,
        store: .shared,
        config: { EngineConfig.current() },
        persistQueue: true
    )

    /// Per songKey; a track with no entry is idle (look at the store for "scaricato").
    @Published public private(set) var progress: [String: TrackProgress] = [:]
    /// Bumped whenever the store changes (install / remove), so lists can re-read it.
    @Published public private(set) var revision = 0

    public var maxParallel = 2
    public let store: OfflineStore

    private let transport: DownloadTransport
    private let config: () -> EngineConfig
    private let persistQueue: Bool
    private var queue: [QueuedJob] = []
    private var active: [String: JobInfo] = [:]
    private var failedJobs: [String: QueuedJob] = [:]
    private var userCancelled: Set<String> = []
    private var lastPercent: [String: Int] = [:]
    private var batch = SyncBatch()
    private let now: () -> Date
    /// The queue on disk has been read (relaunch) or replaced by what this run queued. Until then a finished download
    /// that iOS delivers first must not rewrite the file from an empty in-memory queue — the songs still waiting in it
    /// would be lost, and with them the end of the sync.
    private var queueLoaded = false

    /// A sync ended: everything it queued has finished or failed. The app plugs the «Sync finito» notification in here.
    public var onBatchFinished: (@MainActor (SyncBatchSummary) -> Void)?

    public init(
        transport: DownloadTransport,
        store: OfflineStore,
        config: @escaping () -> EngineConfig,
        persistQueue: Bool = false,
        now: @escaping () -> Date = { Date() }
    ) {
        self.transport = transport
        self.store = store
        self.config = config
        self.persistQueue = persistQueue
        self.now = now
        transport.handler = self
        // The sync in progress when the app was last alive (read here, not in `attachExisting`: iOS may deliver a
        // finished download before the relaunch code has run).
        if persistQueue, let data = store.readBatchData(),
           let saved = try? JSONDecoder.batch.decode(SyncBatch.self, from: data), !saved.isStale(now: now()) {
            batch = saved
        }
    }

    public var activeCount: Int { active.count }
    public var queuedCount: Int { queue.count }

    // MARK: - Public API

    /// Plans (skip-present / adopt / download) and queues the downloads. Idempotent.
    @discardableResult
    public func enqueue(_ tracks: [OfflineTrack], front: Bool = false, origin: DownloadOrigin = .sync) -> SyncPlan {
        queueLoaded = true
        let inFlight = Set(active.keys).union(queue.map { $0.track.songKey })
        let plan = SyncPlanner.plan(
            tracks: tracks,
            local: { store.snapshot(songKey: $0) },
            inFlight: inFlight,
            skipped: store.skippedKeys           // deleted from this phone on purpose: not downloaded again
        )

        for key in plan.adopt {
            if let version = tracks.first(where: { $0.songKey == key })?.version {
                store.adoptVersion(songKey: key, version: version)
            }
        }
        let jobs = plan.download.map { QueuedJob(track: $0) }
        for job in jobs {
            failedJobs.removeValue(forKey: job.track.songKey)
            progress[job.track.songKey] = .queued
        }
        if front { queue.insert(contentsOf: jobs, at: 0) } else { queue.append(contentsOf: jobs) }
        if origin == .sync {
            // What the sync asked for: the songs it queues now, plus the ones already on their way (they settle it too).
            batch.enqueue(jobs.map { $0.track.songKey } + plan.inFlight, at: now())
            persistBatch()
        }
        pump()
        persist()
        return plan
    }

    /// "Riscarica": the user wants a song they deleted back on the phone. Clears the skip-list entry, then downloads
    /// it ahead of the queue.
    @discardableResult
    public func redownload(_ track: OfflineTrack) -> SyncPlan {
        store.clearSkipped(track.songKey)
        return enqueue([track], front: true)
    }

    /// Download failed on the device: try again from scratch (resume data is reused when still valid).
    public func retry(songKey: String) {
        guard let job = failedJobs[songKey] else { return }
        enqueue([job.track], front: true)
    }

    public func cancel(songKey: String) {
        queue.removeAll { $0.track.songKey == songKey }
        if active[songKey] != nil {
            userCancelled.insert(songKey)
            transport.cancel(songKey: songKey)
        }
        active.removeValue(forKey: songKey)
        progress.removeValue(forKey: songKey)
        failedJobs.removeValue(forKey: songKey)
        batch.forget(songKey)
        pump()
        persist()
        finishBatchIfDone()
    }

    /// App (re)launch: pick up downloads the background session kept running, and the queue we had not started yet.
    public func attachExisting() async {
        let alive: [JobInfo] = await withCheckedContinuation { continuation in
            transport.reattach { continuation.resume(returning: $0) }
        }
        for info in alive {
            active[info.songKey] = info
            progress[info.songKey] = .downloading(nil)
        }
        if persistQueue, let data = store.readQueueData(),
           let saved = try? JSONDecoder().decode([QueuedJob].self, from: data) {
            for job in saved where active[job.track.songKey] == nil && !queue.contains(where: { $0.track.songKey == job.track.songKey }) {
                // Same rule as a fresh Sync: nothing to download if it arrived meanwhile (non-empty, same size/version)
                // or if the user deleted the song from this phone in the meantime (skip-list).
                let plan = SyncPlanner.plan(tracks: [job.track], local: { store.snapshot(songKey: $0) }, skipped: store.skippedKeys)
                if plan.download.isEmpty { continue }
                queue.append(job)
                progress[job.track.songKey] = .queued
            }
        }
        queueLoaded = true
        pump()
        persist()
        // A song the old sync was waiting for that is neither running nor queued nor failed any more is done with.
        batch.reconcile(stillActive: Set(active.keys).union(queue.map { $0.track.songKey }))
        finishBatchIfDone()
    }

    // MARK: - Queue

    private func pump() {
        while active.count < maxParallel, !queue.isEmpty {
            let job = queue.removeFirst()
            startFirstAttempt(job)
        }
    }

    private func startFirstAttempt(_ job: QueuedJob) {
        let cfg = config()
        let track = job.track
        let candidates = DownloadURLChooser.candidates(for: track, baseURL: cfg.baseURL)
        guard let first = candidates.first else {
            progress[track.songKey] = .failed("nessun indirizzo di download")
            failedJobs[track.songKey] = job
            batch.markFailed(track.songKey, message: "nessun indirizzo di download")
            finishBatchIfDone()
            return
        }
        let info = JobInfo(
            songKey: track.songKey,
            title: track.title,
            artist: track.artist,
            coverUrl: track.coverUrl,
            lyrics: track.lyrics,
            version: track.version,
            bytes: track.bytes,
            plays: track.plays,
            lastPlayedAt: track.lastPlayedAt,
            album: track.album,
            genres: track.genres.isEmpty ? nil : track.genres,
            year: track.year
        )
        failedJobs[track.songKey] = job
        launch(info: info, candidate: first, config: cfg)
    }

    private func launch(info: JobInfo, candidate: DownloadCandidate, config cfg: EngineConfig) {
        active[info.songKey] = info
        progress[info.songKey] = .downloading(nil)
        lastPercent[info.songKey] = nil
        let resume = store.resumeData(songKey: info.songKey, url: candidate.url.absoluteString)
        transport.start(TransportJob(info: info, request: Self.makeRequest(for: candidate, config: cfg), resumeData: resume))
    }

    static func httpFailureMessage(_ status: Int) -> String {
        switch status {
        case 401, 403: return "API key non valida: rinnovala in Impostazioni"
        case 404: return "file non trovato sul server"
        default: return "server: HTTP \(status)"
        }
    }

    /// Wi-Fi only unless the user opted into cellular. The key goes with the request: its host is SoundReel's, always.
    static func makeRequest(for candidate: DownloadCandidate, config: EngineConfig) -> URLRequest {
        var request = URLRequest(url: candidate.url)
        request.httpMethod = "GET"
        request.timeoutInterval = 120
        request.allowsCellularAccess = config.allowCellular
        request.allowsExpensiveNetworkAccess = config.allowCellular
        // Low Data Mode is about background chatter; this is an explicit user action.
        request.allowsConstrainedNetworkAccess = true
        for (name, value) in config.api.authHeaders { request.setValue(value, forHTTPHeaderField: name) }
        return request
    }

    private func persist() {
        guard persistQueue, queueLoaded else { return }
        store.writeQueueData(queue.isEmpty ? nil : try? JSONEncoder().encode(queue))
    }

    // MARK: - Transport callbacks (hop to the main actor)

    nonisolated public func transportProgress(songKey: String, fraction: Double?) {
        Task { @MainActor in self.handleProgress(songKey: songKey, fraction: fraction) }
    }

    nonisolated public func transportFinished(info: JobInfo, stagedFile: URL, httpStatus: Int?) {
        Task { @MainActor in self.handleFinished(info: info, stagedFile: stagedFile, httpStatus: httpStatus) }
    }

    nonisolated public func transportFailed(info: JobInfo, message: String, resumeData: Data?, requestURL: URL?, cancelled: Bool) {
        Task { @MainActor in
            self.handleFailed(info: info, message: message, resumeData: resumeData, requestURL: requestURL, cancelled: cancelled)
        }
    }

    func handleProgress(songKey: String, fraction: Double?) {
        guard active[songKey] != nil else { return }
        let percent = fraction.map { Int(($0 * 100).rounded()) }
        if let percent, lastPercent[songKey] == percent { return }   // one UI update per percent
        lastPercent[songKey] = percent
        progress[songKey] = .downloading(fraction)
    }

    func handleFinished(info: JobInfo, stagedFile: URL, httpStatus: Int?) {
        let fm = FileManager.default
        if let status = httpStatus, !(200..<300).contains(status) {
            try? fm.removeItem(at: stagedFile)
            processFailure(info: info, message: Self.httpFailureMessage(status), resumeData: nil, requestURL: nil)
            return
        }
        let size = ((try? fm.attributesOfItem(atPath: stagedFile.path))?[.size] as? NSNumber)?.intValue ?? 0
        if size <= 0 {
            try? fm.removeItem(at: stagedFile)
            processFailure(info: info, message: "file vuoto", resumeData: nil, requestURL: nil)
            return
        }
        if let expected = info.bytes, size != expected {
            // Truncated, or not the file the manifest described: never record it. The row fails visibly, «Riprova» asks again.
            try? fm.removeItem(at: stagedFile)
            processFailure(
                info: info,
                message: "dimensione diversa dal server (\(size) invece di \(expected) byte)",
                resumeData: nil,
                requestURL: nil
            )
            return
        }
        do {
            try store.install(
                stagedFile: stagedFile,
                songKey: info.songKey,
                metadata: InstallMetadata(
                    title: info.title,
                    artist: info.artist,
                    coverURL: info.coverUrl,
                    lyrics: info.lyrics,
                    version: info.version,
                    plays: info.plays,
                    lastPlayedAt: ISO.parse(info.lastPlayedAt),
                    album: info.album,
                    genres: info.genres ?? [],
                    year: info.year
                )
            )
            store.clearResumeData(songKey: info.songKey)
            active.removeValue(forKey: info.songKey)
            failedJobs.removeValue(forKey: info.songKey)
            progress.removeValue(forKey: info.songKey)
            lastPercent.removeValue(forKey: info.songKey)
            revision += 1
            batch.markInstalled(info.songKey)
        } catch {
            try? fm.removeItem(at: stagedFile)
            active.removeValue(forKey: info.songKey)
            progress[info.songKey] = .failed("salvataggio non riuscito")
            batch.markFailed(info.songKey, message: "salvataggio non riuscito")
        }
        pump()
        persist()
        finishBatchIfDone()
    }

    func handleFailed(info: JobInfo, message: String, resumeData: Data?, requestURL: URL?, cancelled: Bool) {
        if cancelled, userCancelled.remove(info.songKey) != nil {
            pump()
            return   // the user asked for it (cancel() already cleaned up)
        }
        processFailure(info: info, message: message, resumeData: resumeData, requestURL: requestURL)
    }

    /// A failed download is a failure: there is one address (SoundReel), so there is nothing else to try. The row says why
    /// and «Riprova» starts again (with the resume data when the system gave some).
    private func processFailure(info: JobInfo, message: String, resumeData: Data?, requestURL: URL?) {
        if let resumeData, let requestURL {
            store.saveResumeData(resumeData, songKey: info.songKey, url: requestURL.absoluteString)
        }
        active.removeValue(forKey: info.songKey)
        progress[info.songKey] = .failed(message)
        lastPercent.removeValue(forKey: info.songKey)
        batch.markFailed(info.songKey, message: message)
        pump()
        persist()
        finishBatchIfDone()
    }

    // MARK: - «Sync finito»

    private func persistBatch() {
        guard persistQueue else { return }
        store.writeBatchData(batch.isEmpty ? nil : try? JSONEncoder.batch.encode(batch))
    }

    /// Saves the batch, and if everything the sync queued has settled → says so once and starts from a clean batch.
    private func finishBatchIfDone() {
        guard batch.isFinished else {
            persistBatch()
            return
        }
        let summary = batch.summary
        batch = SyncBatch()
        persistBatch()
        onBatchFinished?(summary)
    }
}

private extension JSONEncoder {
    static var batch: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

private extension JSONDecoder {
    static var batch: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
