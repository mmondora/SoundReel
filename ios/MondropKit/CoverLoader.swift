// CoverLoader.swift — the cover of the song that is playing (ADR-0019, spec 2026-11-08-player-cover-art-design.md C1, C5, C6).
//
// The SERVER finds the cover (the one it already knows, the picture inside the file, the Internet) and keeps it. The app asks
// SoundReel — and only SoundReel: never iTunes, never Deezer (rule P) — for the track's `coverPath`, keeps what it has seen on
// the phone (so a downloaded song shows its cover without network) and, when the server has none, the player draws its own.

import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

public final class CoverLoader: @unchecked Sendable {
    public static let shared = CoverLoader()

    /// Covers kept in memory, newest last. A cover is at most 800×800 JPEG, a few hundred KB.
    static let memoryLimit = 24

    private let session: URLSession
    private let config: @Sendable () -> MondropAPIConfig
    private let directory: URL
    private let lock = NSLock()
    private var memory: [String: Data] = [:]
    private var order: [String] = []
    /// Songs the server said it has no cover for, this session: not asked again until the app starts (the server itself remembers
    /// «no cover» for three days, so asking again later is cheap).
    private var missing = Set<String>()
    private var running: [String: Task<Data?, Never>] = [:]

    public init(
        session: URLSession = .shared,
        config: @escaping @Sendable () -> MondropAPIConfig = { MondropAPIConfig.current() },
        directory: URL = CoverLoader.defaultDirectory
    ) {
        self.session = session
        self.config = config
        self.directory = directory
    }

    /// `Caches/Mondrop/covers`: the system may empty it when the phone runs out of space; a cover is asked again then.
    public static var defaultDirectory: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        return caches.appendingPathComponent("Mondrop", isDirectory: true).appendingPathComponent("covers", isDirectory: true)
    }

    // MARK: - What the phone already has

    /// The cover this phone already has for the song (memory, then the disk), or nil. No network: safe to call at once when a song starts.
    public func cached(songKey: String) -> Data? {
        if let hit = lock.withLock({ memory[songKey] }) { return hit }
        guard let data = try? Data(contentsOf: file(for: songKey)), Self.looksLikeImage(data) else { return nil }
        remember(songKey, data)
        return data
    }

    // MARK: - Asking SoundReel

    /// The cover of a song: the phone's copy if there is one, else SoundReel's. nil when there is none (the player draws its own).
    public func data(songKey: String, coverPath: String?) async -> Data? {
        if let hit = cached(songKey: songKey) { return hit }
        enum Plan { case none, join(Task<Data?, Never>), start(Task<Data?, Never>) }
        let plan: Plan = lock.withLock {
            if missing.contains(songKey) { return .none }
            if let task = running[songKey] { return .join(task) }
            let task = Task { await self.fetch(songKey: songKey, coverPath: coverPath) }
            running[songKey] = task
            return .start(task)
        }
        switch plan {
        case .none: return nil
        case .join(let task): return await task.value
        case .start(let task):
            let result = await task.value
            lock.withLock { running[songKey] = nil }
            return result
        }
    }

    private func fetch(songKey: String, coverPath: String?) async -> Data? {
        let cfg = config()
        guard let url = DownloadURLChooser.proxyURL(path: Self.path(songKey: songKey, coverPath: coverPath), baseURL: cfg.baseURL),
              !cfg.apiKey.isBlank else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 25
        request.cachePolicy = .reloadIgnoringLocalCacheData      // the phone keeps its own copy
        request.setValue("image/*", forHTTPHeaderField: "Accept")
        for (name, value) in cfg.authHeaders { request.setValue(value, forHTTPHeaderField: name) }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            switch http.statusCode {
            case 200:
                guard Self.looksLikeImage(data) else { return nil }     // a login page or an error body is not a cover
                keep(songKey, data)
                return data
            case 404:
                lock.withLock { _ = missing.insert(songKey) }
                return nil
            default:
                return nil                                              // a hiccup of the server: asked again next time
            }
        } catch {
            return nil                                                  // offline: whatever the phone has was already tried
        }
    }

    // MARK: - Where the cover is asked

    /// The path to GET. The contract sends a path relative to the backend; an absolute address there would make the app hand its
    /// API key to another host, so it is ignored in favour of the canonical path (same rule as `downloadPath`).
    static func path(songKey: String, coverPath: String?) -> String {
        if let raw = coverPath?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty, !raw.contains("://"), !raw.hasPrefix("//") {
            return raw.hasPrefix("/") ? raw : "/" + raw
        }
        return MondropAPI.songPath(songKey, suffix: "/cover")
    }

    // MARK: - Keeping it

    private func file(for songKey: String) -> URL {
        directory.appendingPathComponent(Self.fileName(songKey))
    }

    /// A name that is the same for the same song and safe for any key (slashes, accents, length).
    static func fileName(_ songKey: String) -> String {
        #if canImport(CryptoKit)
        let digest = SHA256.hash(data: Data(songKey.utf8))
        return digest.map { String(format: "%02x", $0) }.joined() + ".img"
        #else
        return String(songKey.unicodeScalars.reduce(UInt64(5381)) { ($0 &* 33) &+ UInt64($1.value) }, radix: 16) + ".img"
        #endif
    }

    private func keep(_ songKey: String, _ data: Data) {
        remember(songKey, data)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: file(for: songKey), options: .atomic)
        } catch {
            // the memory copy still serves this session
        }
    }

    private func remember(_ songKey: String, _ data: Data) {
        lock.withLock {
            memory[songKey] = data
            order.removeAll { $0 == songKey }
            order.append(songKey)
            while order.count > Self.memoryLimit {
                memory[order.removeFirst()] = nil
            }
        }
    }

    /// JPEG, PNG, GIF or WebP by the first bytes.
    static func looksLikeImage(_ data: Data) -> Bool {
        guard data.count >= 12 else { return false }
        let b = [UInt8](data.prefix(12))
        if b[0] == 0xFF, b[1] == 0xD8, b[2] == 0xFF { return true }
        if b[0] == 0x89, b[1] == 0x50, b[2] == 0x4E, b[3] == 0x47 { return true }
        if b[0] == 0x47, b[1] == 0x49, b[2] == 0x46 { return true }
        if b[0] == 0x52, b[1] == 0x49, b[2] == 0x46, b[3] == 0x46, b[8] == 0x57, b[9] == 0x45, b[10] == 0x42, b[11] == 0x50 { return true }
        return false
    }
}
