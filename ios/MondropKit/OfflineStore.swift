// OfflineStore.swift — the on-device library of downloaded MP3s.
//
// Layout (Application Support, excluded from iCloud backup):
//   Mondrop/offline-index.json     items + which synced playlists reference which songs
//   Mondrop/Offline/<name>.mp3     the files
//   Mondrop/Offline/.staging/      downloads waiting to be installed (cleaned automatically)
//   Mondrop/Resume/                URLSession resume data (cleaned automatically)
//   Mondrop/sync-queue.json        downloads not started yet (survives a relaunch)
//
// Before Phase 2 the app kept files in Documents/Offline and the index in UserDefaults:
// `migrateLegacyIfNeeded()` moves them over once.

import Foundation

/// What the sync planner needs to know about a file that is already on the device.
public struct LocalSnapshot: Equatable, Sendable {
    public let version: String?
    public let bytes: Int?
    public let fileExtension: String

    public init(version: String?, bytes: Int?, fileExtension: String) {
        self.version = version
        self.bytes = bytes
        self.fileExtension = fileExtension
    }
}

public struct InstallMetadata: Equatable, Sendable {
    public var title: String
    public var artist: String
    public var coverURL: String?
    public var lyrics: String?
    public var version: String?
    /// Server numbers at download time (docs/mondrop-stats.md §3), for the "meno ascoltate" ranking.
    public var plays: Int?
    public var lastPlayedAt: Date?
    /// Album / genres / year as the server described the track (ADR-0013): what lets «Libreria» browse the phone offline.
    public var album: String?
    public var genres: [String]
    public var year: Int?

    public init(
        title: String, artist: String, coverURL: String? = nil, lyrics: String? = nil, version: String? = nil,
        plays: Int? = nil, lastPlayedAt: Date? = nil,
        album: String? = nil, genres: [String] = [], year: Int? = nil
    ) {
        self.title = title
        self.artist = artist
        self.coverURL = coverURL
        self.lyrics = lyrics
        self.version = version
        self.plays = plays
        self.lastPlayedAt = lastPlayedAt
        self.album = album
        self.genres = genres
        self.year = year
    }
}

/// Counted listens of one song as this phone knows them: what the server last said (all devices) plus the
/// listens recorded here that the server has not acknowledged yet.
public struct PlayStat: Codable, Equatable, Sendable {
    public var plays: Int
    public var lastPlayedAt: Date?
    /// Counted listens recorded locally and not yet acknowledged (they are already inside `plays`).
    public var unsynced: Int

    public init(plays: Int = 0, lastPlayedAt: Date? = nil, unsynced: Int = 0) {
        self.plays = plays
        self.lastPlayedAt = lastPlayedAt
        self.unsynced = unsynced
    }
}

public enum OfflineStoreError: Error, Equatable {
    case emptyFile
}

public final class OfflineStore: @unchecked Sendable {

    public struct Item: Codable, Identifiable, Equatable, Sendable {
        public var id: String { songKey }
        public let songKey: String
        public var title: String
        public var artist: String
        /// Relative to the store root, e.g. `Offline/white_flag-1a2b3c4d5e.mp3`.
        public var relativePath: String
        public var coverURL: String?
        public var lyrics: String?
        /// Server `version` the file was downloaded at (nil for files that predate Phase 2).
        public var version: String?
        public var bytes: Int?
        public var addedAt: Date?
        /// ADR-0013: what the server said about the song when it was downloaded (or when a playlist / the library
        /// was read since). nil for files that predate Mondrop 1.5; the index of an earlier build still loads.
        public var album: String?
        public var genres: [String]?
        public var year: Int?

        public init(
            songKey: String,
            title: String,
            artist: String,
            relativePath: String,
            coverURL: String? = nil,
            lyrics: String? = nil,
            version: String? = nil,
            bytes: Int? = nil,
            addedAt: Date? = nil,
            album: String? = nil,
            genres: [String]? = nil,
            year: Int? = nil
        ) {
            self.songKey = songKey
            self.title = title
            self.artist = artist
            self.relativePath = relativePath
            self.coverURL = coverURL
            self.lyrics = lyrics
            self.version = version
            self.bytes = bytes
            self.addedAt = addedAt
            self.album = album
            self.genres = genres
            self.year = year
        }
    }

    struct Membership: Codable, Equatable {
        var name: String
        var songKeys: [String]
        var seenAt: Date
        /// The songs the SERVER said had failed the last time the playlist was read (the mark of a playlist). nil in an index written before 1.8.0.
        var failedKeys: [String]? = nil
    }

    /// What the phone saw the last time it read a playlist: the keys of its songs and which of them the server had failed. A playlist is drawn from
    /// this (its mark on a card, on a row of the list), so that no list has to read every manifest again.
    public struct PlaylistRecord: Equatable, Sendable {
        public let songKeys: [String]
        public let failedKeys: Set<String>

        public init(songKeys: [String], failedKeys: Set<String> = []) {
            self.songKeys = songKeys
            self.failedKeys = failedKeys
        }
    }

    struct IndexFile: Codable {
        var version: Int = 3
        var items: [Item] = []
        /// Playlists whose manifest the app has seen → their songKeys (orphan detection).
        var playlists: [String: Membership] = [:]
        /// Lyrics typed by the user; survive re-downloads and apply to streamed tracks too.
        var lyricsOverrides: [String: String] = [:]
        var legacyMigrated: Bool = false
        /// Listening numbers per song (see `PlayStat`).
        var playStats: [String: PlayStat] = [:]
        /// Songs the user deleted from THIS phone: Sync must not download them again until "Riscarica".
        var skipped: [String: Date] = [:]

        init() {}

        /// Every key is optional on read: an index written by an earlier build (no `playStats`, no `skipped`)
        /// must load, not be thrown away as corrupt.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 2
            items = try c.decodeIfPresent([Item].self, forKey: .items) ?? []
            playlists = try c.decodeIfPresent([String: Membership].self, forKey: .playlists) ?? [:]
            lyricsOverrides = try c.decodeIfPresent([String: String].self, forKey: .lyricsOverrides) ?? [:]
            legacyMigrated = try c.decodeIfPresent(Bool.self, forKey: .legacyMigrated) ?? false
            playStats = try c.decodeIfPresent([String: PlayStat].self, forKey: .playStats) ?? [:]
            skipped = try c.decodeIfPresent([String: Date].self, forKey: .skipped) ?? [:]
        }
    }

    /// Where the pre-Phase-2 app kept its files (Documents/Offline) and index (UserDefaults).
    public struct LegacySources {
        public var documents: URL?
        public var defaults: UserDefaults

        public init(documents: URL?, defaults: UserDefaults) {
            self.documents = documents
            self.defaults = defaults
        }

        public static func standard() -> LegacySources {
            LegacySources(
                documents: FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
                defaults: .standard
            )
        }
    }

    public static let legacyIndexKey = "offlineIndex"
    public static let legacyLyricsKeyPrefix = "offlineLyrics:"

    public static let shared = OfflineStore.launch(root: OfflineStore.defaultRoot(), legacy: .standard())

    /// What the app does when it starts: open the store (which migrates the pre-Phase-2 files and index), then drop
    /// empty files. Kept apart from `init` so each safety net can be tested on its own.
    public static func launch(root: URL, legacy: LegacySources?, fileManager: FileManager = .default) -> OfflineStore {
        let store = OfflineStore(root: root, legacy: legacy, fileManager: fileManager)
        store.purgeEmptyFiles()
        return store
    }

    public static func defaultRoot() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("Mondrop", isDirectory: true)
    }

    public let root: URL
    public var filesDirectory: URL { root.appendingPathComponent("Offline", isDirectory: true) }
    public var stagingDirectory: URL { filesDirectory.appendingPathComponent(".staging", isDirectory: true) }
    public var resumeDirectory: URL { root.appendingPathComponent("Resume", isDirectory: true) }
    var indexURL: URL { root.appendingPathComponent("offline-index.json") }
    public var queueURL: URL { root.appendingPathComponent("sync-queue.json") }

    private let fm: FileManager
    private let legacy: LegacySources?
    private let lock = NSLock()
    private var index = IndexFile()

    public init(root: URL, legacy: LegacySources? = nil, fileManager: FileManager = .default) {
        self.root = root
        self.legacy = legacy
        self.fm = fileManager
        for dir in [root, filesDirectory, stagingDirectory, resumeDirectory] {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        Self.excludeFromBackup(root)
        self.index = readIndex()
        migrateLegacyIfNeeded()
    }

    // MARK: - Reading

    /// Items whose file is really on disk AND not empty, newest first.
    ///
    /// A 0-byte file is never "present". The backend deployed before Phase 1 answered `/songs/:key/file` with
    /// HTTP 200 and `Content-Length: 0`, so every file the old app "downloaded" is an empty MP3 that it indexed
    /// as a song. Presence everywhere in this class (index, player, planner) goes through `isUsableFile`.
    public func loadIndex() -> [Item] {
        lock.lock(); defer { lock.unlock() }
        return index.items.filter { isUsableFile(root.appendingPathComponent($0.relativePath)) }
    }

    public func item(songKey: String) -> Item? {
        lock.lock(); defer { lock.unlock() }
        return index.items.first { $0.songKey == songKey }
    }

    public func fileURL(for item: Item) -> URL? {
        let url = root.appendingPathComponent(item.relativePath)
        return isUsableFile(url) ? url : nil
    }

    public func fileURL(songKey: String) -> URL? {
        guard let item = item(songKey: songKey) else { return nil }
        return fileURL(for: item)
    }

    /// nil when the song is not on the device — a missing OR empty file counts as not there.
    /// `bytes` is the ON-DISK size (never the recorded one): the planner compares it with the manifest.
    public func snapshot(songKey: String) -> LocalSnapshot? {
        guard let item = item(songKey: songKey), let url = fileURL(for: item), let size = fileSize(url) else { return nil }
        return LocalSnapshot(version: item.version, bytes: size, fileExtension: url.pathExtension.lowercased())
    }

    public func lyrics(for songKey: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return index.lyricsOverrides[songKey] ?? index.items.first { $0.songKey == songKey }?.lyrics
    }

    /// True when the user typed (or pasted) the words of this song: they win over every other source, and the sheet says «Scritto da te».
    public func hasTypedLyrics(for songKey: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return index.lyricsOverrides[songKey] != nil
    }

    // MARK: - Writing

    /// Moves a finished download into the library (replacing an older copy) and records it.
    /// An empty file is refused: it would be indexed as a song that plays nothing.
    @discardableResult
    public func install(stagedFile: URL, songKey: String, metadata: InstallMetadata) throws -> Item {
        lock.lock(); defer { lock.unlock() }
        guard (fileSize(stagedFile) ?? 0) > 0 else {
            try? fm.removeItem(at: stagedFile)
            throw OfflineStoreError.emptyFile
        }
        let relative = "Offline/\(Self.fileName(for: songKey)).mp3"
        let destination = root.appendingPathComponent(relative)
        try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        if fm.fileExists(atPath: destination.path) {
            _ = try fm.replaceItemAt(destination, withItemAt: stagedFile)
        } else {
            try fm.moveItem(at: stagedFile, to: destination)
        }
        Self.excludeFromBackup(destination)

        let previous = index.items.first { $0.songKey == songKey }
        if let previous, previous.relativePath != relative {
            try? fm.removeItem(at: root.appendingPathComponent(previous.relativePath))
        }
        let item = Item(
            songKey: songKey,
            title: metadata.title,
            artist: metadata.artist,
            relativePath: relative,
            coverURL: metadata.coverURL ?? previous?.coverURL,
            lyrics: index.lyricsOverrides[songKey] ?? metadata.lyrics ?? previous?.lyrics,
            version: metadata.version,
            bytes: fileSize(destination),
            addedAt: Date(),
            album: metadata.album ?? previous?.album,
            genres: metadata.genres.isEmpty ? previous?.genres : metadata.genres,
            year: metadata.year ?? previous?.year
        )
        index.items.removeAll { $0.songKey == songKey }
        index.items.insert(item, at: 0)
        index.skipped.removeValue(forKey: songKey)          // a real download: the song is back on the phone
        recordServerNumbersLocked(songKey: songKey, plays: metadata.plays, lastPlayedAt: metadata.lastPlayedAt)
        save()
        return item
    }

    /// The file on the device is the same one the server has (size matched): remember its version.
    public func adoptVersion(songKey: String, version: String) {
        lock.lock(); defer { lock.unlock() }
        guard let i = index.items.firstIndex(where: { $0.songKey == songKey }) else { return }
        index.items[i].version = version
        save()
    }

    public func saveLyrics(songKey: String, text: String) {
        lock.lock(); defer { lock.unlock() }
        if text.isEmpty {
            index.lyricsOverrides.removeValue(forKey: songKey)
        } else {
            index.lyricsOverrides[songKey] = text
        }
        if let i = index.items.firstIndex(where: { $0.songKey == songKey }) {
            index.items[i].lyrics = text.isEmpty ? nil : text
        }
        save()
    }

    public func remove(songKey: String) {
        lock.lock(); defer { lock.unlock() }
        removeLocked(songKey: songKey)
        save()
    }

    private func removeLocked(songKey: String) {
        if let item = index.items.first(where: { $0.songKey == songKey }) {
            try? fm.removeItem(at: root.appendingPathComponent(item.relativePath))
        }
        index.items.removeAll { $0.songKey == songKey }
    }

    // MARK: - What the library can browse offline (ADR-0013)

    /// Every song that is really on the phone (exists, not empty), as the tracks «Libreria» filters and lists.
    /// Offline, the phone answers the same questions the server does, from what it stored at download time.
    public func localTracks() -> [OfflineTrack] {
        lock.lock(); defer { lock.unlock() }
        return index.items.compactMap { item in
            guard isUsableFile(root.appendingPathComponent(item.relativePath)) else { return nil }
            let stat = index.playStats[item.songKey]
            return OfflineTrack(
                songKey: item.songKey,
                title: item.title,
                artist: item.artist,
                state: TrackState.ready.rawValue,
                version: item.version,
                bytes: item.bytes,
                coverUrl: item.coverURL,
                lyrics: index.lyricsOverrides[item.songKey] ?? item.lyrics,
                plays: stat?.plays,
                lastPlayedAt: stat?.lastPlayedAt.map { ISO.string($0) },
                album: item.album,
                genres: item.genres ?? [],
                year: item.year
            )
        }
    }

    /// The songKeys that are on the phone, in one pass (a list of 500 rows must not stat 500 files per redraw).
    public func localSongKeys() -> Set<String> {
        lock.lock(); defer { lock.unlock() }
        return Set(index.items.filter { isUsableFile(root.appendingPathComponent($0.relativePath)) }.map(\.songKey))
    }

    /// The server described these songs (a manifest, a library page): remember album / genres / year for the ones
    /// that are on the phone, so they can be browsed offline. Never erases: a track without the field changes nothing.
    public func recordMetadata(from tracks: [OfflineTrack]) {
        lock.lock(); defer { lock.unlock() }
        var changed = false
        for track in tracks {
            guard let i = index.items.firstIndex(where: { $0.songKey == track.songKey }) else { continue }
            if let album = track.album, index.items[i].album != album {
                index.items[i].album = album
                changed = true
            }
            if !track.genres.isEmpty, index.items[i].genres != track.genres {
                index.items[i].genres = track.genres
                changed = true
            }
            if let year = track.year, index.items[i].year != year {
                index.items[i].year = year
                changed = true
            }
        }
        if changed { save() }
    }

    // MARK: - Listening numbers (docs/mondrop-stats.md §3)

    public func stat(songKey: String) -> PlayStat? {
        lock.lock(); defer { lock.unlock() }
        return index.playStats[songKey]
    }

    /// What the server says (`plays` / `lastPlayedAt` on manifest tracks and GET /songs/:key): all devices, ever.
    /// Local listens the server has not seen yet stay on top, so the ranking never goes backwards.
    public func recordServerNumbers(songKey: String, plays: Int?, lastPlayedAt: Date?) {
        lock.lock(); defer { lock.unlock() }
        recordServerNumbersLocked(songKey: songKey, plays: plays, lastPlayedAt: lastPlayedAt)
        save()
    }

    public func recordServerNumbers(from manifest: OfflineManifest) {
        lock.lock(); defer { lock.unlock() }
        for track in manifest.tracks where track.plays != nil || track.lastPlayedAt != nil {
            recordServerNumbersLocked(songKey: track.songKey, plays: track.plays, lastPlayedAt: track.lastPlayedDate)
        }
        save()
    }

    private func recordServerNumbersLocked(songKey: String, plays: Int?, lastPlayedAt: Date?) {
        guard plays != nil || lastPlayedAt != nil else { return }
        let isLocal = index.items.contains { $0.songKey == songKey }
        guard var stat = index.playStats[songKey] else {
            guard isLocal else { return }          // numbers only matter for songs on the phone (or with pending listens)
            index.playStats[songKey] = PlayStat(plays: plays ?? 0, lastPlayedAt: lastPlayedAt, unsynced: 0)
            return
        }
        if let plays { stat.plays = plays + stat.unsynced }
        if let lastPlayedAt { stat.lastPlayedAt = max(lastPlayedAt, stat.lastPlayedAt ?? .distantPast) }
        index.playStats[songKey] = stat
    }

    /// A COUNTED listen was recorded on this phone: +1 now, even offline (it stays "unsynced" until acknowledged).
    public func bumpLocalPlay(songKey: String, at date: Date) {
        lock.lock(); defer { lock.unlock() }
        var stat = index.playStats[songKey] ?? PlayStat()
        stat.plays += 1
        stat.unsynced += 1
        stat.lastPlayedAt = max(date, stat.lastPlayedAt ?? .distantPast)
        index.playStats[songKey] = stat
        save()
    }

    /// The server answered for these events (or they were dropped): their listens are no longer "unsynced".
    /// Only COUNTED plays were ever bumped locally, so only those are settled.
    public func settleAckedPlays(_ events: [PlayEvent]) {
        let counted = events.filter(\.isCounted)
        guard !counted.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        for event in counted {
            guard var stat = index.playStats[event.songKey] else { continue }
            stat.unsynced = max(0, stat.unsynced - 1)
            if stat.unsynced == 0, !index.items.contains(where: { $0.songKey == event.songKey }) {
                index.playStats.removeValue(forKey: event.songKey)   // not on the phone, nothing pending: forget
            } else {
                index.playStats[event.songKey] = stat
            }
        }
        save()
    }

    /// Everything the "Spazio" screen shows: size on disk, counted plays, last play, when it arrived.
    public func spaceRows() -> [SpaceRow] {
        lock.lock(); defer { lock.unlock() }
        return index.items.compactMap { item in
            let url = root.appendingPathComponent(item.relativePath)
            guard let size = fileSize(url), size > 0 else { return nil }
            let stat = index.playStats[item.songKey]
            return SpaceRow(
                songKey: item.songKey,
                title: item.title,
                artist: item.artist,
                bytes: size,
                plays: stat?.plays ?? 0,
                lastPlayedAt: stat?.lastPlayedAt,
                addedAt: item.addedAt
            )
        }
    }

    // MARK: - Skip-list: songs the user deleted from this phone (decision D8)

    public var skippedKeys: Set<String> {
        lock.lock(); defer { lock.unlock() }
        return Set(index.skipped.keys)
    }

    public func isSkipped(_ songKey: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return index.skipped[songKey] != nil
    }

    public func addSkipped(_ songKeys: [String], at date: Date = Date()) {
        lock.lock(); defer { lock.unlock() }
        for key in songKeys { index.skipped[key] = date }
        save()
    }

    /// "Riscarica": the song is wanted on the phone again.
    public func clearSkipped(_ songKey: String) {
        lock.lock(); defer { lock.unlock() }
        guard index.skipped.removeValue(forKey: songKey) != nil else { return }
        save()
    }

    /// Deletes the files and index entries of songs the user chose to remove; with `skipList` Sync will not
    /// bring them back until "Riscarica". Songs that are not on the phone are ignored (and never skip-listed).
    @discardableResult
    public func removeSongs(_ songKeys: [String], skipList: Bool = true, at date: Date = Date()) -> (count: Int, bytes: Int) {
        lock.lock(); defer { lock.unlock() }
        var count = 0
        var bytes = 0
        for key in songKeys {
            guard let item = index.items.first(where: { $0.songKey == key }) else { continue }
            bytes += fileSize(root.appendingPathComponent(item.relativePath)) ?? item.bytes ?? 0
            removeLocked(songKey: key)
            clearResumeDataLocked(songKey: key)
            if skipList { index.skipped[key] = date }
            if let stat = index.playStats[key], stat.unsynced == 0 { index.playStats.removeValue(forKey: key) }
            count += 1
        }
        if count > 0 { save() }
        return (count, bytes)
    }

    // MARK: - Playlist membership + orphans

    /// Remember which songs a playlist holds (every manifest the app sees, not only synced files).
    public func recordPlaylist(id: String, name: String, songKeys: [String], failedKeys: [String] = []) {
        lock.lock(); defer { lock.unlock() }
        index.playlists[id] = Membership(name: name, songKeys: songKeys, seenAt: Date(), failedKeys: failedKeys.isEmpty ? nil : failedKeys)
        save()
    }

    /// Every playlist the phone has read, by id (see `PlaylistRecord`).
    public func playlistRecords() -> [String: PlaylistRecord] {
        lock.lock(); defer { lock.unlock() }
        return index.playlists.mapValues { PlaylistRecord(songKeys: $0.songKeys, failedKeys: Set($0.failedKeys ?? [])) }
    }

    /// Playlists deleted on the server stop protecting their songs.
    public func pruneMemberships(keeping ids: Set<String>) {
        lock.lock(); defer { lock.unlock() }
        let before = index.playlists.count
        index.playlists = index.playlists.filter { ids.contains($0.key) }
        if index.playlists.count != before { save() }
    }

    public var knownPlaylistIds: Set<String> {
        lock.lock(); defer { lock.unlock() }
        return Set(index.playlists.keys)
    }

    /// The playlists the app has seen and the songs each one held (offline, «Libreria» lists them from here).
    public func playlistMemberships() -> [(id: String, name: String, songKeys: [String])] {
        lock.lock(); defer { lock.unlock() }
        return index.playlists
            .map { (id: $0.key, name: $0.value.name, songKeys: $0.value.songKeys) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Downloaded songs that no known playlist references any more.
    public func orphans() -> [Item] {
        lock.lock(); defer { lock.unlock() }
        return orphansLocked()
    }

    private func orphansLocked() -> [Item] {
        let referenced = Set(index.playlists.values.flatMap { $0.songKeys })
        return index.items.filter {
            !referenced.contains($0.songKey) && isUsableFile(root.appendingPathComponent($0.relativePath))
        }
    }

    public func orphanSummary() -> (count: Int, bytes: Int) {
        lock.lock(); defer { lock.unlock() }
        let list = orphansLocked()
        return (list.count, list.reduce(0) { $0 + (fileSize(root.appendingPathComponent($1.relativePath)) ?? $1.bytes ?? 0) })
    }

    /// Deletes exactly the confirmed items — and only those that are STILL orphans.
    @discardableResult
    public func removeOrphans(confirmed: [Item]) -> (count: Int, bytes: Int) {
        lock.lock(); defer { lock.unlock() }
        let stillOrphan = Set(orphansLocked().map(\.songKey))
        var count = 0
        var bytes = 0
        for item in confirmed where stillOrphan.contains(item.songKey) {
            bytes += fileSize(root.appendingPathComponent(item.relativePath)) ?? item.bytes ?? 0
            removeLocked(songKey: item.songKey)
            count += 1
        }
        if count > 0 { save() }
        return (count, bytes)
    }

    // MARK: - Empty files

    /// Deletes empty files (and their entries) that earlier versions left behind or a broken download produced.
    /// Runs at every launch (`launch(root:legacy:)`); an empty file is never a song, and keeping it would make the planner think the
    /// track is already on the device. Lyrics the user typed are kept (they re-attach on the next real download).
    @discardableResult
    public func purgeEmptyFiles() -> Int {
        lock.lock(); defer { lock.unlock() }
        var emptyKeys: [String] = []
        for item in index.items {
            let url = root.appendingPathComponent(item.relativePath)
            if fm.fileExists(atPath: url.path), (fileSize(url) ?? 0) == 0 {
                try? fm.removeItem(at: url)
                emptyKeys.append(item.songKey)
            }
        }
        guard !emptyKeys.isEmpty else { return 0 }
        index.items.removeAll { emptyKeys.contains($0.songKey) }
        save()
        return emptyKeys.count
    }

    // MARK: - Temp files

    /// Drops interrupted installs and stale resume data. Never touches installed files.
    public func cleanTemporary(stagingOlderThan: TimeInterval = 6 * 3600, resumeOlderThan: TimeInterval = 3 * 86_400, now: Date = Date()) {
        removeOldFiles(in: stagingDirectory, olderThan: stagingOlderThan, now: now)
        removeOldFiles(in: resumeDirectory, olderThan: resumeOlderThan, now: now)
    }

    private func removeOldFiles(in dir: URL, olderThan: TimeInterval, now: Date) {
        guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        for url in files {
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            if now.timeIntervalSince(modified) > olderThan { try? fm.removeItem(at: url) }
        }
    }

    public func stagingURL() -> URL {
        try? fm.createDirectory(at: stagingDirectory, withIntermediateDirectories: true)
        return stagingDirectory.appendingPathComponent("\(UUID().uuidString).part")
    }

    // MARK: - Resume data + queue persistence

    public func resumeData(songKey: String, url: String) -> Data? {
        try? Data(contentsOf: resumeFile(songKey: songKey, url: url))
    }

    public func saveResumeData(_ data: Data, songKey: String, url: String) {
        try? fm.createDirectory(at: resumeDirectory, withIntermediateDirectories: true)
        try? data.write(to: resumeFile(songKey: songKey, url: url), options: .atomic)
    }

    public func clearResumeData(songKey: String) {
        clearResumeDataLocked(songKey: songKey)
    }

    private func clearResumeDataLocked(songKey: String) {
        let prefix = "\(Self.fnv1a(songKey))-"
        guard let files = try? fm.contentsOfDirectory(at: resumeDirectory, includingPropertiesForKeys: nil) else { return }
        for url in files where url.lastPathComponent.hasPrefix(prefix) { try? fm.removeItem(at: url) }
    }

    private func resumeFile(songKey: String, url: String) -> URL {
        resumeDirectory.appendingPathComponent("\(Self.fnv1a(songKey))-\(Self.fnv1a(url)).resume")
    }

    public var batchURL: URL { root.appendingPathComponent("sync-batch.json") }

    /// The sync in progress (which songs it started, which finished): survives a relaunch, so the «Sync finito»
    /// notification still knows what the sync was when iOS wakes the app to deliver the last download.
    public func readBatchData() -> Data? { try? Data(contentsOf: batchURL) }

    public func writeBatchData(_ data: Data?) {
        if let data {
            try? data.write(to: batchURL, options: .atomic)
        } else {
            try? fm.removeItem(at: batchURL)
        }
    }

    public func readQueueData() -> Data? { try? Data(contentsOf: queueURL) }

    public func writeQueueData(_ data: Data?) {
        if let data {
            try? data.write(to: queueURL, options: .atomic)
        } else {
            try? fm.removeItem(at: queueURL)
        }
    }

    // MARK: - Persistence

    private func readIndex() -> IndexFile {
        guard let data = try? Data(contentsOf: indexURL) else { return IndexFile() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let decoded = try? decoder.decode(IndexFile.self, from: data) { return decoded }
        // Unreadable index: keep it for forensics and start clean rather than crash on every launch.
        try? fm.moveItem(at: indexURL, to: root.appendingPathComponent("offline-index.corrupt.json"))
        return IndexFile()
    }

    /// Call with the lock held.
    private func save() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        if let data = try? encoder.encode(index) {
            try? data.write(to: indexURL, options: .atomic)
        }
    }

    // MARK: - Legacy migration (Documents/Offline + UserDefaults → Application Support)

    /// Idempotent. Entries whose file is gone are dropped; a move that fails is retried at the next launch.
    public func migrateLegacyIfNeeded() {
        lock.lock(); defer { lock.unlock() }
        guard !index.legacyMigrated else { return }
        guard let legacy else { return }   // no legacy sources (tests, other roots): nothing to do, nothing to flag

        var legacyItems: [Item] = []
        if let data = legacy.defaults.data(forKey: Self.legacyIndexKey),
           let decoded = try? JSONDecoder().decode([Item].self, from: data) {
            legacyItems = decoded
        }

        var migratedKeys: [String] = []
        var allHandled = true
        var migratedItems: [Item] = []
        for old in legacyItems {
            guard let documents = legacy.documents else { continue }
            let source = documents.appendingPathComponent(old.relativePath)
            if index.items.contains(where: { $0.songKey == old.songKey }) {
                // Already installed by the new app: the new copy wins, the legacy file would only be junk.
                try? fm.removeItem(at: source)
                migratedKeys.append(old.songKey)
                continue
            }
            let destination = root.appendingPathComponent(old.relativePath)
            guard fm.fileExists(atPath: source.path) else { migratedKeys.append(old.songKey); continue }  // dangling
            if (fileSize(source) ?? 0) == 0 {
                // The backend before Phase 1 answered /songs/:key/file with 200 + Content-Length: 0, so the old app
                // indexed EMPTY files as downloaded. They are not songs: drop file and entry, keep typed lyrics.
                try? fm.removeItem(at: source)
                if let lyrics = legacy.defaults.string(forKey: Self.legacyLyricsKeyPrefix + old.songKey), !lyrics.isEmpty {
                    index.lyricsOverrides[old.songKey] = lyrics
                }
                migratedKeys.append(old.songKey)
                continue
            }
            do {
                try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
                if fm.fileExists(atPath: destination.path) { try fm.removeItem(at: destination) }
                do {
                    try fm.moveItem(at: source, to: destination)
                } catch {
                    try fm.copyItem(at: source, to: destination)
                    try? fm.removeItem(at: source)
                }
                Self.excludeFromBackup(destination)
            } catch {
                allHandled = false
                continue
            }
            var item = old
            item.bytes = fileSize(destination) ?? old.bytes
            if let lyrics = legacy.defaults.string(forKey: Self.legacyLyricsKeyPrefix + old.songKey), !lyrics.isEmpty {
                index.lyricsOverrides[old.songKey] = lyrics
                item.lyrics = lyrics
            }
            migratedItems.append(item)
            migratedKeys.append(old.songKey)
        }

        // Legacy order was newest first; keep it behind anything installed since.
        index.items.append(contentsOf: migratedItems)
        guard allHandled else {
            save()   // keep what moved; the flag stays off so the rest is retried next launch
            return
        }
        index.legacyMigrated = true
        save()

        legacy.defaults.removeObject(forKey: Self.legacyIndexKey)
        for key in migratedKeys { legacy.defaults.removeObject(forKey: Self.legacyLyricsKeyPrefix + key) }
        if let documents = legacy.documents {
            let legacyDir = documents.appendingPathComponent("Offline", isDirectory: true)
            if let rest = try? fm.contentsOfDirectory(atPath: legacyDir.path), rest.isEmpty {
                try? fm.removeItem(at: legacyDir)
            }
        }
    }

    // MARK: - Helpers

    /// Exists AND is not empty.
    private func isUsableFile(_ url: URL) -> Bool {
        (fileSize(url) ?? 0) > 0
    }

    private func fileSize(_ url: URL) -> Int? {
        guard let attributes = try? fm.attributesOfItem(atPath: url.path) else { return nil }
        return (attributes[.size] as? NSNumber)?.intValue
    }

    static func excludeFromBackup(_ url: URL) {
        var target = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? target.setResourceValues(values)
    }

    /// `<readable-prefix>-<10 hex>`: stable per songKey, safe on any file system, no collisions between `a/b` and `a_b`.
    static func fileName(for songKey: String) -> String {
        var out = ""
        var lastWasSeparator = false
        for scalar in songKey.unicodeScalars {
            let c = Character(scalar)
            if c.isLetter || c.isNumber {
                out.append(c)
                lastWasSeparator = false
            } else if !lastWasSeparator {
                out.append("_")
                lastWasSeparator = true
            }
        }
        out = out.trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        if out.isEmpty { out = "track" }
        return "\(String(out.prefix(60)))-\(String(fnv1a(songKey).prefix(10)))"
    }

    static func fnv1a(_ s: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in s.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        let hex = String(hash, radix: 16)
        return String(repeating: "0", count: max(0, 16 - hex.count)) + hex
    }
}
