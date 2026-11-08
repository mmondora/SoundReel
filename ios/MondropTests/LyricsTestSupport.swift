import XCTest
@testable import Mondrop

/// A SoundReel that answers the question «the words of this song?» from a script, counts the questions and — when `held` — keeps the
/// answer until `release()`: to see what the app does while it waits.
final class FakeLyricsTransport: LyricsTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var script: [Result<SongLyrics?, Error>]
    private var _asked: [String] = []
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var held: Bool

    var asked: [String] { lock.withLock { _asked } }

    init(_ script: [Result<SongLyrics?, Error>], held: Bool = false) {
        self.script = script
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
        let next: Result<SongLyrics?, Error> = lock.withLock { script.count > 1 ? script.removeFirst() : script[0] }
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
