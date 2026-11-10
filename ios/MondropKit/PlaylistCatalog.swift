// PlaylistCatalog.swift — the playlists Siri can be asked for by name (spec 2026-11-10-mondrop-like-and-repeat-design.md L10; Michele:
// «manca la lista canzoni o playlist», «1»). The Tesla shows no list over Bluetooth, so «metti la playlist Road trip su Mondrop» is how he
// picks. The names are the ones the app ALREADY knows (it reads the whole list at every opening, dynamic and automatic playlists included);
// this keeps them where an intent can read them, and tells the app when they change so that Siri can learn them. Matching a spoken name to
// them is plain code.

import Foundation

/// What Siri needs to know of a playlist: which one, and what it is called.
public struct KnownPlaylist: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public enum PlaylistMatcher {
    /// The words of a name as they are compared: lower case, no accents, no punctuation, single spaces. Siri hears «anni ottanta» as words
    /// and digits and never writes the apostrophe of «Anni '80»; «più» is «piu» to it.
    public static func normalize(_ text: String) -> String {
        let folded = text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "it_IT"))
        let letters = String(String.UnicodeScalarView(folded.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? $0 : " " }))
        return letters.split(separator: " ").joined(separator: " ")
    }

    /// The playlists a spoken name can mean, best first. One: Siri goes on. Several that fit equally well: Siri asks which one. None: «non
    /// trovo». An exact name wins over the ones that only start with it («Rap» is not «Rap italiano»); then the beginning of a name, then
    /// all the words in any order, then the beginnings of the words, then a piece of a word.
    public static func candidates(for spoken: String, in playlists: [KnownPlaylist]) -> [KnownPlaylist] {
        let want = normalize(spoken)
        guard !want.isEmpty else { return [] }
        let wantWords = want.split(separator: " ").map(String.init)
        var best = 0
        var found: [KnownPlaylist] = []
        for playlist in playlists {
            let name = normalize(playlist.name)
            guard !name.isEmpty else { continue }
            let score = Self.score(want: want, wantWords: wantWords, name: name)
            guard score > 0, score >= best else { continue }
            if score > best {
                best = score
                found = []
            }
            found.append(playlist)
        }
        return found.sorted { ($0.name.lowercased(), $0.id) < ($1.name.lowercased(), $1.id) }
    }

    private static func score(want: String, wantWords: [String], name: String) -> Int {
        if name == want { return 100 }
        if name.hasPrefix(want + " ") { return 80 }
        let nameWords = name.split(separator: " ").map(String.init)
        if wantWords.allSatisfy({ nameWords.contains($0) }) { return 60 }
        if wantWords.allSatisfy({ word in nameWords.contains { $0.hasPrefix(word) } }) { return 40 }
        if name.contains(want) { return 20 }
        return 0
    }
}

/// The playlists of the person, kept in the App Group (a file the intent reads, whenever Siri runs it). Written by the app wherever it reads
/// the whole list.
public final class PlaylistCatalog: @unchecked Sendable {
    public static let shared = PlaylistCatalog(url: AppGroupFiles.url("siri-playlists.json"))

    private struct File: Codable {
        var user: String
        var updatedAt: Date
        var playlists: [KnownPlaylist]
    }

    /// Told when the NAMES changed (a new playlist, a renamed one, a deleted one), outside the lock: the app asks Siri to learn them.
    public var onChange: (@Sendable () -> Void)?

    private let url: URL
    private let lock = NSLock()

    public init(url: URL) { self.url = url }

    private static func normalized(user: String) -> String { user.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    /// Keeps EVERY playlist the app knows, not only the ones the share sheet offers: the dynamic and the automatic ones are asked for by
    /// voice like the others. A playlist with no name is left out (nobody can say it). `true` when the list of names changed.
    @discardableResult
    public func remember(_ playlists: [MondropPlaylist], user: String, at date: Date = Date()) -> Bool {
        let known = playlists
            .filter { !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .map { KnownPlaylist(id: $0.id, name: $0.name) }
        let who = Self.normalized(user: user)
        let changed: Bool = lock.withLock {
            let before = Self.read(url)
            let same = before?.user == who && Set(before?.playlists.map { "\($0.id)\u{1}\($0.name)" } ?? []) == Set(known.map { "\($0.id)\u{1}\($0.name)" })
            if let data = try? Self.encoder().encode(File(user: who, updatedAt: date, playlists: known)) { AppGroupFiles.write(data, to: url) }
            return !same
        }
        if changed { onChange?() }
        return changed
    }

    /// The playlists of this person; nothing when the file was written for someone else (a renewed key may belong to another person).
    public func playlists(forUser user: String) -> [KnownPlaylist] {
        lock.withLock {
            guard let file = Self.read(url), file.user == Self.normalized(user: user) else { return [] }
            return file.playlists
        }
    }

    public func clear() {
        lock.withLock { try? FileManager.default.removeItem(at: url) }
    }

    private static func read(_ url: URL) -> File? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder().decode(File.self, from: data)
    }

    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
