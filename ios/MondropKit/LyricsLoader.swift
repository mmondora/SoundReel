// LyricsLoader.swift — the words of the song that is playing (ADR-0021, spec 2026-11-08-lyrics-from-the-internet-design.md L2, L8).
// Michele, 8 November: «Nel player iOS voglio avere la copertina del disco o della canzone se non c'è trovale su Internet, come le
// parole» and, asked whether the words should be searched on the Internet when they are missing: «Sì, cercale su Internet».
//
// The SERVER finds them (the transcript of the post when there is one, else what it found and kept) and the app asks SoundReel — and
// only SoundReel (rule P): it never talks to an archive of lyrics. What SoundReel FOUND (a text from the Internet, an instrumental) the
// phone keeps (Caches, like the covers), so a song shows its words offline too; its answers «the transcript of the post» it does not
// keep (spec L12: they may be only a fragment, and the server will have a text when the Internet does: asked again). «No words» is
// remembered for a day, an unreachable server is not an answer and is asked again.

import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

/// What SoundReel says about the words of a song.
public struct SongLyrics: Equatable, Sendable, Codable {
    public enum Source: String, Codable, Sendable {
        /// The transcript of the post the song was found in.
        case transcript
        /// Found on the Internet by the server.
        case internet
    }

    public let text: String
    public let source: Source
    /// An instrumental has no words: `text` is empty and the app says so.
    public let instrumental: Bool

    public init(text: String, source: Source, instrumental: Bool = false) {
        self.text = text
        self.source = source
        self.instrumental = instrumental
    }
}

public protocol LyricsTransport: Sendable {
    /// nil when SoundReel has no words for the song (a 404 of either kind). Throws when it could not be asked (offline, a server error).
    func lyrics(songKey: String) async throws -> SongLyrics?
}

extension MondropAPI: LyricsTransport {
    /// `GET /api/mondrop/songs/:key/lyrics`. Read-only. An older server answers 404 too: «no words».
    public func lyrics(songKey: String) async throws -> SongLyrics? {
        struct Wire: Decodable {
            let lyrics: String?
            let source: String?
            let instrumental: Bool?
        }
        do {
            let data = try await sendRequest(path: Self.songPath(songKey, suffix: "/lyrics"), timeout: 30)
            let wire = try decodeBody(Wire.self, from: data)
            let instrumental = wire.instrumental ?? false
            let text = wire.lyrics ?? ""
            guard instrumental || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return SongLyrics(text: text, source: SongLyrics.Source(rawValue: wire.source ?? "") ?? .internet, instrumental: instrumental)
        } catch let error as MondropAPIError {
            if case .http(404, _) = error { return nil }
            throw error
        }
    }
}

public final class LyricsLoader: @unchecked Sendable {
    public static let shared = LyricsLoader(transport: MondropAPI())

    /// «No words» is remembered this long (the server itself remembers it for a week).
    static let missingTTL: TimeInterval = 24 * 60 * 60

    private let transport: LyricsTransport
    private let directory: URL
    private let now: () -> Date
    private let lock = NSLock()
    private var running: [String: Task<SongLyrics?, Never>] = [:]

    public init(transport: LyricsTransport, directory: URL = LyricsLoader.defaultDirectory, now: @escaping () -> Date = Date.init) {
        self.transport = transport
        self.directory = directory
        self.now = now
    }

    /// `Caches/Mondrop/lyrics`: the system may empty it when the phone runs out of space; the words are asked again then.
    public static var defaultDirectory: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        return caches.appendingPathComponent("Mondrop", isDirectory: true).appendingPathComponent("lyrics", isDirectory: true)
    }

    // MARK: - What the phone already has

    /// What the phone keeps is what SoundReel FOUND: a text from the Internet or an instrumental. An answer «transcript» is not kept
    /// (spec L12): it can be a fragment that the Internet will have a text for. A file an earlier build wrote for one is not believed.
    static func isKept(_ lyrics: SongLyrics) -> Bool { lyrics.source == .internet || lyrics.instrumental }

    /// The words the phone kept for the song (an earlier find), or nil. No network: safe to call at once when a song starts.
    public func cached(songKey: String) -> SongLyrics? {
        guard let data = try? Data(contentsOf: file(songKey, "json")),
              let kept = try? JSONDecoder().decode(SongLyrics.self, from: data), Self.isKept(kept) else { return nil }
        return kept
    }

    // MARK: - Asking SoundReel

    /// The words of a song: the phone's copy, else SoundReel's. nil when there are none (or SoundReel could not be asked). One request
    /// per song at a time: two screens asking for the same song share it.
    public func fetch(songKey: String) async -> SongLyrics? {
        if let kept = cached(songKey: songKey) { return kept }
        if isKnownMissing(songKey) { return nil }
        enum Plan { case join(Task<SongLyrics?, Never>), start(Task<SongLyrics?, Never>) }
        let plan: Plan = lock.withLock {
            if let task = running[songKey] { return .join(task) }
            let task = Task { await self.ask(songKey) }
            running[songKey] = task
            return .start(task)
        }
        switch plan {
        case .join(let task):
            return await task.value
        case .start(let task):
            let result = await task.value
            lock.withLock { running[songKey] = nil }
            return result
        }
    }

    private func ask(_ songKey: String) async -> SongLyrics? {
        do {
            if let found = try await transport.lyrics(songKey: songKey) {
                keep(songKey, found)
                return found
            }
            rememberMissing(songKey)
            return nil
        } catch {
            return nil                  // offline, a hiccup of the server: not an answer, asked again next time
        }
    }

    // MARK: - Keeping it

    /// A name that is the same for the same song and safe for any key (slashes, accents, length).
    static func fileStem(_ songKey: String) -> String {
        #if canImport(CryptoKit)
        return SHA256.hash(data: Data(songKey.utf8)).map { String(format: "%02x", $0) }.joined()
        #else
        return String(songKey.unicodeScalars.reduce(UInt64(5381)) { ($0 &* 33) &+ UInt64($1.value) }, radix: 16)
        #endif
    }

    private func file(_ songKey: String, _ ext: String) -> URL {
        directory.appendingPathComponent(Self.fileStem(songKey)).appendingPathExtension(ext)
    }

    private func keep(_ songKey: String, _ lyrics: SongLyrics) {
        guard Self.isKept(lyrics) else { return }          // the transcript of the post is asked again (spec L12)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try JSONEncoder().encode(lyrics).write(to: file(songKey, "json"), options: .atomic)
            try? FileManager.default.removeItem(at: file(songKey, "none"))
        } catch {
            // the answer still serves this session; it is only asked again next time
        }
    }

    /// The moment is written IN the file (not its date): the clock of the loader says when «no words» was learned, and the same clock
    /// says when it is old.
    private func rememberMissing(_ songKey: String) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try Data(String(now().timeIntervalSince1970).utf8).write(to: file(songKey, "none"), options: .atomic)
        } catch {
            // asked again next time
        }
    }

    private func isKnownMissing(_ songKey: String) -> Bool {
        guard let data = try? Data(contentsOf: file(songKey, "none")),
              let text = String(data: data, encoding: .utf8), let since = Double(text) else { return false }
        let age = now().timeIntervalSince1970 - since
        return age >= 0 && age < Self.missingTTL            // a clock that went back is not a reason to stay silent for ever
    }
}
