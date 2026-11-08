// FirstPlay.swift — "first play" rule: a track already on the device plays from the local file;
// otherwise it plays NOW by streaming and is downloaded in parallel, so the next play is local.
// Pure decisions + the "wait until the server has prepared it" loop (no AVPlayer in here).

import Foundation

/// Where an AVPlayer item can be loaded from.
public struct PlaybackSource: Equatable, Sendable {
    public let url: URL
    /// Auth headers for the proxy; EMPTY for the media server and for local files.
    public let headers: [String: String]
    /// nil = a file on the device.
    public let kind: DownloadCandidate.Kind?

    public var isLocal: Bool { kind == nil }

    public init(url: URL, headers: [String: String], kind: DownloadCandidate.Kind?) {
        self.url = url
        self.headers = headers
        self.kind = kind
    }
}

public enum FirstPlayDecision: Equatable, Sendable {
    /// Already downloaded: play the file.
    case local(URL)
    /// The server has it: stream from the first source (fall back to the next if it fails) and
    /// enqueue `download` at the front of the sync queue.
    case stream(sources: [PlaybackSource], download: OfflineTrack)
    /// Same, but the user deleted this song from the phone to save space: play it, do NOT download it again
    /// (only "Riscarica" brings it back).
    case streamWithoutDownload(sources: [PlaybackSource])
    /// The server does not have it yet: ask for it with priority, wait ("Preparo il brano…"), then stream.
    case prepare(OfflineTrack)
    case unavailable(String)
}

public enum FirstPlay {
    public static func decide(
        songKey: String,
        track: OfflineTrack?,
        local: URL?,
        home: Bool,
        config: MondropAPIConfig,
        skipListed: Bool = false
    ) -> FirstPlayDecision {
        if let local { return .local(local) }
        guard let track else {
            return .unavailable("brano non scaricato e senza informazioni dal server")
        }
        switch track.resolvedState {
        case .ready:
            let sources = streamSources(for: track, home: home, config: config)
            if sources.isEmpty { return .unavailable("nessun indirizzo per l'ascolto") }
            return skipListed ? .streamWithoutDownload(sources: sources) : .stream(sources: sources, download: track)
        case .preparing, .missing, .failed:
            // The user explicitly pressed play: (re)ask the server instead of giving up on a `failed` track.
            return .prepare(track)
        case .noSource:
            return .unavailable("nessuna sorgente trovata: incolla un link YouTube nella playlist")
        }
    }

    /// Media server first at home (no auth headers), then the proxy (with auth). Same order as downloads.
    public static func streamSources(for track: OfflineTrack, home: Bool, config: MondropAPIConfig) -> [PlaybackSource] {
        DownloadURLChooser.candidates(for: track, home: home, baseURL: config.baseURL).map {
            PlaybackSource(url: $0.url, headers: $0.sendsAuth ? config.authHeaders : [:], kind: $0.kind)
        }
    }
}

public struct PreparationClock: @unchecked Sendable {
    public var sleep: (TimeInterval) async throws -> Void
    public var now: () -> Date

    public init(sleep: @escaping (TimeInterval) async throws -> Void, now: @escaping () -> Date) {
        self.sleep = sleep
        self.now = now
    }

    public static let real = PreparationClock(
        sleep: { seconds in try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000)) },
        now: { Date() }
    )
}

public enum PlaybackPreparationError: Error, Equatable, CustomStringConvertible {
    case unavailable(String)
    case timedOut

    public var description: String {
        switch self {
        case .unavailable(let reason): return reason
        case .timedOut: return "il server ci sta mettendo troppo a preparare il brano"
        }
    }
}

public enum PlaybackPreparation {
    /// `POST …/download {"priority":"play"}`, then `GET …/songs/:key` every `pollInterval` until the track is
    /// ready. Cancelling the surrounding Task (the user skipped) stops the loop.
    public static func awaitReady(
        _ track: OfflineTrack,
        api: MondropAPIProtocol,
        clock: PreparationClock = .real,
        pollInterval: TimeInterval = 2,
        timeout: TimeInterval = 180
    ) async throws -> OfflineTrack {
        let ack = try await api.requestDownload(songKey: track.songKey, priority: .play)
        var current: OfflineTrack
        if let acked = ack.track {
            current = acked
        } else {
            current = try await api.track(songKey: track.songKey)
        }
        let started = clock.now()
        var consecutiveErrors = 0
        while true {
            try Task.checkCancellation()
            switch current.resolvedState {
            case .ready:
                return current
            case .failed:
                throw PlaybackPreparationError.unavailable(current.error ?? "preparazione non riuscita sul server")
            case .noSource:
                throw PlaybackPreparationError.unavailable(current.error ?? "nessuna sorgente trovata per questo brano")
            case .preparing, .missing:
                break
            }
            if clock.now().timeIntervalSince(started) >= timeout { throw PlaybackPreparationError.timedOut }
            try await clock.sleep(pollInterval)
            try Task.checkCancellation()
            do {
                current = try await api.track(songKey: track.songKey)
                consecutiveErrors = 0
            } catch {
                if error is CancellationError { throw error }
                consecutiveErrors += 1
                if consecutiveErrors >= 3 { throw error }   // a single network blip must not kill the wait
            }
        }
    }
}

/// The line under the title in the player. Pure, so the wording is testable.
public enum PlaybackStatusText {
    public static func make(status: PlaybackStatus, progress: TrackProgress?) -> (text: String, isError: Bool)? {
        switch status {
        case .idle:
            return nil
        case .preparing:
            return ("Preparo il brano…", false)
        case .local:
            return ("Dal telefono", false)
        case .failed(let message):
            return (message, true)
        case .streaming:
            switch progress {
            case .downloading(let fraction)?:
                if let fraction { return ("In streaming · scarico \(Int((fraction * 100).rounded())) %", false) }
                return ("In streaming · scarico…", false)
            case .queued?:
                return ("In streaming · download in coda", false)
            case .failed(let message)?:
                return ("In streaming · download non riuscito: \(message)", false)
            case nil:
                return ("In streaming", false)
            }
        }
    }
}
