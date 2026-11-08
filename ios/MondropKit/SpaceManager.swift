// SpaceManager.swift — "Spazio": what the downloaded songs weigh, which ones are the least listened, and how to
// delete them safely (docs/mondrop-stats.md §2–§3, decisions D7–D9).
//
// Everything that decides is pure and tested: the ordering ("meno ascoltate"), the shortcuts, the confirmation state
// machine (one confirmation for one song, TWO for any block), the dialog wording and the `delete_songs` payload.
// `SongDeleter` writes the event to the durable queue BEFORE a single file is removed.

import Foundation

public struct SpaceRow: Identifiable, Equatable, Sendable {
    public var id: String { songKey }
    public let songKey: String
    public let title: String
    public let artist: String
    /// Size on disk.
    public let bytes: Int
    /// Counted listens: all devices (server) + this phone's not-yet-acknowledged ones.
    public let plays: Int
    public let lastPlayedAt: Date?
    public let addedAt: Date?

    public init(songKey: String, title: String, artist: String, bytes: Int, plays: Int, lastPlayedAt: Date?, addedAt: Date?) {
        self.songKey = songKey
        self.title = title
        self.artist = artist
        self.bytes = bytes
        self.plays = plays
        self.lastPlayedAt = lastPlayedAt
        self.addedAt = addedAt
    }
}

public enum SpaceSort: String, CaseIterable, Identifiable, Sendable {
    /// Default (D9): fewest counted plays first, then the oldest last play; never played first.
    case leastPlayed
    case largest
    case oldest
    case name

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .leastPlayed: return "Meno ascoltate"
        case .largest: return "Più pesanti"
        case .oldest: return "Più vecchie"
        case .name: return "Nome"
        }
    }
}

public enum SpaceRanking {
    /// D9: counted plays ascending; then the OLDEST last play (never played = oldest of all); then the one that has
    /// been on the phone longest; then the key, so the order is the same every time.
    static func leastPlayedBefore(_ a: SpaceRow, _ b: SpaceRow) -> Bool {
        if a.plays != b.plays { return a.plays < b.plays }
        let lastA = a.lastPlayedAt ?? .distantPast
        let lastB = b.lastPlayedAt ?? .distantPast
        if lastA != lastB { return lastA < lastB }
        let addedA = a.addedAt ?? .distantPast
        let addedB = b.addedAt ?? .distantPast
        if addedA != addedB { return addedA < addedB }
        return a.songKey < b.songKey
    }

    public static func sorted(_ rows: [SpaceRow], by sort: SpaceSort) -> [SpaceRow] {
        switch sort {
        case .leastPlayed:
            return rows.sorted(by: leastPlayedBefore)
        case .largest:
            return rows.sorted {
                if $0.bytes != $1.bytes { return $0.bytes > $1.bytes }
                return nameBefore($0, $1)
            }
        case .oldest:
            return rows.sorted {
                let a = $0.addedAt ?? .distantPast
                let b = $1.addedAt ?? .distantPast
                if a != b { return a < b }
                return $0.songKey < $1.songKey
            }
        case .name:
            return rows.sorted(by: nameBefore)
        }
    }

    private static func nameBefore(_ a: SpaceRow, _ b: SpaceRow) -> Bool {
        let byTitle = a.title.localizedCaseInsensitiveCompare(b.title)
        if byTitle != .orderedSame { return byTitle == .orderedAscending }
        let byArtist = a.artist.localizedCaseInsensitiveCompare(b.artist)
        if byArtist != .orderedSame { return byArtist == .orderedAscending }
        return a.songKey < b.songKey
    }

    /// "Elimina le N meno ascoltate".
    public static func leastPlayed(_ rows: [SpaceRow], count: Int) -> [SpaceRow] {
        guard count > 0 else { return [] }
        return Array(rows.sorted(by: leastPlayedBefore).prefix(count))
    }

    /// "Libera X MB": least-played songs until at least `bytes` would be freed (the song that crosses the line is
    /// included). If the whole library is smaller than the target, everything is returned.
    public static func toFree(_ rows: [SpaceRow], bytes target: Int) -> [SpaceRow] {
        guard target > 0 else { return [] }
        var taken: [SpaceRow] = []
        var freed = 0
        for row in rows.sorted(by: leastPlayedBefore) {
            taken.append(row)
            freed += row.bytes
            if freed >= target { break }
        }
        return taken
    }

    /// Decimal megabytes, like the byte formatter the UI uses.
    public static func bytes(forMB mb: Int) -> Int { mb * 1_000_000 }
}

// MARK: - Plan + double confirmation

public struct DeletionPlan: Equatable, Sendable {
    public enum Reason: String, Sendable {
        case manual
        case leastPlayed = "least_played"
        case freeSpace = "free_space"
    }

    public let reason: Reason
    public let songs: [SpaceRow]
    /// "Elimina le N meno ascoltate": the N that was asked for.
    public let requestedCount: Int?
    /// "Libera X MB": the target.
    public let freeMB: Int?

    public var count: Int { songs.count }
    public var totalBytes: Int { songs.reduce(0) { $0 + $1.bytes } }

    /// D7: one song = one confirmation; ANY block (more than one song, however it was chosen) = two.
    public var requiredConfirmations: Int { songs.count > 1 ? 2 : 1 }

    public var criteria: DeleteSongsDetails.Criteria {
        DeleteSongsDetails.Criteria(count: requestedCount, olderThanDays: nil, freeMB: freeMB)
    }

    public static func manual(_ songs: [SpaceRow]) -> DeletionPlan {
        DeletionPlan(reason: .manual, songs: songs, requestedCount: nil, freeMB: nil)
    }

    public static func leastPlayed(from rows: [SpaceRow], count: Int) -> DeletionPlan {
        DeletionPlan(reason: .leastPlayed, songs: SpaceRanking.leastPlayed(rows, count: count), requestedCount: count, freeMB: nil)
    }

    public static func freeSpace(from rows: [SpaceRow], mb: Int) -> DeletionPlan {
        DeletionPlan(reason: .freeSpace, songs: SpaceRanking.toFree(rows, bytes: SpaceRanking.bytes(forMB: mb)), requestedCount: nil, freeMB: mb)
    }
}

/// The confirmation flow as a plain state machine (the dialogs are just a view of `stage`).
///
///   idle ──begin──▶ first ──accept──▶ second ──accept──▶ confirmed(2)      (a block)
///                      └──accept──▶ confirmed(1)                            (one song)
///   first / second ──cancel──▶ cancelled                                    (nothing is deleted)
public struct DeletionConfirmation: Equatable, Sendable {
    public enum Stage: Equatable, Sendable {
        case idle
        case first(DeletionPlan)
        case second(DeletionPlan)
        case confirmed(DeletionPlan, confirmations: Int)
        case cancelled
    }

    public private(set) var stage: Stage = .idle

    public init() {}

    /// Ignored while a dialog is already open (no second plan can sneak in) and for an empty plan.
    public mutating func begin(_ plan: DeletionPlan) {
        switch stage {
        case .first, .second: return
        case .idle, .confirmed, .cancelled: break
        }
        stage = plan.songs.isEmpty ? .idle : .first(plan)
    }

    public mutating func accept() {
        switch stage {
        case .first(let plan):
            stage = plan.requiredConfirmations >= 2 ? .second(plan) : .confirmed(plan, confirmations: 1)
        case .second(let plan):
            stage = .confirmed(plan, confirmations: 2)
        case .idle, .confirmed, .cancelled:
            break
        }
    }

    public mutating func cancel() {
        switch stage {
        case .first, .second: stage = .cancelled
        case .idle, .confirmed, .cancelled: break
        }
    }

    public mutating func reset() { stage = .idle }

    public var isAskingFirst: Bool { if case .first = stage { return true } else { return false } }
    public var isAskingSecond: Bool { if case .second = stage { return true } else { return false } }
}

public struct DialogText: Equatable, Sendable {
    public let title: String
    public let message: String
    public let confirmTitle: String
}

public enum DeletionDialogs {
    public static let cancelTitle = "Annulla"

    public static func megabytes(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// «A», «B», «C» e altri 22
    public static func titles(_ songs: [SpaceRow], limit: Int = 3) -> String {
        let shown = songs.prefix(limit).map { "«\($0.title)»" }.joined(separator: ", ")
        let rest = songs.count - limit
        return rest > 0 ? "\(shown) e altri \(rest)" : shown
    }

    public static func first(_ plan: DeletionPlan) -> DialogText {
        if plan.count == 1, let song = plan.songs.first {
            return DialogText(
                title: "Eliminare «\(song.title)»?",
                message: "Libera \(megabytes(plan.totalBytes)) su questo telefono. Resta su SoundReel e il Sync non la riscarica da solo: per riaverla tocca «Riscarica».",
                confirmTitle: "Elimina"
            )
        }
        return DialogText(
            title: "Eliminare \(plan.count) brani?",
            message: "\(plan.count) brani · \(megabytes(plan.totalBytes))\n\(titles(plan.songs))\n\nLi togli solo da questo telefono: restano su SoundReel.",
            confirmTitle: "Continua"
        )
    }

    public static func second(_ plan: DeletionPlan) -> DialogText {
        DialogText(
            title: "Sei sicuro?",
            message: "Non si può annullare. Elimini \(plan.count) brani (\(megabytes(plan.totalBytes))) da questo telefono; la cancellazione viene registrata sul server.",
            confirmTitle: "Elimina \(plan.count) brani"
        )
    }
}

// MARK: - The audit event

extension DeleteSongsDetails {
    /// docs/mondrop-stats.md §2: reason, criteria, confirmations, count, bytes and ONE entry per song.
    public static func make(plan: DeletionPlan, confirmations: Int) -> DeleteSongsDetails {
        DeleteSongsDetails(
            reason: plan.reason.rawValue,
            criteria: plan.criteria,
            confirmations: confirmations,
            count: plan.count,
            bytes: plan.totalBytes,
            songs: plan.songs.map {
                Song(songKey: $0.songKey, title: $0.title, artist: $0.artist, bytes: $0.bytes, plays: $0.plays, lastPlayedAt: $0.lastPlayedAt)
            }
        )
    }
}

@MainActor
public final class SongDeleter {
    public enum DeleteError: Error, Equatable, CustomStringConvertible {
        /// A block was about to be deleted with fewer confirmations than D7 requires.
        case insufficientConfirmations
        /// The audit event could not be written: NOTHING was deleted.
        case eventNotDurable

        public var description: String {
            switch self {
            case .insufficientConfirmations: return "servono due conferme per eliminare più brani"
            case .eventNotDurable: return "non riesco a registrare la cancellazione: non ho eliminato niente"
            }
        }
    }

    public struct Result: Equatable, Sendable {
        public let count: Int
        public let bytes: Int
    }

    private let store: OfflineStore
    private let queue: EventQueue
    private let uploader: EventUploader?
    private let now: () -> Date
    private let makeId: () -> String

    public init(
        store: OfflineStore,
        queue: EventQueue,
        uploader: EventUploader? = nil,
        now: @escaping () -> Date = { Date() },
        makeId: @escaping () -> String = { UUID().uuidString }
    ) {
        self.store = store
        self.queue = queue
        self.uploader = uploader
        self.now = now
        self.makeId = makeId
    }

    /// 1) the `delete_songs` event is written to the durable queue, 2) only then files + index entries go and the songs
    /// are skip-listed, 3) an upload is requested. A crash between 1 and 2 leaves the event (and the files): the server
    /// log may claim a deletion that did not happen, never the other way round.
    @discardableResult
    public func execute(_ plan: DeletionPlan, confirmations: Int) throws -> Result {
        guard !plan.songs.isEmpty else { return Result(count: 0, bytes: 0) }
        guard confirmations >= plan.requiredConfirmations else { throw DeleteError.insufficientConfirmations }
        let at = now()
        let event = DeviceEvent(id: makeId(), at: at, details: DeleteSongsDetails.make(plan: plan, confirmations: confirmations))
        do {
            try queue.append(.device(event))
        } catch {
            throw DeleteError.eventNotDurable
        }
        let removed = store.removeSongs(plan.songs.map(\.songKey), skipList: true, at: at)
        uploader?.noteDeviceEvent()
        return Result(count: removed.count, bytes: removed.bytes)
    }
}

// MARK: - The screen's model

@MainActor
public final class SpaceModel: ObservableObject {
    @Published public private(set) var rows: [SpaceRow] = []
    @Published public var sort: SpaceSort = .leastPlayed { didSet { resort() } }
    @Published public var selection: Set<String> = []
    @Published public private(set) var confirmation = DeletionConfirmation()
    /// "Elimina le N meno ascoltate" — stepper, default 20.
    @Published public var leastPlayedCount = 20
    @Published public private(set) var message: String?
    @Published public private(set) var refreshing = false
    @Published public private(set) var refreshNote: String?

    private let store: OfflineStore
    private let deleter: SongDeleter
    private let api: MondropAPIProtocol?
    private var unsorted: [SpaceRow] = []

    public init(store: OfflineStore, queue: EventQueue, uploader: EventUploader?, api: MondropAPIProtocol?) {
        self.store = store
        self.deleter = SongDeleter(store: store, queue: queue, uploader: uploader)
        self.api = api
        reload()
    }

    public var usedBytes: Int { unsorted.reduce(0) { $0 + $1.bytes } }
    public var songCount: Int { unsorted.count }
    public var selectedRows: [SpaceRow] { rows.filter { selection.contains($0.songKey) } }
    public var selectedBytes: Int { selectedRows.reduce(0) { $0 + $1.bytes } }

    public func reload() {
        unsorted = store.spaceRows()
        selection = selection.filter { key in unsorted.contains { $0.songKey == key } }
        resort()
        leastPlayedCount = min(max(1, leastPlayedCount), max(1, unsorted.count))
    }

    private func resort() {
        rows = SpaceRanking.sorted(unsorted, by: sort)
    }

    public func toggle(_ songKey: String) {
        if selection.contains(songKey) { selection.remove(songKey) } else { selection.insert(songKey) }
    }

    public func clearSelection() { selection = [] }

    /// Fresh `plays` / `lastPlayedAt` for the ranking: re-read every playlist (also refreshes which songs are orphans).
    /// Offline it just keeps the numbers it has and says so.
    public func refreshFromServer() async {
        guard let api, !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            try await PlaylistSnapshots.refreshAll(api: api, store: store)
            refreshNote = nil
        } catch {
            refreshNote = "Numeri non aggiornati (\(PlaylistSyncCoordinator.describe(error))): uso quelli che ho."
        }
        reload()
    }

    // MARK: requests (each only OPENS the confirmation; nothing is deleted yet)

    /// One song (swipe): a single confirmation.
    public func requestDelete(songKey: String) {
        guard let row = unsorted.first(where: { $0.songKey == songKey }) else { return }
        begin(.manual([row]))
    }

    /// The ticked rows: a block when more than one.
    public func requestDeleteSelection() {
        begin(.manual(selectedRows))
    }

    public func requestDeleteLeastPlayed() {
        let plan = DeletionPlan.leastPlayed(from: unsorted, count: leastPlayedCount)
        selection = Set(plan.songs.map(\.songKey))
        begin(plan)
    }

    public func requestFree(mb: Int) {
        let plan = DeletionPlan.freeSpace(from: unsorted, mb: mb)
        selection = Set(plan.songs.map(\.songKey))
        begin(plan)
    }

    /// Songs in no playlist any more. Playlists are re-read first; if that fails nothing is proposed.
    public func requestDeleteOrphans() async {
        guard let api else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            try await PlaylistSnapshots.refreshAll(api: api, store: store)
        } catch {
            message = "Non riesco a leggere tutte le playlist (\(PlaylistSyncCoordinator.describe(error))): non propongo niente."
            return
        }
        reload()
        let orphanKeys = Set(store.orphans().map(\.songKey))
        let orphans = unsorted.filter { orphanKeys.contains($0.songKey) }
        guard !orphans.isEmpty else {
            message = "Ogni brano scaricato è ancora in una playlist."
            return
        }
        selection = Set(orphans.map(\.songKey))
        begin(.manual(SpaceRanking.sorted(orphans, by: .leastPlayed)))
    }

    private func begin(_ plan: DeletionPlan) {
        message = nil
        if plan.songs.isEmpty {
            message = "Nessun brano da eliminare."
            return
        }
        confirmation.begin(plan)
    }

    // MARK: the dialogs' buttons

    public func accept() {
        confirmation.accept()
        guard case .confirmed(let plan, let confirmations) = confirmation.stage else { return }
        do {
            let result = try deleter.execute(plan, confirmations: confirmations)
            let freed = DeletionDialogs.megabytes(result.bytes)
            message = result.count == 1 ? "Eliminato 1 brano (\(freed))." : "Eliminati \(result.count) brani (\(freed))."
            selection.subtract(plan.songs.map(\.songKey))
        } catch {
            message = (error as? SongDeleter.DeleteError)?.description ?? error.localizedDescription
        }
        confirmation.reset()
        reload()
    }

    public func cancel() {
        confirmation.cancel()
        if case .cancelled = confirmation.stage { selection = [] }
        confirmation.reset()
    }
}
