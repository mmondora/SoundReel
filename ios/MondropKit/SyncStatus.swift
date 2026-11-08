// SyncStatus.swift — «che cosa sta succedendo» (spec 2026-11-08-player-selection-and-filters §X3).
//
// Three small pieces, all pure or nearly:
//   • `TrackRowStatus` gets what a row needs to look right: a spinner (with the percent) while the server prepares
//     the song or the phone downloads it, a ready mark when it is on the phone, and a clear word for the rest;
//   • `SyncStatusLine` builds the line at the top («Preparo 3 brani sul server · 1 in download dal telefono»);
//   • `SyncActivity` remembers which songs the server was last seen preparing (the phone only learns it by asking).

import Foundation

// MARK: - Row

extension TrackRowStatus {
    /// What stands next to the song.
    public enum Accessory: Equatable, Sendable {
        /// The server is preparing it, or the phone is downloading it (the percent, when known, is `percent`).
        case spinner
        /// On the phone: the ready mark.
        case done
        /// Ready on the server, not on the phone yet.
        case cloud
        /// Waiting its turn in the download queue.
        case queued
        /// «da cercare»: the server found no source.
        case search
        case error
        /// Deleted from this phone on purpose.
        case removed
        /// Never asked for.
        case pending
    }

    public var accessory: Accessory {
        switch kind {
        case .downloading, .preparing: return .spinner
        case .local: return .done
        case .readyOnServer: return .cloud
        case .queued: return .queued
        case .noSource: return .search
        case .failed: return .error
        case .removedFromPhone: return .removed
        case .missing: return .pending
        }
    }

    /// The transfer percentage while the phone downloads the song (0…100); nil when the size is not known yet or
    /// the song is in any other state.
    public var percent: Int? {
        guard case .downloading(let fraction?) = kind else { return nil }
        return Int((min(max(fraction, 0), 1) * 100).rounded())
    }

    /// The line under the title. `label` keeps the contract wording; a song the server found no source for says
    /// «da cercare» first, the word Michele asked for.
    public var rowText: String {
        switch kind {
        case .noSource: return "da cercare · \(label)"
        default: return label
        }
    }

    /// A spinner is turning for this song.
    public var isBusy: Bool { accessory == .spinner }
}

// MARK: - Line at the top

public struct SyncStatusCounts: Equatable, Sendable {
    /// Songs the server is preparing (seen recently — see `SyncActivity`).
    public var preparingOnServer: Int
    /// Songs the phone is downloading right now.
    public var downloading: Int
    /// Songs waiting for a free download slot.
    public var queued: Int
    /// Downloads that failed on the phone.
    public var failed: Int
    /// Cellular is off and the phone is on a metered network: downloads wait for Wi-Fi.
    public var waitingForWifi: Bool

    public init(preparingOnServer: Int = 0, downloading: Int = 0, queued: Int = 0, failed: Int = 0, waitingForWifi: Bool = false) {
        self.preparingOnServer = preparingOnServer
        self.downloading = downloading
        self.queued = queued
        self.failed = failed
        self.waitingForWifi = waitingForWifi
    }

    /// Something is actually moving (a spinner makes sense); «in coda» and errors alone are not work in progress.
    public var isWorking: Bool { preparingOnServer > 0 || downloading > 0 }

    /// What the download engine reports, plus what the server is preparing.
    public init(progress: [String: TrackProgress], preparingOnServer: Int, waitingForWifi: Bool = false) {
        var downloading = 0
        var queued = 0
        var failed = 0
        for state in progress.values {
            switch state {
            case .downloading: downloading += 1
            case .queued: queued += 1
            case .failed: failed += 1
            }
        }
        self.init(
            preparingOnServer: preparingOnServer, downloading: downloading, queued: queued, failed: failed,
            waitingForWifi: waitingForWifi
        )
    }
}

public enum SyncStatusLine {
    /// nil when nothing is going on (the line is simply not shown).
    public static func make(_ c: SyncStatusCounts) -> String? {
        var parts: [String] = []
        if c.waitingForWifi && c.downloading + c.queued > 0 { parts.append("In attesa del Wi-Fi") }
        if c.preparingOnServer > 0 {
            parts.append("Preparo \(c.preparingOnServer) \(c.preparingOnServer == 1 ? "brano" : "brani") sul server")
        }
        if c.downloading > 0 { parts.append("\(c.downloading) in download dal telefono") }
        if c.queued > 0 { parts.append("\(c.queued) in coda") }
        if c.failed > 0 { parts.append("\(c.failed) \(c.failed == 1 ? "errore" : "errori")") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

// MARK: - What the server is doing

/// The phone cannot see the server's queue; it only learns that a song is `preparing` when it reads a manifest, a
/// library page, or waits for a first play. This remembers the last sighting, and forgets it after a while: a song
/// the app stopped watching must not stay «in preparazione» for ever.
@MainActor
public final class SyncActivity: ObservableObject {
    public static let shared = SyncActivity()

    /// songKey → when the server was last seen preparing it.
    @Published public private(set) var preparing: [String: Date] = [:]

    private let now: () -> Date
    /// Longer than the 5 s polling interval by a wide margin, shorter than anyone would believe a stale line.
    public let maxAge: TimeInterval

    public init(now: @escaping () -> Date = { Date() }, maxAge: TimeInterval = 120) {
        self.now = now
        self.maxAge = maxAge
    }

    /// A reading of the server: the `preparing` songs are noted, every other song is not preparing any more.
    public func observe(_ tracks: [OfflineTrack]) {
        let at = now()
        var next = preparing
        for track in tracks {
            if track.resolvedState == .preparing {
                next[track.songKey] = at
            } else {
                next.removeValue(forKey: track.songKey)
            }
        }
        if next != preparing { preparing = next }
    }

    /// The song the user is waiting for (first play) is being prepared / is done with.
    public func markPreparing(_ songKey: String) { preparing[songKey] = now() }
    public func clear(_ songKey: String) {
        if preparing[songKey] != nil { preparing.removeValue(forKey: songKey) }
    }

    /// Songs seen preparing recently.
    public func preparingCount() -> Int {
        let cutoff = now().addingTimeInterval(-maxAge)
        return preparing.values.filter { $0 >= cutoff }.count
    }

    public func reset() { preparing = [:] }
}
