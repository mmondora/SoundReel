// SyncPlanner.swift — pure decisions of the sync: which URL to use, what to download, what to skip.

import Foundation

/// Where a download or a stream comes from: SoundReel, and nothing else (rule P, ADR-0018). The app never talks to the
/// media server or to any other store; that the files live on several of them is the server's business.
public struct DownloadCandidate: Equatable, Sendable {
    /// `<backend>/api/mondrop/songs/<key>/file`. The API key goes with it, and only to this host.
    public let url: URL
}

public enum DownloadURLChooser {
    /// The attempts for a track: the SoundReel proxy (`downloadPath`), which is always valid for a ready track.
    /// Whatever else a manifest may carry about where a file could be is never read.
    public static func candidates(for track: OfflineTrack, baseURL: String) -> [DownloadCandidate] {
        guard let proxy = proxyURL(path: proxyPath(for: track), baseURL: baseURL) else { return [] }
        return [DownloadCandidate(url: proxy)]
    }

    /// The contract sends a path relative to the backend. An absolute URL there would make the app
    /// hand its API key to an arbitrary host, so it is ignored in favour of the canonical path.
    public static func proxyPath(for track: OfflineTrack) -> String {
        if let raw = track.downloadPath?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
           !raw.contains("://"), !raw.hasPrefix("//") {
            return raw.hasPrefix("/") ? raw : "/" + raw
        }
        return MondropAPI.songPath(track.songKey, suffix: "/file")
    }

    public static func proxyURL(path: String, baseURL: String) -> URL? {
        let base = baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/ \n"))
        guard !base.isEmpty else { return nil }
        return URL(string: base + path)
    }
}

public struct SyncPlan: Equatable, Sendable {
    /// Ready on the server and missing/outdated on the device.
    public var download: [OfflineTrack] = []
    /// songKeys whose local file already matches the server (size): remember the version, no download.
    public var adopt: [String] = []
    /// Present and up to date.
    public var skipped: [String] = []
    public var inFlight: [String] = []
    public var preparing: [String] = []
    public var failed: [String] = []
    public var noSource: [String] = []
    public var missing: [String] = []
    /// Ready on the server but the user deleted them from this phone: Sync leaves them alone until "Riscarica".
    public var removedByUser: [String] = []

    public init() {}
}

public enum SyncPlanner {
    /// Never re-downloads needlessly: one local file serves every playlist that contains the song.
    public static func plan(
        tracks: [OfflineTrack],
        local: (String) -> LocalSnapshot?,
        inFlight: Set<String> = [],
        skipped: Set<String> = []
    ) -> SyncPlan {
        var plan = SyncPlan()
        var seen = Set<String>()
        for track in tracks {
            let key = track.songKey
            guard seen.insert(key).inserted else { continue }   // a song twice in a playlist: once
            switch track.resolvedState {
            case .preparing:
                plan.preparing.append(key)
            case .failed:
                plan.failed.append(key)
            case .noSource:
                plan.noSource.append(key)
            case .missing:
                plan.missing.append(key)
            case .ready:
                if inFlight.contains(key) {
                    plan.inFlight.append(key)
                    continue
                }
                // Present = on disk, NOT EMPTY, and — when the manifest knows `bytes` — the very same size.
                // The version string alone is not enough: the backend deployed before Phase 1 served 200 with
                // Content-Length 0, so the old app "downloaded" (and indexed) empty MP3s.
                guard let have = local(key), (have.bytes ?? 0) > 0 else {
                    if skipped.contains(key) {
                        plan.removedByUser.append(key)    // deleted on purpose to save space: not coming back by itself
                    } else {
                        plan.download.append(track)
                    }
                    continue
                }
                if let serverBytes = track.bytes, have.bytes != serverBytes {
                    plan.download.append(track)       // truncated / different file: replace
                    continue
                }
                guard let serverVersion = track.version else {
                    plan.skipped.append(key)          // old server, no version: non-empty (and same size if known) → keep
                    continue
                }
                if have.version == serverVersion {
                    plan.skipped.append(key)
                } else if have.version == nil, have.fileExtension == "mp3", track.bytes != nil {
                    // pre-Phase-2 file whose size matches the server's (checked above): it is the same MP3
                    plan.adopt.append(key)
                    plan.skipped.append(key)
                } else {
                    plan.download.append(track)       // new version on the server (or an old wav/mp4): replace
                }
            }
        }
        return plan
    }
}

/// What a track row shows. Pure, so the wording and the available actions are testable.
public struct TrackRowStatus: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case local
        case downloading(Double?)
        case queued
        case preparing
        case readyOnServer
        /// Deleted from this phone by the user (skip-list): shows "Riscarica".
        case removedFromPhone
        case failed
        case noSource
        case missing
    }

    public let kind: Kind
    public let label: String
    /// A retry makes sense (device download failed, or the server failed / found no source).
    public let canRetry: Bool
    /// Offer "paste a YouTube link" (`PUT …/source`).
    public let canSetSource: Bool
    /// Offer "Riscarica" (the song is on the skip-list).
    public let canRedownload: Bool

    private init(kind: Kind, label: String, canRetry: Bool, canSetSource: Bool, canRedownload: Bool = false) {
        self.kind = kind
        self.label = label
        self.canRetry = canRetry
        self.canSetSource = canSetSource
        self.canRedownload = canRedownload
    }

    public static func make(track: OfflineTrack, isLocal: Bool, progress: TrackProgress?, isSkipListed: Bool = false) -> TrackRowStatus {
        switch progress {
        case .downloading(let fraction)?:
            let label = fraction.map { "scarico \(Int(($0 * 100).rounded())) %" } ?? "scarico…"
            return TrackRowStatus(kind: .downloading(fraction), label: label, canRetry: false, canSetSource: false)
        case .queued?:
            return TrackRowStatus(kind: .queued, label: "in coda", canRetry: false, canSetSource: false)
        case .failed(let message)?:
            return TrackRowStatus(kind: .failed, label: "errore: \(message)", canRetry: true, canSetSource: false)
        case nil:
            break
        }
        if isLocal {
            return TrackRowStatus(kind: .local, label: "scaricato", canRetry: false, canSetSource: false)
        }
        if isSkipListed, track.resolvedState == .ready {
            return TrackRowStatus(kind: .removedFromPhone, label: "rimossa dal telefono", canRetry: false, canSetSource: false, canRedownload: true)
        }
        switch track.resolvedState {
        case .ready:
            return TrackRowStatus(kind: .readyOnServer, label: "pronto da scaricare", canRetry: false, canSetSource: false)
        case .preparing:
            return TrackRowStatus(kind: .preparing, label: "preparo sul server…", canRetry: false, canSetSource: false)
        case .failed:
            let reason = track.error.map { ": \($0)" } ?? ""
            return TrackRowStatus(kind: .failed, label: "errore server\(reason)", canRetry: true, canSetSource: true)
        case .noSource:
            // Retry = `prepare` with retryFailed (the server searches again); or hand it a YouTube link.
            return TrackRowStatus(kind: .noSource, label: "nessuna sorgente trovata", canRetry: true, canSetSource: true)
        case .missing:
            return TrackRowStatus(kind: .missing, label: "da preparare", canRetry: false, canSetSource: false)
        }
    }
}
