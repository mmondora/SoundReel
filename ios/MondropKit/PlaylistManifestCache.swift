// PlaylistManifestCache.swift — the list of a playlist, kept on the phone (Michele, 11 November, trying build 16: «E quando da homepage clicco sulla playlist devo
// vedere la lista e poter mettere in play. Nessun sync evidente, tutto automatico.»; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U11).
//
// Every time the phone reads a playlist (`GET …/offline`, or the answer of `prepare`) it keeps what came back, one small file per playlist; the page of a playlist
// is drawn from it in its first frame — the list and «Suona» are there at once, and offline — and SoundReel is asked again behind it. The file is a copy of what the
// server said, never a decision: the page replaces it as soon as the server answers, and a failed reading leaves it alone.

import Foundation

/// What the page of a playlist needs to keep and recall a list (a fake in tests).
public protocol PlaylistManifestCaching: AnyObject, Sendable {
    func load(playlistId: String) -> OfflineManifest?
    func save(_ manifest: OfflineManifest)
    /// Playlists deleted on the server stop being kept.
    func prune(keeping ids: Set<String>)
}

public final class FilePlaylistManifestCache: PlaylistManifestCaching, @unchecked Sendable {
    /// The one of the app: next to the songs, in the folder the store keeps out of the backups.
    public static let shared = FilePlaylistManifestCache(directory: OfflineStore.shared.root.appendingPathComponent("Playlists", isDirectory: true))

    private let directory: URL
    private let fm: FileManager
    private let lock = NSLock()

    public init(directory: URL, fileManager: FileManager = .default) {
        self.directory = directory
        self.fm = fileManager
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    /// One file per playlist, named from its id in a way that cannot leave the folder (and can be read back for `prune`): the id as URL-safe base64.
    func fileURL(playlistId: String) -> URL {
        directory.appendingPathComponent(Self.fileName(for: playlistId))
    }

    static func fileName(for id: String) -> String {
        let encoded = Data(id.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "pl-\(encoded).json"
    }

    static func playlistId(fromFileName name: String) -> String? {
        guard name.hasPrefix("pl-"), name.hasSuffix(".json") else { return nil }
        var encoded = String(name.dropFirst(3).dropLast(5))
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while encoded.count % 4 != 0 { encoded += "=" }
        return Data(base64Encoded: encoded).flatMap { String(data: $0, encoding: .utf8) }
    }

    public func load(playlistId: String) -> OfflineManifest? {
        lock.lock(); defer { lock.unlock() }
        let url = fileURL(playlistId: playlistId)
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let manifest = try? JSONDecoder().decode(OfflineManifest.self, from: data) else {
            try? fm.removeItem(at: url)         // a damaged file would fail again at every opening
            return nil
        }
        return manifest
    }

    public func save(_ manifest: OfflineManifest) {
        lock.lock(); defer { lock.unlock() }
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(manifest) else { return }
        try? data.write(to: fileURL(playlistId: manifest.playlistId), options: .atomic)
    }

    public func prune(keeping ids: Set<String>) {
        lock.lock(); defer { lock.unlock() }
        let names = (try? fm.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names {
            guard let id = Self.playlistId(fromFileName: name), !ids.contains(id) else { continue }
            try? fm.removeItem(at: directory.appendingPathComponent(name))
        }
    }
}
