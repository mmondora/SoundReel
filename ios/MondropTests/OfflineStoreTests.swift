import XCTest
@testable import Mondrop

final class OfflineStoreTests: XCTestCase {
    private var fm: FileManager { .default }

    private func makeStore(legacy: OfflineStore.LegacySources? = nil, root: URL? = nil) throws -> (OfflineStore, URL) {
        let dir = try root ?? TestSupport.tempDir("store")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return (OfflineStore(root: dir, legacy: legacy), dir)
    }

    @discardableResult
    private func install(_ store: OfflineStore, _ key: String, version: String? = "1-1", bytes: Int = 64, lyrics: String? = nil) throws -> OfflineStore.Item {
        let staged = store.stagingURL()
        try Data(repeating: 9, count: bytes).write(to: staged)
        return try store.install(
            stagedFile: staged,
            songKey: key,
            metadata: InstallMetadata(title: "T \(key)", artist: "A", coverURL: "https://img.test/c.jpg", lyrics: lyrics, version: version)
        )
    }

    // MARK: install

    func testInstallMovesTheStagedFileAndRecordsIt() throws {
        let (store, root) = try makeStore()
        let staged = store.stagingURL()
        try Data(repeating: 1, count: 2048).write(to: staged)

        let item = try store.install(
            stagedFile: staged,
            songKey: "bishop briggs::white flag",
            metadata: InstallMetadata(title: "White Flag", artist: "Bishop Briggs", coverURL: "https://img.test/wf.jpg", version: "2048-7")
        )

        XCTAssertFalse(fm.fileExists(atPath: staged.path), "the staged file is moved, not copied")
        let file = try XCTUnwrap(store.fileURL(for: item))
        XCTAssertTrue(file.path.hasPrefix(root.path))
        XCTAssertEqual(file.pathExtension, "mp3")
        XCTAssertEqual(item.bytes, 2048)
        XCTAssertEqual(item.version, "2048-7")
        XCTAssertEqual(store.loadIndex().map(\.songKey), ["bishop briggs::white flag"])
        XCTAssertEqual(store.snapshot(songKey: "bishop briggs::white flag"), LocalSnapshot(version: "2048-7", bytes: 2048, fileExtension: "mp3"))
    }

    func testInstallReplacesTheOldCopyOfTheSameSong() throws {
        let (store, _) = try makeStore()
        try install(store, "a", version: "1-1", bytes: 100)
        let second = try install(store, "a", version: "2-2", bytes: 300)

        XCTAssertEqual(store.loadIndex().count, 1)
        XCTAssertEqual(store.item(songKey: "a")?.version, "2-2")
        XCTAssertEqual(store.item(songKey: "a")?.bytes, 300)
        let files = try fm.contentsOfDirectory(atPath: store.filesDirectory.path).filter { $0.hasSuffix(".mp3") }
        XCTAssertEqual(files.count, 1, "no stale copy left behind")
        XCTAssertNotNil(store.fileURL(for: second))
    }

    func testStoreIsExcludedFromICloudBackup() throws {
        let (store, root) = try makeStore()
        let item = try install(store, "a")
        let file = try XCTUnwrap(store.fileURL(for: item))
        XCTAssertEqual(try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        XCTAssertEqual(try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    func testFileNamesAreSafeStableAndDoNotCollide() {
        let a = OfflineStore.fileName(for: "ac/dc::back in black")
        let b = OfflineStore.fileName(for: "ac_dc::back in black")
        XCTAssertNotEqual(a, b, "a/b and a_b are different songs")
        XCTAssertEqual(a, OfflineStore.fileName(for: "ac/dc::back in black"), "stable per songKey")
        for name in [a, b, OfflineStore.fileName(for: String(repeating: "x", count: 500)), OfflineStore.fileName(for: "///"), OfflineStore.fileName(for: "../../etc")] {
            XCTAssertFalse(name.contains("/"))
            XCTAssertFalse(name.contains(":"))
            XCTAssertFalse(name.hasPrefix("."))
            XCTAssertLessThan(name.count, 80)
        }
    }

    // MARK: empty files (the backend before Phase 1 served 200 + Content-Length: 0)

    func testAnEmptyFileIsNeverPresent() throws {
        let (store, _) = try makeStore()
        let item = try install(store, "a", version: "1-1", bytes: 64)
        let file = try XCTUnwrap(store.fileURL(for: item))
        store.recordPlaylist(id: "p1", name: "P", songKeys: [])
        try Data().write(to: file)                                       // truncated to 0 bytes

        XCTAssertNil(store.fileURL(for: item), "the player must not play silence as 'local'")
        XCTAssertNil(store.fileURL(songKey: "a"))
        XCTAssertNil(store.snapshot(songKey: "a"), "the planner must see it as missing")
        XCTAssertTrue(store.loadIndex().isEmpty, "the Coda offline list must not show it")
        XCTAssertTrue(store.orphans().isEmpty, "…nor offer it as a song to free")
    }

    func testSnapshotReportsTheOnDiskSizeNotTheRecordedOne() throws {
        let (store, _) = try makeStore()
        let item = try install(store, "a", version: "1-1", bytes: 64)
        try Data(repeating: 1, count: 10).write(to: try XCTUnwrap(store.fileURL(for: item)))
        XCTAssertEqual(store.snapshot(songKey: "a")?.bytes, 10, "the index says 64, the disk says 10: trust the disk")
    }

    func testInstallRefusesAnEmptyFileAndRecordsNothing() throws {
        let (store, _) = try makeStore()
        let staged = store.stagingURL()
        try Data().write(to: staged)
        XCTAssertThrowsError(try store.install(stagedFile: staged, songKey: "a", metadata: InstallMetadata(title: "A", artist: "X"))) {
            XCTAssertEqual($0 as? OfflineStoreError, .emptyFile)
        }
        XCTAssertNil(store.item(songKey: "a"))
        XCTAssertFalse(fm.fileExists(atPath: staged.path))
    }

    func testAnEmptyReinstallDoesNotDestroyTheGoodCopy() throws {
        let (store, _) = try makeStore()
        try install(store, "a", version: "1-1", bytes: 64)
        let staged = store.stagingURL()
        try Data().write(to: staged)
        XCTAssertThrowsError(try store.install(stagedFile: staged, songKey: "a", metadata: InstallMetadata(title: "A", artist: "X", version: "2-2")))
        XCTAssertEqual(store.snapshot(songKey: "a"), LocalSnapshot(version: "1-1", bytes: 64, fileExtension: "mp3"))
    }

    func testLaunchPurgesEmptyFilesAndTheirEntriesButKeepsTheRest() throws {
        let (store, root) = try makeStore()
        try install(store, "good", version: "1-1", bytes: 64)
        let bad = try install(store, "bad", version: "1-1", bytes: 64)
        let badFile = try XCTUnwrap(store.fileURL(for: bad))
        store.saveLyrics(songKey: "bad", text: "testo scritto da me")
        try Data().write(to: badFile)

        let reopened = OfflineStore.launch(root: root, legacy: nil)

        XCTAssertNil(reopened.item(songKey: "bad"))
        XCTAssertFalse(fm.fileExists(atPath: badFile.path), "the empty file is deleted from disk")
        XCTAssertEqual(reopened.loadIndex().map(\.songKey), ["good"])
        XCTAssertEqual(reopened.lyrics(for: "bad"), "testo scritto da me", "typed lyrics survive and re-attach on the next real download")
    }

    func testAnEmptyLocalFileMakesFirstPlayStreamInsteadOfPlayingSilence() throws {
        let (store, _) = try makeStore()
        let item = try install(store, "a", version: "1-1", bytes: 64)
        try Data().write(to: try XCTUnwrap(store.fileURL(for: item)))

        let decision = FirstPlay.decide(songKey: "a", track: TestSupport.track("a"), local: store.fileURL(songKey: "a"), config: .test)
        guard case .stream = decision else { return XCTFail("expected stream, got \(decision)") }
    }

    func testLoadIndexHidesItemsWhoseFileDisappeared() throws {
        let (store, _) = try makeStore()
        let item = try install(store, "a")
        try install(store, "b")
        try fm.removeItem(at: try XCTUnwrap(store.fileURL(for: item)))
        XCTAssertEqual(store.loadIndex().map(\.songKey), ["b"])
        XCTAssertNil(store.snapshot(songKey: "a"), "the planner then sees it as missing and re-downloads")
    }

    func testIndexSurvivesARelaunch() throws {
        let (store, root) = try makeStore()
        try install(store, "a", version: "9-9")
        store.recordPlaylist(id: "p1", name: "P", songKeys: ["a"])

        let again = OfflineStore(root: root)
        XCTAssertEqual(again.item(songKey: "a")?.version, "9-9")
        XCTAssertEqual(again.knownPlaylistIds, ["p1"])
    }

    func testCorruptIndexIsSetAsideNotFatal() throws {
        let (store, root) = try makeStore()
        try install(store, "a")
        try Data("{ not json".utf8).write(to: root.appendingPathComponent("offline-index.json"))

        let reopened = OfflineStore(root: root)
        XCTAssertTrue(reopened.loadIndex().isEmpty)
        XCTAssertTrue(fm.fileExists(atPath: root.appendingPathComponent("offline-index.corrupt.json").path))
    }

    func testAdoptVersionOnlyTouchesTheVersion() throws {
        let (store, _) = try makeStore()
        try install(store, "a", version: nil, bytes: 77)
        store.adoptVersion(songKey: "a", version: "77-5")
        XCTAssertEqual(store.snapshot(songKey: "a"), LocalSnapshot(version: "77-5", bytes: 77, fileExtension: "mp3"))
    }

    func testLyricsEditedByTheUserSurviveARedownload() throws {
        let (store, _) = try makeStore()
        try install(store, "a", lyrics: "dal server")
        XCTAssertEqual(store.lyrics(for: "a"), "dal server")
        store.saveLyrics(songKey: "a", text: "scritte da me")
        try install(store, "a", version: "2-2", lyrics: "dal server di nuovo")
        XCTAssertEqual(store.lyrics(for: "a"), "scritte da me")
        // …and lyrics typed while STREAMING (no local item yet) are kept for when the file arrives.
        store.saveLyrics(songKey: "streamed", text: "durante lo streaming")
        try install(store, "streamed")
        XCTAssertEqual(store.item(songKey: "streamed")?.lyrics, "durante lo streaming")
    }

    // MARK: legacy migration

    private struct Legacy {
        let documents: URL
        let defaults: UserDefaults
        let suite: String
        var sources: OfflineStore.LegacySources { OfflineStore.LegacySources(documents: documents, defaults: defaults) }
    }

    private func makeLegacy(files: [String: Int], items: [OfflineStore.Item], lyrics: [String: String] = [:]) throws -> Legacy {
        let docs = try TestSupport.tempDir("docs")
        addTeardownBlock { try? FileManager.default.removeItem(at: docs) }
        for (relative, size) in files {
            let url = docs.appendingPathComponent(relative)
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(repeating: 3, count: size).write(to: url)
        }
        let suite = "mondrop-legacy-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        defaults.set(try JSONEncoder().encode(items), forKey: OfflineStore.legacyIndexKey)
        for (key, text) in lyrics { defaults.set(text, forKey: OfflineStore.legacyLyricsKeyPrefix + key) }
        return Legacy(documents: docs, defaults: defaults, suite: suite)
    }

    func testMigrationMovesFilesAndIndexFromDocumentsAndUserDefaults() throws {
        let legacy = try makeLegacy(
            files: ["Offline/air_sexy_boy.mp3": 500, "Offline/reel_audio.wav": 900],
            items: [
                OfflineStore.Item(songKey: "air::sexy boy", title: "Sexy Boy", artist: "Air", relativePath: "Offline/air_sexy_boy.mp3", coverURL: "https://img.test/a.jpg"),
                OfflineStore.Item(songKey: "reel::audio", title: "Reel", artist: "", relativePath: "Offline/reel_audio.wav"),
                OfflineStore.Item(songKey: "gone::file", title: "Gone", artist: "X", relativePath: "Offline/gone.mp3"),   // dangling
            ],
            lyrics: ["reel::audio": "testo salvato", "air::sexy boy": ""]
        )
        let (store, root) = try makeStore(legacy: legacy.sources)

        // files now live in Application Support, the Documents copies are gone
        XCTAssertEqual(Set(store.loadIndex().map(\.songKey)), ["air::sexy boy", "reel::audio"])
        XCTAssertTrue(fm.fileExists(atPath: root.appendingPathComponent("Offline/air_sexy_boy.mp3").path))
        XCTAssertTrue(fm.fileExists(atPath: root.appendingPathComponent("Offline/reel_audio.wav").path))
        XCTAssertFalse(fm.fileExists(atPath: legacy.documents.appendingPathComponent("Offline/air_sexy_boy.mp3").path))
        XCTAssertFalse(fm.fileExists(atPath: legacy.documents.appendingPathComponent("Offline").path), "empty legacy dir removed")

        // metadata, sizes and lyrics came along; the app can still resolve them
        let air = try XCTUnwrap(store.item(songKey: "air::sexy boy"))
        XCTAssertEqual(air.title, "Sexy Boy")
        XCTAssertEqual(air.coverURL, "https://img.test/a.jpg")
        XCTAssertEqual(air.bytes, 500)
        XCTAssertNil(air.version, "pre-Phase-2 files have no server version")
        XCTAssertNotNil(store.fileURL(songKey: "reel::audio"))
        XCTAssertEqual(store.lyrics(for: "reel::audio"), "testo salvato")

        // UserDefaults no longer holds the old index / lyrics
        XCTAssertNil(legacy.defaults.data(forKey: OfflineStore.legacyIndexKey))
        XCTAssertNil(legacy.defaults.string(forKey: OfflineStore.legacyLyricsKeyPrefix + "reel::audio"))
    }

    func testMigrationDropsEmptyFilesInsteadOfCarryingThemOver() throws {
        // The old app indexed every file the backend "served" with 200 + Content-Length: 0 as downloaded.
        let legacy = try makeLegacy(
            files: ["Offline/good.mp3": 500, "Offline/zero.mp3": 0, "Offline/zero2.wav": 0],
            items: [
                OfflineStore.Item(songKey: "good", title: "Good", artist: "A", relativePath: "Offline/good.mp3"),
                OfflineStore.Item(songKey: "zero", title: "Zero", artist: "B", relativePath: "Offline/zero.mp3"),
                OfflineStore.Item(songKey: "zero2", title: "Zero2", artist: "C", relativePath: "Offline/zero2.wav"),
            ],
            lyrics: ["zero": "testo che avevo scritto"]
        )
        let (store, root) = try makeStore(legacy: legacy.sources)

        // `OfflineStore(root:legacy:)` does NOT purge: this is the migration's own doing, not the launch-time safety net.
        XCTAssertEqual(store.loadIndex().map(\.songKey), ["good"], "only the real file is carried over")
        XCTAssertNil(store.item(songKey: "zero"), "no index entry for an empty file, not even a hidden one")
        XCTAssertNil(store.item(songKey: "zero2"))
        XCTAssertNil(store.snapshot(songKey: "zero"), "so the planner will download it for real")
        XCTAssertFalse(fm.fileExists(atPath: root.appendingPathComponent("Offline/zero.mp3").path), "not moved over")
        XCTAssertFalse(fm.fileExists(atPath: legacy.documents.appendingPathComponent("Offline/zero.mp3").path), "junk removed from Documents")
        XCTAssertFalse(fm.fileExists(atPath: legacy.documents.appendingPathComponent("Offline/zero2.wav").path))
        XCTAssertEqual(store.lyrics(for: "zero"), "testo che avevo scritto", "what the user typed is kept")
        XCTAssertNil(legacy.defaults.data(forKey: OfflineStore.legacyIndexKey), "migration completed")
    }

    func testMigrationRunsOnceEvenIfTheLegacyKeysReappear() throws {
        let legacy = try makeLegacy(
            files: ["Offline/a.mp3": 10],
            items: [OfflineStore.Item(songKey: "a", title: "A", artist: "X", relativePath: "Offline/a.mp3")]
        )
        let (store, root) = try makeStore(legacy: legacy.sources)
        XCTAssertEqual(store.loadIndex().count, 1)

        // a stray old index shows up again: a second launch must not re-import or duplicate anything
        legacy.defaults.set(try JSONEncoder().encode([OfflineStore.Item(songKey: "b", title: "B", artist: "X", relativePath: "Offline/b.mp3")]), forKey: OfflineStore.legacyIndexKey)
        let relaunched = OfflineStore(root: root, legacy: legacy.sources)
        XCTAssertEqual(relaunched.loadIndex().map(\.songKey), ["a"])
    }

    func testMigrationWithNothingToMigrateIsHarmless() throws {
        let legacy = try makeLegacy(files: [:], items: [])
        let (store, _) = try makeStore(legacy: legacy.sources)
        XCTAssertTrue(store.loadIndex().isEmpty)
    }

    func testMigrationKeepsAlreadyInstalledFilesAndDoesNotDuplicate() throws {
        let legacy = try makeLegacy(
            files: ["Offline/a.mp3": 10],
            items: [OfflineStore.Item(songKey: "a", title: "Old A", artist: "X", relativePath: "Offline/a.mp3")]
        )
        let root = try TestSupport.tempDir("store")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let first = OfflineStore(root: root)                       // no legacy yet
        try install(first, "a", version: "5-5", bytes: 50)         // downloaded with the new app
        let store = OfflineStore(root: root, legacy: legacy.sources)
        XCTAssertEqual(store.loadIndex().count, 1)
        XCTAssertEqual(store.item(songKey: "a")?.version, "5-5", "the new download wins over the legacy entry")
        XCTAssertFalse(fm.fileExists(atPath: legacy.documents.appendingPathComponent("Offline/a.mp3").path), "no junk left in Documents")
        XCTAssertNil(legacy.defaults.data(forKey: OfflineStore.legacyIndexKey))
    }

    // MARK: orphans

    func testOrphansAreSongsInNoKnownPlaylist() throws {
        let (store, _) = try makeStore()
        for k in ["a", "b", "c"] { try install(store, k) }
        store.recordPlaylist(id: "p1", name: "Uno", songKeys: ["a"])
        store.recordPlaylist(id: "p2", name: "Due", songKeys: ["a", "b"])

        XCTAssertEqual(store.orphans().map(\.songKey), ["c"])
        XCTAssertEqual(store.orphanSummary().count, 1)
        XCTAssertEqual(store.orphanSummary().bytes, 64)
    }

    func testAPlaylistMembershipCoversSongsEvenWhenNotDownloadedFromIt() throws {
        let (store, _) = try makeStore()
        try install(store, "streamed-once")
        store.recordPlaylist(id: "p1", name: "Uno", songKeys: ["streamed-once", "never-downloaded"])
        XCTAssertTrue(store.orphans().isEmpty, "a song downloaded by first play belongs to its playlist")
    }

    func testRemovingASongFromAPlaylistOrphansIt() throws {
        let (store, _) = try makeStore()
        try install(store, "a")
        store.recordPlaylist(id: "p1", name: "Uno", songKeys: ["a"])
        XCTAssertTrue(store.orphans().isEmpty)
        store.recordPlaylist(id: "p1", name: "Uno", songKeys: [])
        XCTAssertEqual(store.orphans().map(\.songKey), ["a"])
    }

    func testPruningADeletedPlaylistReleasesItsSongs() throws {
        let (store, _) = try makeStore()
        try install(store, "a")
        store.recordPlaylist(id: "gone", name: "Cancellata", songKeys: ["a"])
        store.pruneMemberships(keeping: ["p1"])
        XCTAssertEqual(store.orphans().map(\.songKey), ["a"])
        XCTAssertTrue(store.knownPlaylistIds.isEmpty)
    }

    func testRemoveOrphansDeletesOnlyTheConfirmedOnesThatAreStillOrphans() throws {
        let (store, _) = try makeStore()
        for k in ["a", "b", "c"] { try install(store, k) }
        store.recordPlaylist(id: "p1", name: "Uno", songKeys: ["a"])
        let confirmed = store.orphans()                      // b, c — what the user saw and confirmed
        XCTAssertEqual(Set(confirmed.map(\.songKey)), ["b", "c"])

        // between preview and confirmation another playlist starts referencing "c"
        store.recordPlaylist(id: "p2", name: "Due", songKeys: ["c"])
        let result = store.removeOrphans(confirmed: confirmed)

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.bytes, 64)
        XCTAssertEqual(Set(store.loadIndex().map(\.songKey)), ["a", "c"])
        XCTAssertNil(store.fileURL(songKey: "b"))
    }

    func testNothingIsOrphanedWhileThereIsNothingToCompareAgainstButTheCleanerStillRefreshesFirst() throws {
        // With no recorded playlists EVERYTHING looks orphaned: that is exactly why the UI refreshes every
        // playlist (LibraryCleaner) and asks for confirmation before calling removeOrphans.
        let (store, _) = try makeStore()
        try install(store, "a")
        XCTAssertEqual(store.orphans().count, 1)
        XCTAssertEqual(store.loadIndex().count, 1, "…and orphans() alone deletes nothing")
    }

    // MARK: temporary files + resume data

    func testCleanTemporaryDropsOldStagingAndResumeFilesOnly() throws {
        let (store, _) = try makeStore()
        let item = try install(store, "keep")
        let oldStaged = store.stagingURL()
        let freshStaged = store.stagingURL()
        try Data(count: 10).write(to: oldStaged)
        try Data(count: 10).write(to: freshStaged)
        store.saveResumeData(Data(count: 5), songKey: "x", url: "https://h/x")
        let longAgo = Date().addingTimeInterval(-10 * 86_400)
        try fm.setAttributes([.modificationDate: longAgo], ofItemAtPath: oldStaged.path)
        let resumeFile = try XCTUnwrap(fm.contentsOfDirectory(at: store.resumeDirectory, includingPropertiesForKeys: nil).first)
        try fm.setAttributes([.modificationDate: longAgo], ofItemAtPath: resumeFile.path)

        store.cleanTemporary()

        XCTAssertFalse(fm.fileExists(atPath: oldStaged.path))
        XCTAssertTrue(fm.fileExists(atPath: freshStaged.path), "a recent staged file may still be installing")
        XCTAssertNil(store.resumeData(songKey: "x", url: "https://h/x"))
        XCTAssertNotNil(store.fileURL(for: item), "installed files are never touched")
    }

    func testResumeDataIsKeyedByUrlAndClearedPerSong() throws {
        let (store, _) = try makeStore()
        store.saveResumeData(Data("A".utf8), songKey: "s", url: "https://media/s.mp3")
        store.saveResumeData(Data("B".utf8), songKey: "s", url: "https://proxy/s")
        XCTAssertEqual(store.resumeData(songKey: "s", url: "https://media/s.mp3"), Data("A".utf8))
        XCTAssertEqual(store.resumeData(songKey: "s", url: "https://proxy/s"), Data("B".utf8))
        XCTAssertNil(store.resumeData(songKey: "s", url: "https://other/s"), "resume data is only valid for the same URL")
        store.clearResumeData(songKey: "s")
        XCTAssertNil(store.resumeData(songKey: "s", url: "https://media/s.mp3"))
        XCTAssertNil(store.resumeData(songKey: "s", url: "https://proxy/s"))
    }

    func testRemoveDeletesFileAndEntry() throws {
        let (store, _) = try makeStore()
        let item = try install(store, "a")
        let file = try XCTUnwrap(store.fileURL(for: item))
        store.remove(songKey: "a")
        XCTAssertFalse(fm.fileExists(atPath: file.path))
        XCTAssertNil(store.item(songKey: "a"))
    }
}
