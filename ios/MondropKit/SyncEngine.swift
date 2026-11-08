// SyncEngine.swift — the download queue of the sync: at most 2 downloads at a time, skip-present,
// media-server → proxy fallback, resume data, installs into the OfflineStore.
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
/// file and fall back to the proxy for a download it did not start in this process.
public struct JobInfo: Codable, Equatable, Sendable {
    public var songKey: String
    public var title: String
    public var artist: String
    public var coverUrl: String?
    public var lyrics: String?
    public var version: String?
    public var bytes: Int?
    /// `DownloadCandidate.Kind.rawValue` of THIS attempt.
    public var kind: String
    /// Relative proxy path to retry with when a media-server attempt fails.
    public var proxyPath: String?
    /// Server numbers at the time of the download (docs/mondrop-stats.md §3); optional like every new field.
    public var plays: Int?
    public var lastPlayedAt: String?

    public init(
        songKey: String, title: String, artist: String, coverUrl: String? = nil, lyrics: String? = nil,
        version: String? = nil, bytes: Int? = nil, kind: String, proxyPath: String? = nil,
        plays: Int? = nil, lastPlayedAt: String? = nil
    ) {
        self.songKey = songKey
        self.title = title
        self.artist = artist
        self.coverUrl = coverUrl
        self.lyrics = lyrics
        self.version = version
        self.bytes = bytes
        self.kind = kind
        self.proxyPath = proxyPath
        self.plays = plays
        self.lastPlayedAt = lastPlayedAt
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

struct QueuedJob: Codable, Equatable {
    var track: OfflineTrack
    var home: Bool
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

    public init(
        transport: DownloadTransport,
        store: OfflineStore,
        config: @escaping () -> EngineConfig,
        persistQueue: Bool = false
    ) {
        self.transport = transport
        self.store = store
        self.config = config
        self.persistQueue = persistQueue
        transport.handler = self
    }

    public var activeCount: Int { active.count }
    public var queuedCount: Int { queue.count }

    // MARK: - Public API

    /// Plans (skip-present / adopt / download) and queues the downloads. Idempotent.
    @discardableResult
    public func enqueue(_ tracks: [OfflineTrack], home: Bool, front: Bool = false) -> SyncPlan {
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
        let jobs = plan.download.map { QueuedJob(track: $0, home: home) }
        for job in jobs {
            failedJobs.removeValue(forKey: job.track.songKey)
            progress[job.track.songKey] = .queued
        }
        if front { queue.insert(contentsOf: jobs, at: 0) } else { queue.append(contentsOf: jobs) }
        pump()
        persist()
        return plan
    }

    /// "Riscarica": the user wants a song they deleted back on the phone. Clears the skip-list entry, then downloads
    /// it ahead of the queue.
    @discardableResult
    public func redownload(_ track: OfflineTrack, home: Bool) -> SyncPlan {
        store.clearSkipped(track.songKey)
        return enqueue([track], home: home, front: true)
    }

    /// Download failed on the device: try again from scratch (resume data is reused when still valid).
    public func retry(songKey: String) {
        guard let job = failedJobs[songKey] else { return }
        enqueue([job.track], home: job.home, front: true)
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
        pump()
        persist()
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
        pump()
        persist()
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
        let candidates = DownloadURLChooser.candidates(for: track, home: job.home, baseURL: cfg.baseURL)
        guard let first = candidates.first else {
            progress[track.songKey] = .failed("nessun indirizzo di download")
            failedJobs[track.songKey] = job
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
            kind: first.kind.rawValue,
            proxyPath: first.kind == .media ? DownloadURLChooser.proxyPath(for: track) : nil,
            plays: track.plays,
            lastPlayedAt: track.lastPlayedAt
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

    /// Wi-Fi only unless the user opted into cellular; the key is attached to the proxy path only.
    static func makeRequest(for candidate: DownloadCandidate, config: EngineConfig) -> URLRequest {
        var request = URLRequest(url: candidate.url)
        request.httpMethod = "GET"
        request.timeoutInterval = 120
        request.allowsCellularAccess = config.allowCellular
        request.allowsExpensiveNetworkAccess = config.allowCellular
        // Low Data Mode is about background chatter; this is an explicit user action.
        request.allowsConstrainedNetworkAccess = true
        if candidate.sendsAuth {
            for (name, value) in config.api.authHeaders { request.setValue(value, forHTTPHeaderField: name) }
        }
        return request
    }

    private func persist() {
        guard persistQueue else { return }
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
            // Truncated, or not the file the manifest described (e.g. a stale replica on the media server):
            // never record it. A media-server attempt falls back to downloadPath, a proxy attempt fails visibly.
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
                    lastPlayedAt: ISO.parse(info.lastPlayedAt)
                )
            )
            store.clearResumeData(songKey: info.songKey)
            active.removeValue(forKey: info.songKey)
            failedJobs.removeValue(forKey: info.songKey)
            progress.removeValue(forKey: info.songKey)
            lastPercent.removeValue(forKey: info.songKey)
            revision += 1
        } catch {
            try? fm.removeItem(at: stagedFile)
            active.removeValue(forKey: info.songKey)
            progress[info.songKey] = .failed("salvataggio non riuscito")
        }
        pump()
        persist()
    }

    func handleFailed(info: JobInfo, message: String, resumeData: Data?, requestURL: URL?, cancelled: Bool) {
        if cancelled, userCancelled.remove(info.songKey) != nil {
            pump()
            return   // the user asked for it (cancel() already cleaned up)
        }
        processFailure(info: info, message: message, resumeData: resumeData, requestURL: requestURL)
    }

    /// A media-server attempt that fails (permission denied, timeout, non-2xx) gets one more try via the proxy.
    private func processFailure(info: JobInfo, message: String, resumeData: Data?, requestURL: URL?) {
        if info.kind == DownloadCandidate.Kind.media.rawValue, let path = info.proxyPath {
            let cfg = config()
            if let url = DownloadURLChooser.proxyURL(path: path, baseURL: cfg.baseURL) {
                var next = info
                next.kind = DownloadCandidate.Kind.proxy.rawValue
                next.proxyPath = nil
                launch(info: next, candidate: DownloadCandidate(kind: .proxy, url: url), config: cfg)
                return
            }
        }
        if let resumeData, let requestURL {
            store.saveResumeData(resumeData, songKey: info.songKey, url: requestURL.absoluteString)
        }
        active.removeValue(forKey: info.songKey)
        progress[info.songKey] = .failed(message)
        lastPercent.removeValue(forKey: info.songKey)
        pump()
        persist()
    }
}
