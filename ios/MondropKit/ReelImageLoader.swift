// ReelImageLoader.swift — the small picture of a reel (spec 2026-11-12-mondrop-home-play-loop-reels-design.md M5, ADR-0033).
//
// The app asks SoundReel for it — only SoundReel — with the key, and keeps what it has seen in the system caches (`Caches/Mondrop/reels`, which iOS empties when the phone needs the room), so that
// a list that scrolls does not ask twice. It is the one thing of a reel that stays on the phone, and only as a convenience: the reels themselves are read from the network each time.

import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

public final class ReelImageLoader: @unchecked Sendable {
    public static let shared = ReelImageLoader()

    /// Pictures kept in memory, newest last. A picture is a 320 px JPEG of a few tens of KB.
    static let memoryLimit = 60

    private let session: URLSession
    private let config: @Sendable () -> MondropAPIConfig
    private let directory: URL
    private let lock = NSLock()
    private var memory: [String: Data] = [:]
    private var order: [String] = []
    /// Reels the server said have no picture, this session: not asked again until the app starts.
    private var missing = Set<String>()
    private var running: [String: Task<Data?, Never>] = [:]

    public init(
        session: URLSession = .shared,
        config: @escaping @Sendable () -> MondropAPIConfig = { MondropAPIConfig.current() },
        directory: URL = ReelImageLoader.defaultDirectory
    ) {
        self.session = session
        self.config = config
        self.directory = directory
    }

    /// `Caches/Mondrop/reels`.
    public static var defaultDirectory: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        return caches.appendingPathComponent("Mondrop", isDirectory: true).appendingPathComponent("reels", isDirectory: true)
    }

    // MARK: - What the phone already has

    /// The picture this phone already has (memory, then the caches folder), or nil. No network.
    public func cached(reelId: String) -> Data? {
        if let hit = lock.withLock({ memory[reelId] }) { return hit }
        guard let data = try? Data(contentsOf: file(for: reelId)), CoverLoader.looksLikeImage(data) else { return nil }
        remember(reelId, data)
        return data
    }

    // MARK: - Asking SoundReel

    /// The picture of a reel: the phone's copy if there is one, else SoundReel's. nil when there is none (the card draws its own tile).
    public func data(reelId: String, imagePath: String?) async -> Data? {
        if let hit = cached(reelId: reelId) { return hit }
        enum Plan { case none, join(Task<Data?, Never>), start(Task<Data?, Never>) }
        let plan: Plan = lock.withLock {
            if missing.contains(reelId) { return .none }
            if let task = running[reelId] { return .join(task) }
            let task = Task { await self.fetch(reelId: reelId, imagePath: imagePath) }
            running[reelId] = task
            return .start(task)
        }
        switch plan {
        case .none: return nil
        case .join(let task): return await task.value
        case .start(let task):
            let result = await task.value
            lock.withLock { running[reelId] = nil }
            return result
        }
    }

    private func fetch(reelId: String, imagePath: String?) async -> Data? {
        let cfg = config()
        guard let url = DownloadURLChooser.proxyURL(path: Self.path(reelId: reelId, imagePath: imagePath), baseURL: cfg.baseURL),
              !cfg.apiKey.isBlank else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 25
        request.setValue("image/*", forHTTPHeaderField: "Accept")
        for (name, value) in cfg.authHeaders { request.setValue(value, forHTTPHeaderField: name) }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            switch http.statusCode {
            case 200:
                guard CoverLoader.looksLikeImage(data) else { return nil }      // a login page or an error body is not a picture
                keep(reelId, data)
                return data
            case 404:
                lock.withLock { _ = missing.insert(reelId) }
                return nil
            default:
                return nil                                                      // a hiccup of the server: asked again next time
            }
        } catch {
            return nil                                                          // offline: whatever the phone has was already tried
        }
    }

    // MARK: - Where the picture is asked

    /// The path to GET. The contract sends a path relative to the backend; an absolute address there would make the app hand its API key to another host, so it is ignored in favour of
    /// the canonical path (same rule as the covers and `downloadPath`).
    static func path(reelId: String, imagePath: String?) -> String {
        if let raw = imagePath?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty, !raw.contains("://"), !raw.hasPrefix("//") {
            return raw.hasPrefix("/") ? raw : "/" + raw
        }
        return "/api/mondrop/reels/\(MondropAPI.encodeSongKey(reelId))/image"
    }

    // MARK: - Keeping it

    private func file(for reelId: String) -> URL {
        directory.appendingPathComponent(Self.fileName(reelId))
    }

    static func fileName(_ reelId: String) -> String {
        #if canImport(CryptoKit)
        let digest = SHA256.hash(data: Data(reelId.utf8))
        return digest.map { String(format: "%02x", $0) }.joined() + ".img"
        #else
        return String(reelId.unicodeScalars.reduce(UInt64(5381)) { ($0 &* 33) &+ UInt64($1.value) }, radix: 16) + ".img"
        #endif
    }

    private func keep(_ reelId: String, _ data: Data) {
        remember(reelId, data)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: file(for: reelId), options: .atomic)
        } catch {
            // the memory copy still serves this session
        }
    }

    private func remember(_ reelId: String, _ data: Data) {
        lock.withLock {
            memory[reelId] = data
            order.removeAll { $0 == reelId }
            order.append(reelId)
            while order.count > Self.memoryLimit {
                memory[order.removeFirst()] = nil
            }
        }
    }
}
