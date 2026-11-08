import XCTest
@testable import Mondrop

/// A SoundReel that answers the question «the words of this song?» from a script (in the order of the questions) or, with `bySong`, with
/// the answer of THAT song whatever the order (two held questions released together are answered in no fixed order), counts the questions
/// and — when `held` — keeps the answer until `release()`: to see what the app does while it waits.
final class FakeLyricsTransport: LyricsTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var script: [Result<SongLyrics?, Error>]
    private let bySong: [String: Result<SongLyrics?, Error>]?
    private var _asked: [String] = []
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var held: Bool

    var asked: [String] { lock.withLock { _asked } }

    init(_ script: [Result<SongLyrics?, Error>], held: Bool = false) {
        self.script = script
        self.bySong = nil
        self.held = held
    }

    /// Each song has its own answer (a song that is not listed has no words).
    init(bySong: [String: Result<SongLyrics?, Error>], held: Bool = false) {
        self.script = []
        self.bySong = bySong
        self.held = held
    }

    func lyrics(songKey: String) async throws -> SongLyrics? {
        let mustWait: Bool = lock.withLock {
            _asked.append(songKey)
            return held
        }
        if mustWait {
            await withCheckedContinuation { continuation in
                let releaseNow: Bool = lock.withLock {
                    if held { waiters.append(continuation); return false }
                    return true
                }
                if releaseNow { continuation.resume() }
            }
        }
        let next: Result<SongLyrics?, Error> = lock.withLock {
            if let bySong { return bySong[songKey] ?? .success(nil) }
            return script.count > 1 ? script.removeFirst() : script[0]
        }
        return try next.get()
    }

    /// Lets the held answers go (and every answer after this one is not held).
    func release() {
        let pending: [CheckedContinuation<Void, Never>] = lock.withLock {
            held = false
            let all = waiters
            waiters = []
            return all
        }
        pending.forEach { $0.resume() }
    }
}
