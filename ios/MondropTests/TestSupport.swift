import XCTest
@testable import Mondrop

// Shared fakes for the sync tests. Nothing here touches the network, Settings or the real OfflineStore.

enum TestSupport {
    static func tempDir(_ name: String = "mondrop-test") throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// A ready track by default; override what the test cares about.
    static func track(
        _ key: String,
        state: String? = "ready",
        version: String? = "100-1",
        bytes: Int? = 100,
        mediaUrl: String? = nil,
        downloadPath: String? = nil,
        error: String? = nil,
        status: String? = nil,
        title: String? = nil,
        artist: String = "Artist",
        album: String? = nil,
        genres: [String] = [],
        year: Int? = nil
    ) -> OfflineTrack {
        OfflineTrack(
            songKey: key,
            title: title ?? key,
            artist: artist,
            status: status,
            state: state,
            source: "ytdlp",
            downloadPath: downloadPath ?? MondropAPI.songPath(key, suffix: "/file"),
            mediaUrl: mediaUrl,
            version: version,
            bytes: bytes,
            error: error,
            coverUrl: "https://img.test/\(key).jpg",
            album: album,
            genres: genres,
            year: year
        )
    }

    static func manifest(_ id: String = "pl1", _ tracks: [OfflineTrack]) -> OfflineManifest {
        OfflineManifest(playlistId: id, name: "Playlist \(id)", tracks: tracks, user: "mike")
    }
}

extension EngineConfig {
    static let test = EngineConfig(baseURL: "https://soundreel.test", apiKey: "sr_test_key_0123456789abcdef", user: "mike")
}

extension MondropAPIConfig {
    static let test = MondropAPIConfig(baseURL: "https://soundreel.test", apiKey: "sr_test_key_0123456789abcdef", user: "mike")
}

// MARK: - Transport

final class FakeTransport: DownloadTransport {
    weak var handler: DownloadTransportHandler?
    private(set) var started: [TransportJob] = []
    private(set) var cancelled: [String] = []
    var alive: [JobInfo] = []

    func start(_ job: TransportJob) { started.append(job) }
    func cancel(songKey: String) { cancelled.append(songKey) }
    func reattach(_ completion: @escaping @Sendable ([JobInfo]) -> Void) { completion(alive) }

    var startedKeys: [String] { started.map(\.info.songKey) }
}

/// Engine + store + fake transport in a temp dir.
@MainActor
struct EngineRig {
    let root: URL
    let store: OfflineStore
    let transport: FakeTransport
    let engine: SyncEngine

    init(
        config: EngineConfig = .test, persistQueue: Bool = false, root: URL? = nil, transport: FakeTransport = FakeTransport(),
        now: @escaping () -> Date = { Date() }
    ) throws {
        let dir = try root ?? TestSupport.tempDir("engine")
        self.root = dir
        self.store = OfflineStore(root: dir)
        self.transport = transport
        self.engine = SyncEngine(transport: transport, store: store, config: { config }, persistQueue: persistQueue, now: now)
    }

    /// A finished download, delivered exactly like the transport does (a file already in staging).
    /// By default the file has exactly the size the manifest promised (`info.bytes`), like a healthy download.
    func finish(_ info: JobInfo, bytes: Int? = nil, status: Int? = 200) throws {
        let staged = store.stagingURL()
        try Data(repeating: 7, count: bytes ?? info.bytes ?? 4096).write(to: staged)
        engine.handleFinished(info: info, stagedFile: staged, httpStatus: status)
    }

    func fail(_ info: JobInfo, message: String = "boom", resumeData: Data? = nil, requestURL: URL? = nil, cancelled: Bool = false) {
        engine.handleFailed(info: info, message: message, resumeData: resumeData, requestURL: requestURL, cancelled: cancelled)
    }

    /// Install a local copy as a finished download would.
    @discardableResult
    func installLocal(_ key: String, version: String?, bytes: Int = 100) throws -> OfflineStore.Item {
        let staged = store.stagingURL()
        try Data(repeating: 1, count: bytes).write(to: staged)
        return try store.install(
            stagedFile: staged,
            songKey: key,
            metadata: InstallMetadata(title: key, artist: "Artist", version: version)
        )
    }
}

// MARK: - API

final class FakeAPI: MondropAPIProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _playlists: [MondropPlaylist] = []
    private var manifestScripts: [String: [Result<OfflineManifest, Error>]] = [:]
    private var prepareScripts: [String: [OfflineManifest]] = [:]
    private var trackScripts: [String: [Result<OfflineTrack, Error>]] = [:]
    private var _net: Result<NetInfo, Error> = .success(NetInfo(viaCloudflare: false, home: true))
    private var _ack = DownloadAck(ok: true, state: "preparing", track: nil)
    private var _prepareError: Error?

    var calls: [String] { lock.withLock { _calls } }

    func setPlaylists(_ list: [MondropPlaylist]) { lock.withLock { _playlists = list } }
    func scriptManifests(_ id: String, _ list: [Result<OfflineManifest, Error>]) { lock.withLock { manifestScripts[id] = list } }
    func scriptPrepare(_ id: String, _ list: [OfflineManifest]) { lock.withLock { prepareScripts[id] = list } }
    func scriptTrack(_ key: String, _ list: [Result<OfflineTrack, Error>]) { lock.withLock { trackScripts[key] = list } }
    func failPrepare(_ error: Error?) { lock.withLock { _prepareError = error } }
    func setNet(_ value: Result<NetInfo, Error>) { lock.withLock { _net = value } }
    func setAck(_ ack: DownloadAck) { lock.withLock { _ack = ack } }

    /// Scripted answers are consumed in order; the last one repeats.
    private func next<T>(_ list: inout [T]) -> T? {
        guard !list.isEmpty else { return nil }
        return list.count > 1 ? list.removeFirst() : list[0]
    }

    func listPlaylists() async throws -> [MondropPlaylist] {
        lock.withLock { _calls.append("playlists"); return _playlists }
    }

    func offlineManifest(playlistId: String) async throws -> OfflineManifest {
        let result: Result<OfflineManifest, Error>? = lock.withLock {
            _calls.append("manifest:\(playlistId)")
            return next(&manifestScripts[playlistId, default: []])
        }
        guard let result else { throw MondropAPIError.http(404, "no script") }
        return try result.get()
    }

    func prepare(playlistId: String, retryFailed: Bool) async throws -> OfflineManifest {
        let failure = lock.withLock { _prepareError }
        if let failure {
            lock.withLock { _calls.append("prepare:\(playlistId):retry=\(retryFailed)") }
            throw failure
        }
        let result: OfflineManifest? = lock.withLock {
            _calls.append("prepare:\(playlistId):retry=\(retryFailed)")
            return next(&prepareScripts[playlistId, default: []])
        }
        guard let result else { throw MondropAPIError.http(404, "no script") }
        return result
    }

    func net() async throws -> NetInfo {
        let result = lock.withLock { () -> Result<NetInfo, Error> in _calls.append("net"); return _net }
        return try result.get()
    }

    func track(songKey: String) async throws -> OfflineTrack {
        let result: Result<OfflineTrack, Error>? = lock.withLock {
            _calls.append("track:\(songKey)")
            return next(&trackScripts[songKey, default: []])
        }
        guard let result else { throw MondropAPIError.http(404, "no script") }
        return try result.get()
    }

    func requestDownload(songKey: String, priority: DownloadPriority) async throws -> DownloadAck {
        lock.withLock { _calls.append("download:\(songKey):\(priority.rawValue)"); return _ack }
    }

    func setSource(songKey: String, youtubeUrl: String) async throws {
        lock.withLock { _calls.append("source:\(songKey):\(youtubeUrl)") }
    }
}

/// Deterministic time: `sleep` advances the clock instead of waiting.
final class FakeClock: @unchecked Sendable {
    private(set) var current = Date(timeIntervalSince1970: 1_000_000)
    private(set) var sleeps: [TimeInterval] = []

    /// Time passes without anyone sleeping (a backoff expires).
    func advance(_ seconds: TimeInterval) { current = current.addingTimeInterval(seconds) }

    var clock: PreparationClock {
        PreparationClock(
            sleep: { [self] seconds in
                try Task.checkCancellation()
                sleeps.append(seconds)
                current = current.addingTimeInterval(seconds)
            },
            now: { [self] in current }
        )
    }
}

// MARK: - URLProtocol stub (MondropAPI tests)

final class StubURLProtocol: URLProtocol {
    struct Captured { let request: URLRequest; let body: Data? }
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, Data))?
    nonisolated(unsafe) static var captured: [Captured] = []

    static func reset() {
        handler = nil
        captured = []
    }

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            stream.close()
            body = data
        }
        Self.captured.append(Captured(request: request, body: body))
        let (status, data) = Self.handler?(request) ?? (500, Data())
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}


// MARK: - Statistics round (tracker, queue, uploader)

/// Wall clock + monotonic clock moved by hand.
final class FakeTrackerClock: @unchecked Sendable {
    var wall = Date(timeIntervalSince1970: 1_794_000_000)   // 2026-11-07 ~ 20:00 UTC
    var mono: TimeInterval = 5_000

    var clock: TrackerClock {
        TrackerClock(now: { [self] in wall }, uptime: { [self] in mono })
    }

    func advance(_ seconds: TimeInterval) {
        wall = wall.addingTimeInterval(seconds)
        mono += seconds
    }
}

/// A journal in memory; `failToClear` simulates a crash between "event queued" and "journal cleared".
final class MemoryJournal: SessionJournal {
    private(set) var saved: PlayTracker.Session?
    private(set) var saveCount = 0
    private(set) var clearCount = 0
    var failToClear = false

    func save(_ session: PlayTracker.Session) {
        saved = session
        saveCount += 1
    }

    func load() -> PlayTracker.Session? { saved }

    func clear() {
        clearCount += 1
        if !failToClear { saved = nil }
    }
}

final class FakeEventTransport: EventTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _playCalls: [[String]] = []
    private var _deviceCalls: [[String]] = []
    private var _order: [String] = []
    /// What the server answers; nil = a healthy 200 accepting everything.
    var onPlays: (([PlayEvent]) throws -> BatchAck)?
    var onDevice: (([DeviceEvent]) throws -> BatchAck)?

    var playCalls: [[String]] { lock.withLock { _playCalls } }
    var deviceCalls: [[String]] { lock.withLock { _deviceCalls } }
    /// "device" / "plays" in the order the requests were made.
    var order: [String] { lock.withLock { _order } }

    func postPlays(_ events: [PlayEvent]) async throws -> BatchAck {
        lock.withLock {
            _playCalls.append(events.map(\.id))
            _order.append("plays")
        }
        if let onPlays { return try onPlays(events) }
        return BatchAck(accepted: events.count)
    }

    func postDeviceEvents(_ events: [DeviceEvent]) async throws -> BatchAck {
        lock.withLock {
            _deviceCalls.append(events.map(\.id))
            _order.append("device")
        }
        if let onDevice { return try onDevice(events) }
        return BatchAck(accepted: events.count)
    }
}

final class FakeBackgroundRunner: BackgroundTaskRunner, @unchecked Sendable {
    private let lock = NSLock()
    private var _names: [String] = []
    var names: [String] { lock.withLock { _names } }

    func run(name: String, _ work: @escaping @Sendable () async -> Void) async {
        lock.withLock { _names.append(name) }
        await work()
    }
}

extension TestSupport {
    static func playEvent(
        _ id: String = UUID().uuidString,
        songKey: String = "a::b",
        startedAt: Date = Date(timeIntervalSince1970: 1_794_000_000),
        listenedMs: Int = 60_000,
        durationMs: Int? = 200_000,
        completed: Bool = false,
        origin: PlayOrigin = .local,
        playlistId: String? = nil,
        tz: Int = 60
    ) -> PlayEvent {
        PlayEvent(
            id: id, songKey: songKey, startedAt: startedAt, tzOffsetMin: tz, listenedMs: listenedMs,
            durationMs: durationMs, completed: completed, origin: origin, playlistId: playlistId
        )
    }

    static func deviceEvent(_ id: String = UUID().uuidString, songs: [String] = ["a::b"]) -> DeviceEvent {
        DeviceEvent(
            id: id,
            at: Date(timeIntervalSince1970: 1_794_000_000),
            details: DeleteSongsDetails(
                reason: "manual",
                criteria: .init(count: nil),
                confirmations: songs.count > 1 ? 2 : 1,
                count: songs.count,
                bytes: 1000 * songs.count,
                songs: songs.map { .init(songKey: $0, title: $0, artist: "A", bytes: 1000, plays: 0, lastPlayedAt: nil) }
            )
        )
    }

    static func spaceRow(
        _ key: String, plays: Int = 0, last: Date? = nil, added: Date? = nil, bytes: Int = 5_000_000, title: String? = nil, artist: String = "Artist"
    ) -> SpaceRow {
        SpaceRow(songKey: key, title: title ?? key, artist: artist, bytes: bytes, plays: plays, lastPlayedAt: last, addedAt: added)
    }

    /// `n` days after a fixed origin, to write orderings readably.
    static func day(_ n: Int) -> Date { Date(timeIntervalSince1970: 1_790_000_000 + Double(n) * 86_400) }

    static func jsonObject(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }
}


// MARK: - 2.9.0: Libreria, status line, notifications

/// The server's library endpoint, answered from a catalog with the same rules (LibraryCatalog) unless a test scripts it.
final class FakeLibrary: LibraryTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _queries: [LibraryQuery] = []
    private var _catalog: [OfflineTrack]
    private var _failure: Error?
    private var _handler: ((LibraryQuery) throws -> LibraryPage)?
    private var _gate: (@Sendable (LibraryQuery) async -> Void)?

    init(catalog: [OfflineTrack] = []) { _catalog = catalog }

    var queries: [LibraryQuery] { lock.withLock { _queries } }
    func setCatalog(_ songs: [OfflineTrack]) { lock.withLock { _catalog = songs } }
    func fail(_ error: Error?) { lock.withLock { _failure = error } }
    func script(_ handler: ((LibraryQuery) throws -> LibraryPage)?) { lock.withLock { _handler = handler } }
    /// Runs (and may suspend) before a request is answered: lets a test make one answer arrive late.
    func gate(_ gate: (@Sendable (LibraryQuery) async -> Void)?) { lock.withLock { _gate = gate } }

    func library(_ query: LibraryQuery) async throws -> LibraryPage {
        let (failure, handler, catalog, gate) = lock.withLock { () -> (Error?, ((LibraryQuery) throws -> LibraryPage)?, [OfflineTrack], (@Sendable (LibraryQuery) async -> Void)?) in
            _queries.append(query)
            return (_failure, _handler, _catalog, _gate)
        }
        if let gate { await gate(query) }
        if let failure { throw failure }
        if let handler { return try handler(query) }
        return LibraryCatalog.page(of: catalog, filters: query.filters, limit: query.limit, offset: query.offset, withFacets: query.withFacets)
    }
}

/// Playlists (FakeAPI) + library (FakeLibrary) behind the one type the Libreria model takes.
final class FakeBackend: MondropAPIProtocol, LibraryTransport, @unchecked Sendable {
    let api: FakeAPI
    let lib: FakeLibrary

    init(api: FakeAPI = FakeAPI(), library: FakeLibrary = FakeLibrary()) {
        self.api = api
        self.lib = library
    }

    func listPlaylists() async throws -> [MondropPlaylist] { try await api.listPlaylists() }
    func offlineManifest(playlistId: String) async throws -> OfflineManifest { try await api.offlineManifest(playlistId: playlistId) }
    func prepare(playlistId: String, retryFailed: Bool) async throws -> OfflineManifest {
        try await api.prepare(playlistId: playlistId, retryFailed: retryFailed)
    }
    func net() async throws -> NetInfo { try await api.net() }
    func track(songKey: String) async throws -> OfflineTrack { try await api.track(songKey: songKey) }
    func requestDownload(songKey: String, priority: DownloadPriority) async throws -> DownloadAck {
        try await api.requestDownload(songKey: songKey, priority: priority)
    }
    func setSource(songKey: String, youtubeUrl: String) async throws { try await api.setSource(songKey: songKey, youtubeUrl: youtubeUrl) }
    func library(_ query: LibraryQuery) async throws -> LibraryPage { try await lib.library(query) }
}

/// UNUserNotificationCenter stand-in: records what would have been asked and posted. A unit test must never raise
/// the real permission prompt.
final class FakeNotificationCenter: SyncNotificationCenter, @unchecked Sendable {
    private let lock = NSLock()
    private var _permission: NotificationPermission
    private var _grantOnRequest: Bool
    private var _posted: [SyncNotificationContent] = []
    private var _requests = 0

    init(permission: NotificationPermission, grantOnRequest: Bool = true) {
        _permission = permission
        _grantOnRequest = grantOnRequest
    }

    var posted: [SyncNotificationContent] { lock.withLock { _posted } }
    var requestCount: Int { lock.withLock { _requests } }

    func permission() async -> NotificationPermission { lock.withLock { _permission } }

    func requestPermission() async -> Bool {
        lock.withLock {
            _requests += 1
            if _permission == .notDetermined { _permission = _grantOnRequest ? .allowed : .denied }
            return _permission == .allowed
        }
    }

    func post(_ content: SyncNotificationContent) async { lock.withLock { _posted.append(content) } }
}

extension TestSupport {
    /// A small library with the shapes the filters care about (same songs as the backend's libraryFacets tests).
    static func catalog() -> [OfflineTrack] {
        [
            track("mj::billie", title: "Billie Jean", artist: "Michael Jackson", album: "Thriller", genres: ["Pop"], year: 1982),
            track("mj::beat", title: "Beat It", artist: "Michael Jackson", album: "Thriller", genres: ["Pop", "Rock"], year: 1982),
            track("md::prayer", title: "Like a Prayer", artist: "Madonna", album: "Like a Prayer", genres: ["Pop"], year: 1989),
            track("dp::one", title: "One More Time", artist: "Daft Punk", album: "Discovery", genres: ["Elettronica"], year: 2001),
            track("dp::around", title: "Around the World", artist: "Daft Punk", album: "Homework", genres: ["Elettronica"], year: 1997),
            track("bm::ragazzo", title: "Il Mio Ragazzo", artist: "Bassi Maestro", album: "Fastidio", genres: ["Hip-Hop/Rap"], year: 2000),
            track("rh::creep", title: "Creep", artist: "Radiohead", album: "Pablo Honey", genres: ["Alternative"], year: 1992),
            track("ff::everlong", title: "Everlong", artist: "Foo Fighters", album: "The Colour and the Shape", genres: ["Alternative"], year: 1997),
            track("ua::mystery", title: "Mystery", artist: "Unknown Artist", album: "Mystery LP"),
            track("na::untitled", title: "Untitled", artist: "", genres: ["Pop"], year: 1983),
        ]
    }

    static func titles(_ tracks: [OfflineTrack]) -> [String] { tracks.map(\.title) }
}


/// A door a test opens by hand: whoever waits at it stays suspended until `open()`.
actor AsyncGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        let pending = waiters
        waiters = []
        for waiter in pending { waiter.resume() }
    }
}

// MARK: - 1.6.0: Share sheet + Posta

/// What was sent through the share call, and what the server «answered».
final class FakeShareSender: ShareSending, @unchecked Sendable {
    struct Call: Equatable {
        let url: String
        let comment: String?
        let tags: [String]?
        let options: ShareOptions
    }

    private let lock = NSLock()
    private var _calls: [Call] = []
    private var _results: [Result<ShareResponse, Error>]

    init(_ results: [Result<ShareResponse, Error>] = [.success(ShareResponse(success: true, status: "queued", kind: "generic"))]) {
        _results = results
    }

    var calls: [Call] { lock.withLock { _calls } }
    func script(_ results: [Result<ShareResponse, Error>]) { lock.withLock { _results = results } }

    func share(url: String, comment: String?, tags: [String]?, options: ShareOptions) async throws -> ShareResponse {
        let result: Result<ShareResponse, Error> = lock.withLock {
            _calls.append(Call(url: url, comment: comment, tags: tags, options: options))
            return _results.count > 1 ? _results.removeFirst() : (_results.first ?? .success(ShareResponse(success: true)))
        }
        return try result.get()
    }
}

/// The inbox on the server: answers are scripted, every call is recorded.
final class FakeInbox: InboxTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _snapshots: [InboxSnapshot]
    private var _calls: [String] = []
    private var _sinceValues: [String?] = []
    private var _failing: Set<String> = []
    private var _error: Error?

    init(_ snapshots: [InboxSnapshot] = [InboxSnapshot()]) { _snapshots = snapshots }

    /// Every call fails with this exact error (an HTTP 404 from a backend that predates the Posta, say).
    func failWith(_ error: Error?) { lock.withLock { _error = error } }

    var calls: [String] { lock.withLock { _calls } }
    var sinceValues: [String?] { lock.withLock { _sinceValues } }
    func script(_ snapshots: [InboxSnapshot]) { lock.withLock { _snapshots = snapshots } }
    /// `"markRead"`, `"delete"`, `"seen"`, `"readAll"`, `"inbox"` fail with a network error while listed.
    func fail(_ names: Set<String>) { lock.withLock { _failing = names } }

    private func record(_ name: String, _ detail: String = "") throws {
        let failing = lock.withLock { () -> Bool in
            _calls.append(detail.isEmpty ? name : "\(name):\(detail)")
            return _failing.contains(name)
        }
        if let error = lock.withLock({ _error }) { throw error }
        if failing { throw MondropAPIError.transport("offline") }
    }

    func inbox(since: String?, limit: Int?) async throws -> InboxSnapshot {
        lock.withLock { _sinceValues.append(since) }
        try record("inbox")
        return lock.withLock { _snapshots.count > 1 ? _snapshots.removeFirst() : (_snapshots.first ?? InboxSnapshot()) }
    }

    func markRead(id: String) async throws { try record("markRead", id) }
    func markAllRead() async throws { try record("readAll") }
    func deleteNotification(id: String) async throws { try record("delete", id) }
    func markSeen(entryId: String) async throws { try record("seen", entryId) }
}

final class FakePushTransport: PushTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _registered: [(token: String, environment: PushEnvironment)] = []
    private var _unregistered: [String] = []
    private var _failing = false

    var registered: [(token: String, environment: PushEnvironment)] { lock.withLock { _registered } }
    var unregistered: [String] { lock.withLock { _unregistered } }
    func fail(_ value: Bool) { lock.withLock { _failing = value } }

    func registerPushDevice(token: String, environment: PushEnvironment) async throws {
        if lock.withLock({ _failing }) { throw MondropAPIError.transport("offline") }
        lock.withLock { _registered.append((token, environment)) }
    }

    func unregisterPushDevice(token: String) async throws {
        if lock.withLock({ _failing }) { throw MondropAPIError.transport("offline") }
        lock.withLock { _unregistered.append(token) }
    }
}

@MainActor
final class FakePushSystem: PushSystem {
    private(set) var registerCalls = 0
    private(set) var unregisterCalls = 0
    func registerForRemoteNotifications() { registerCalls += 1 }
    func unregisterForRemoteNotifications() { unregisterCalls += 1 }
}

final class FakeBadge: BadgeSetting, @unchecked Sendable {
    private let lock = NSLock()
    private var _values: [Int] = []
    var values: [Int] { lock.withLock { _values } }
    var last: Int? { lock.withLock { _values.last } }
    func setBadge(_ count: Int) async { lock.withLock { _values.append(count) } }
}

extension TestSupport {
    static func tempFile(_ name: String) throws -> URL {
        try tempDir("file").appendingPathComponent(name)
    }

    /// A notification as the server sends it, with sensible defaults.
    static func notification(
        _ id: String, level: InboxLevel = .info, title: String? = nil, body: String = "2 canzoni, 1 film",
        created: Date? = nil, read: Date? = nil, expires: Date? = nil, sourceUrl: String? = nil, entryId: String? = "e1",
        kind: String = "share_result", reason: String? = nil, options: InboxRetryOptions? = nil, retrying: Bool = false
    ) -> InboxNotification {
        InboxNotification(
            id: id, kind: kind, level: level, title: title ?? (level == .error ? "Analisi non riuscita" : "Salvato su SoundReel"),
            body: body, entryId: entryId, url: entryId.map { "https://soundreel.test/?entry=\($0)" },
            createdAt: created ?? Date(timeIntervalSince1970: 1_794_000_000), readAt: read, expiresAt: expires,
            data: InboxData(sourceUrl: sourceUrl, reason: reason, options: options, retrying: retrying)
        )
    }

    /// The notice that tells somebody an entry was shared with him (it is linked to its share by `entryId`).
    static func sharedWithYou(_ id: String, entry: String, read: Date? = nil, expires: Date? = nil) -> InboxNotification {
        notification(id, title: "Sara ha condiviso con te", body: "Say it Ain't So\n1 canzone", read: read, expires: expires, entryId: entry, kind: "share_received")
    }

    static func receivedShare(_ entryId: String, from: String = "sara", seen: Bool = false) -> ReceivedShare {
        ReceivedShare(
            entryId: entryId, from: from, sharedAt: Date(timeIntervalSince1970: 1_794_000_000), title: "Say it Ain't So",
            kind: "spotify", counts: ShareCounts(songs: 1), seen: seen, url: "https://soundreel.test/?entry=\(entryId)"
        )
    }

    /// 2026-11-08 ~ 07:20 UTC
    static let inboxNow = Date(timeIntervalSince1970: 1_794_000_000 + 600)
}
