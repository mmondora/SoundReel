// LikesStore.swift — the like on the phone (docs/mondrop-likes.md, spec 2026-11-10-mondrop-like-and-repeat-design.md L1–L3, ADR-0028).
//
// The heart shows at once (the rules are in `LikesState`); the operation waits in a file on the phone and goes to SoundReel when there is a
// network, in order, like the listens do. Flushes happen at launch, when the app comes to the front, right after each like, and by
// themselves with a growing wait while the app plays on in the background (a like given in a tunnel must not wait for the user to open the
// app). After what was waiting has been sent, the server's set is read: it is the truth.
//
// What a failure does: a 400 (a key the server cannot take) is dropped and the others go on; no network or a 5xx keeps everything, in order,
// and tries again after 30 s, doubling up to 15 minutes; a 404 is a server that has no likes yet (SoundReel 2.25.0 is later than this app):
// everything is kept, nothing is said, and it is tried again at the next launch or the next time the app is in front; a key that is missing
// or refused (401, 403) keeps everything and waits for a new key. Another person on the same phone never inherits the likes of the first.

import Foundation

@MainActor
public final class LikesStore: ObservableObject {
    public static let shared = LikesStore(
        directory: OfflineStore.defaultRoot(), transport: MondropAPI(), currentUser: { Settings.shared.autheliaUsername }
    )

    /// Goes up whenever what a heart shows may have changed: the screens that draw hearts watch this.
    @Published public private(set) var revision = 0
    /// The last answer said there are no likes on the server (an older SoundReel). Nothing is shown to the user for it.
    public private(set) var serverLooksOld = false

    private enum Failure {
        case refused, serverTooOld, needsKey, cancelled
        case transient
    }

    private var state: LikesState
    private let fileURL: URL
    private let transport: LikesTransport
    private let currentUser: @Sendable () -> String
    private let clock: PreparationClock
    private let autoFlush: Bool
    private let backoffBase: TimeInterval = 30
    private let backoffCap: TimeInterval = 15 * 60
    private var isFlushing = false
    private var needsAnotherPass = false
    private var consecutiveFailures = 0
    private var retryTask: Task<Void, Never>?
    private var pendingFlush: Task<Void, Never>?

    public init(
        directory: URL, transport: LikesTransport, currentUser: @escaping @Sendable () -> String,
        clock: PreparationClock = .real, autoFlush: Bool = true
    ) {
        self.fileURL = directory.appendingPathComponent("likes.json")
        self.transport = transport
        self.currentUser = currentUser
        self.clock = clock
        self.autoFlush = autoFlush
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: fileURL), let kept = try? EventCoding.decoder().decode(LikesState.self, from: data) {
            state = kept
        } else {
            state = LikesState()
        }
        checkOwner()
    }

    // MARK: - What the screens ask

    public func isLiked(_ songKey: String) -> Bool { state.isLiked(songKey) }

    /// How many operations have not been told to the server yet.
    public var pendingCount: Int { state.pending.count }

    /// Every song the hearts show full.
    public var likedKeys: Set<String> { state.likedKeys }

    /// The user likes or unlikes. `false` when it already was so. Goes to SoundReel right away when there is a network.
    @discardableResult
    public func setLiked(_ liked: Bool, songKey: String, at: Date = Date()) -> Bool {
        guard !songKey.isEmpty else { return false }
        checkOwner()
        guard state.setLiked(liked, songKey: songKey, at: at) else { return false }
        persist()
        revision += 1
        if autoFlush { scheduleFlush() }
        return true
    }

    /// The heart as a switch: the new state.
    @discardableResult
    public func toggle(songKey: String, at: Date = Date()) -> Bool {
        setLiked(!isLiked(songKey), songKey: songKey, at: at)
        return isLiked(songKey)
    }

    /// The key or the name of the user may have changed (a new key was issued, the app came to the front): another person starts from nothing.
    public func userMayHaveChanged() { checkOwner() }

    // MARK: - Flush

    /// Sends what is waiting, in order, and then reads the server's set. One at a time: a second call while one is working only asks it to
    /// look again when it is done.
    public func flush() async {
        checkOwner()
        if isFlushing {
            needsAnotherPass = true
            return
        }
        isFlushing = true
        defer { isFlushing = false }
        repeat {
            needsAnotherPass = false
            guard await sendPending() else { return }
            await readServerSet()
        } while needsAnotherPass || !state.pending.isEmpty
    }

    /// For tests: wait for a flush scheduled by `setLiked`.
    func waitForScheduledFlush() async { await pendingFlush?.value }

    /// For tests: wait for the retry that a failure scheduled.
    func waitForRetry() async { await retryTask?.value }

    private func scheduleFlush() {
        if isFlushing {
            needsAnotherPass = true
            return
        }
        guard pendingFlush == nil else { return }
        pendingFlush = Task { [weak self] in
            await self?.flush()
            self?.pendingFlush = nil
        }
    }

    /// Every operation, oldest first. `false` when it must stop here (a failure that is not the operation's fault).
    private func sendPending() async -> Bool {
        while let op = state.beginSending() {
            do {
                switch op.kind {
                case .like: _ = try await transport.putLike(songKey: op.songKey, at: op.at)
                case .unlike: _ = try await transport.deleteLike(songKey: op.songKey)
                }
                state.settle(op)
                persist()
                consecutiveFailures = 0
                serverLooksOld = false
                retryTask?.cancel()
                retryTask = nil
            } catch {
                switch classify(error) {
                case .refused:
                    state.drop(op)
                    persist()
                    revision += 1
                case .serverTooOld:
                    state.failed(op)
                    serverLooksOld = true
                    return false
                case .needsKey, .cancelled:
                    state.failed(op)
                    return false
                case .transient:
                    state.failed(op)
                    scheduleRetry()
                    return false
                }
            }
        }
        return true
    }

    private func readServerSet() async {
        do {
            let snapshot = try await transport.fetchLikes()
            let before = state.likedKeys
            state.adopt(serverKeys: Set(snapshot.likes.map(\.songKey)))
            serverLooksOld = false
            persist()
            if state.likedKeys != before { revision += 1 }
        } catch {
            // What the phone knew stays: the next flush reads it again.
            if case .serverTooOld = classify(error) { serverLooksOld = true }
        }
    }

    private func classify(_ error: Error) -> Failure {
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return .cancelled }
        guard let api = error as? MondropAPIError else { return .transient }
        switch api {
        case .missingApiKey, .missingUser, .badUrl:
            return .needsKey
        case .http(let code, _):
            switch code {
            case 401, 403: return .needsKey
            case 404: return .serverTooOld
            case 408, 429: return .transient
            case 400..<500: return .refused
            default: return .transient          // a 5xx, or no status at all
            }
        case .transport, .decode:
            return .transient
        }
    }

    private func scheduleRetry() {
        consecutiveFailures += 1
        let delay = min(backoffCap, backoffBase * pow(2, Double(consecutiveFailures - 1)))
        retryTask?.cancel()
        retryTask = Task { [weak self, clock] in
            do { try await clock.sleep(delay) } catch { return }
            await self?.retryFired()
        }
    }

    private func retryFired() async {
        retryTask = nil                         // the next failure schedules a new one: this task must not cancel itself
        await flush()
    }

    // MARK: - Whose they are, and the file

    private static func normalized(_ name: String) -> String { name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    /// Nobody signed in (an empty name) changes nothing: the likes wait for a key.
    private func checkOwner() {
        let user = Self.normalized(currentUser())
        guard !user.isEmpty, user != state.owner else { return }
        state.reset(owner: user)
        persist()
        revision += 1
    }

    private func persist() {
        guard let data = try? EventCoding.encoder().encode(state) else { return }
        try? data.write(to: fileURL, options: .atomic)
        OfflineStore.excludeFromBackup(fileURL)
    }
}
