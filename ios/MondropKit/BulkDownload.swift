// BulkDownload.swift — «Scarica tutti» after a search (Michele, 8 November: «In mondrop voglio anche poter scaricare tutto dopo una
// ricerca. E il play non deve essere automatico»; spec 2026-11-08-mondrop-bulk-download-design.md).
//
// The songs of a search (the results, an artist's page, an album's page) can be put on the phone in one go. What there is to do is
// worked out first, from the same planner the Sync uses (`SyncPlanner`: what is there already, what is ready, what the server has
// to get first, what the user once removed on purpose), and SHOWN to the user before anything starts: «Scaricare 87 brani?». Then:
// the songs the server has ready go to the download engine; the others are ASKED of the server (it prepares them, two at a time),
// and the screen picks them up as they become ready. It never starts the player: a download is not a play.

import Foundation

public enum BulkDownload {
    /// The most songs one press takes: the biggest answer the server gives in one go (a page of 200: about a gigabyte).
    public static let maxTracks = SearchQuery.maxLimit
    /// How many songs are asked of the server at once: each request is small, the work is the server's.
    static let parallelRequests = 6

    /// What there is to do with the songs of a search, worked out BEFORE asking the user.
    public struct Plan: Equatable, Sendable {
        /// The songs considered: the first `maxTracks` of the search.
        public let tracks: [OfflineTrack]
        /// How many songs the search found (more than `tracks` when it was cut).
        public let found: Int
        /// What the engine would do with them (`SyncEngine.plan`).
        public let sync: SyncPlan

        public init(tracks: [OfflineTrack], found: Int, sync: SyncPlan) {
            self.tracks = tracks
            self.found = found
            self.sync = sync
        }

        /// Ready on the server and not on the phone: queued at once.
        public var ready: [OfflineTrack] { sync.download }
        /// The size of those (only the ones that say it).
        public var bytes: Int { ready.compactMap(\.bytes).reduce(0, +) }
        /// The server has to get them first: they are asked for, and come by themselves when they are ready.
        public var toPrepare: [String] { sync.missing + sync.failed }
        /// The server is already getting them (a first play asked for one).
        public var preparing: Int { sync.preparing.count }
        public var alreadyThere: Int { sync.skipped.count }
        public var onTheWay: Int { sync.inFlight.count }
        /// Deleted from this phone on purpose: they stay out (deleting is a deliberate act, a bulk download does not undo it).
        public var removedByUser: Int { sync.removedByUser.count }
        public var cannot: Int { sync.noSource.count }
        public var cut: Int { max(0, found - tracks.count) }

        /// How many songs will end up on the phone because of this press.
        public var coming: Int { ready.count + toPrepare.count + preparing }
        public var worthAsking: Bool { coming > 0 }

        public var question: String {
            coming == 1 ? "Scaricare 1 brano sul telefono?" : "Scaricare \(coming) brani sul telefono?"
        }

        /// The details under the question: where the songs are, what stays out.
        public var details: String {
            var lines: [String] = []
            if !ready.isEmpty {
                let size = bytes > 0 ? " (circa \(Self.size(bytes)))" : ""
                lines.append("\(ready.count) \(ready.count == 1 ? "pronto" : "pronti") sul server\(size)")
            }
            let waiting = toPrepare.count + preparing
            if waiting > 0 {
                lines.append(waiting == 1 ? "1 da preparare sul server: arriva da solo, ci vuole un po'" : "\(waiting) da preparare sul server: arrivano da soli, ci vuole un po'")
            }
            if alreadyThere > 0 { lines.append("\(alreadyThere) già sul telefono") }
            if onTheWay > 0 { lines.append("\(onTheWay) già in arrivo") }
            if removedByUser > 0 { lines.append("\(removedByUser) li hai tolti dal telefono: restano fuori") }
            if cannot > 0 { lines.append("\(cannot) senza sorgente: non si possono scaricare") }
            if cut > 0 { lines.append("La ricerca ne ha trovati \(found): scarico i primi \(tracks.count). Restringi la ricerca per gli altri.") }
            return lines.joined(separator: "\n")
        }

        /// The line when there is nothing to do.
        public var nothingMessage: String {
            if tracks.isEmpty { return "Nessun brano da scaricare" }
            if alreadyThere == tracks.count { return tracks.count == 1 ? "È già sul telefono" : "Sono già tutti sul telefono" }
            let reasons = details.components(separatedBy: "\n").filter { !$0.isEmpty }
            return reasons.isEmpty ? "Niente da scaricare" : "Niente da scaricare: " + reasons.joined(separator: " · ")
        }

        static func size(_ bytes: Int) -> String {
            ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
        }
    }

    /// What happened when the user said yes.
    public struct Outcome: Equatable, Sendable {
        /// Handed to the download engine now.
        public var queued: Int
        /// Asked of the server (it prepares them).
        public var asked: Int
        /// Asked of the server and refused or unreachable.
        public var askFailed: Int

        public var message: String {
            var parts: [String] = []
            if queued > 0 { parts.append(queued == 1 ? "Scarico 1 brano sul telefono" : "Scarico \(queued) brani sul telefono") }
            if asked > 0 { parts.append(asked == 1 ? "1 in preparazione sul server: arriva da solo" : "\(asked) in preparazione sul server: arrivano da soli") }
            if askFailed > 0 { parts.append(askFailed == 1 ? "1 non richiesto (errore)" : "\(askFailed) non richiesti (errore)") }
            return parts.isEmpty ? "Niente da scaricare" : parts.joined(separator: ". ")
        }
    }

    /// «Scarica» was pressed: the ready songs go to the engine, the others are asked of the server, a few at a time. Never plays.
    @MainActor
    public static func run(
        _ plan: Plan,
        enqueue: ([OfflineTrack]) -> Void,
        prepare: @escaping @Sendable (String) async throws -> Void
    ) async -> Outcome {
        if !plan.ready.isEmpty { enqueue(plan.ready) }
        var asked = 0
        var failed = 0
        var keys = plan.toPrepare.makeIterator()
        await withTaskGroup(of: Bool.self) { group in
            for _ in 0..<parallelRequests {
                guard let key = keys.next() else { break }
                group.addTask { (try? await prepare(key)) != nil }
            }
            for await ok in group {
                if ok { asked += 1 } else { failed += 1 }
                if !Task.isCancelled, let key = keys.next() {
                    group.addTask { (try? await prepare(key)) != nil }
                }
            }
        }
        return Outcome(queued: plan.ready.count, asked: asked, askFailed: failed)
    }
}
