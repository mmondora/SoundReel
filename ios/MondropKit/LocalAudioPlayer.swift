// LocalAudioPlayer.swift — lightweight AVPlayer + lock-screen / background.
//
// Queue items are remote-or-local. First-play rule (see FirstPlay.swift): a track on the device plays from the
// file; otherwise it streams right away and is downloaded in parallel, so the next play is local. A track the
// server has not prepared yet is requested with priority and the player shows "Preparo il brano…".

import Foundation
import AVFoundation
import Combine
import MediaPlayer
#if canImport(UIKit)
import UIKit
#endif

/// One entry of the play queue: a local file, a server track, or both.
public struct QueueItem: Identifiable, Equatable, Sendable {
    public var id: String { songKey }
    public let songKey: String
    public let title: String
    public let artist: String
    /// The provider's cover address (older servers). NOT fetched by the app any more: it asks SoundReel for `coverPath` (rule P).
    public let coverURL: String?
    /// Relative path to ask SoundReel for the cover (ADR-0019); nil = the canonical path of the song.
    public let coverPath: String?
    public let lyrics: String?
    /// Server view of the track (urls, state). nil for items that only exist on the device.
    public let track: OfflineTrack?

    public init(songKey: String, title: String, artist: String, coverURL: String? = nil, coverPath: String? = nil, lyrics: String? = nil, track: OfflineTrack? = nil) {
        self.songKey = songKey
        self.title = title
        self.artist = artist
        self.coverURL = coverURL
        self.coverPath = coverPath
        self.lyrics = lyrics
        self.track = track
    }

    public init(local item: OfflineStore.Item) {
        self.init(songKey: item.songKey, title: item.title, artist: item.artist, coverURL: item.coverURL, lyrics: item.lyrics, track: nil)
    }

    public init(track: OfflineTrack) {
        self.init(songKey: track.songKey, title: track.title, artist: track.artist, coverURL: track.coverUrl, coverPath: track.coverPath, lyrics: track.lyrics, track: track)
    }
}

public enum PlaybackStatus: Equatable, Sendable {
    case idle
    /// Waiting for the server to prepare the file.
    case preparing
    /// Streaming; the download runs in parallel (see SyncEngine.progress).
    case streaming
    case local
    case failed(String)
}

@MainActor
public final class LocalAudioPlayer: ObservableObject {
    /// The app listens to what the shared player does: the sync of the playlist that plays (`PlayingPlaylistSync`). Set once at launch, before the player
    /// exists, so that nothing creates the player (and its audio session) just to listen to it.
    public static var sharedPlaybackObserver: (@MainActor (PlaybackContext) -> Void)?

    public static let shared: LocalAudioPlayer = {
        let player = LocalAudioPlayer()
        player.observePlayback { context in LocalAudioPlayer.sharedPlaybackObserver?(context) }
        player.observeUpcoming { LocalAudioPlayer.sharedUpcomingObserver?($0) }
        return player
    }()

    @Published public private(set) var title: String = ""
    @Published public private(set) var artist: String = ""
    /// The cover of the song playing (the image itself: SoundReel found it, the phone kept it), or nil when there is none and the
    /// player draws its own.
    @Published public private(set) var coverData: Data? = nil
    @Published public private(set) var lyrics: String = ""
    /// Where the words on screen come from (the sheet says it), and whether SoundReel is still being asked for them (ADR-0021).
    public enum LyricsOrigin: Equatable, Sendable {
        case none, typed, transcript, internet, instrumental
    }
    @Published public private(set) var lyricsOrigin: LyricsOrigin = .none
    @Published public private(set) var lyricsSearching: Bool = false
    @Published public private(set) var playing: Bool = false { didSet { reportPlayback() } }
    /// Something was put in play in this run and has not ended: a song playing, or paused by the user, or one the user queued from Cerca. False for a queue the phone
    /// brought back paused at launch, after the last song has ended and with nothing queued. The mini player is there only while this is true
    /// (`MiniPlayerPresence`; Michele, 11 November: «Il mini player non deve essere visibile se non ci sono cose in play.»).
    @Published public private(set) var inPlay: Bool = false { didSet { reportUpcoming() } }
    @Published public private(set) var index: Int = 0 { didSet { refreshLikeCommand(); reportUpcoming() } }
    @Published public private(set) var queue: [QueueItem] = [] { didSet { refreshLikeCommand(); reportUpcoming() } }
    @Published public private(set) var currentTime: Double = 0
    @Published public private(set) var duration: Double = 0
    @Published public private(set) var playbackStatus: PlaybackStatus = .idle
    /// What the queue is, in the user's words («Album · Thriller», «Playlist · Road trip»): the «In coda» title.
    @Published public private(set) var queueLabel: String?
    /// The loop: none, the whole queue, this song (spec 2026-11-10-mondrop-like-and-repeat-design.md L4). Kept between launches.
    @Published public private(set) var repeatMode: RepeatMode = .off

    private let store: OfflineStore
    private let api: MondropAPIProtocol
    private let recorder: PlayRecorder
    private var player: AVPlayer?
    private var endObserver: NSObjectProtocol?
    private var timeObserver: Any?
    private var statusObservation: NSKeyValueObservation?
    private var timeControlObservation: NSKeyValueObservation?
    /// Bumped for every AVPlayer created: lets a late KVO callback of a torn-down player be ignored.
    private var playerGeneration = 0
    /// The playlist the current queue was started from (listening stats, and the sync of the playlist that plays), nil for every other queue.
    @Published public private(set) var queuePlaylistId: String? { didSet { reportPlayback() } }
    private var resolveTask: Task<Void, Never>?
    private var pendingSources: [PlaybackSource] = []
    private var artworkImage: MPMediaItemArtwork? = nil
    /// Where the queue is kept between launches (`QueueSnapshot`).
    private let snapshots: QueueSnapshotStore
    private let lyricsLoader: LyricsLoader
    private var lyricsTask: Task<Void, Never>?
    /// For the tests: the question being asked for the song that plays (nil when none), to wait for its answer instead of guessing how long it takes.
    var lyricsWork: Task<Void, Never>? { lyricsTask }
    /// Where the user was inside the song a restored queue points at: applied once, when that song starts, never before.
    private var pendingResume: (songKey: String, seconds: Double)?
    private var lastPositionSave = Date.distantPast
    /// True while the saved queue is being put back: it must not be written over itself.
    private var restoring = false
    private let repeatStore: RepeatModeStore
    private let likes: LikesStore
    private let commandLog: RemoteCommandLog
    private var likesObservation: AnyCancellable?

    #if DEBUG
    /// For the screenshots on a simulator (`-MondropDemoPlaying`): the queue the demo brought back is shown as if the user had started it.
    func demoMarkInPlay() { inPlay = true }
    #endif

    // MARK: - What the downloads follow (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U16)

    /// What is about to play, for the downloads: see `UpcomingOrder`. Set once at launch, like `sharedPlaybackObserver`.
    public static var sharedUpcomingObserver: (@MainActor ([String]) -> Void)?

    /// The songs of the queue in the order they are about to play (`UpcomingOrder`): from the song in play to the end, and round again. Empty while nothing is in play — a
    /// queue the phone brought back paused at launch, the end of the last song — because nobody asked to hear it: nothing is brought down in its order.
    public var upcomingKeys: [String] {
        inPlay ? UpcomingOrder.keys(queue: queue.map(\.songKey), index: index) : []
    }

    private var upcomingObserver: (@MainActor ([String]) -> Void)?
    private var lastReportedUpcoming: [String]?

    /// The observer hears the present at once and then every change, one time each (like `observePlayback`). Inside `setQueue` a report may name the new queue with the
    /// old position for an instant: the next one, in the same turn, is the right one, and nothing downloads in between.
    public func observeUpcoming(_ observer: @escaping @MainActor ([String]) -> Void) {
        upcomingObserver = observer
        lastReportedUpcoming = nil
        reportUpcoming()
    }

    private func reportUpcoming() {
        guard let observer = upcomingObserver else { return }
        let keys = upcomingKeys
        guard keys != lastReportedUpcoming else { return }
        lastReportedUpcoming = keys
        observer(keys)
    }

    // MARK: - What the sync of the playing playlist listens to

    /// What the player is doing, for the sync: a song is really playing (a queue that is only loaded, like the one a relaunch brings back, is not) and the
    /// playlist the queue was started from.
    public var playbackContext: PlaybackContext { PlaybackContext(isPlaying: playing, playlistId: queuePlaylistId) }

    private var playbackObserver: (@MainActor (PlaybackContext) -> Void)?
    private var lastReportedContext: PlaybackContext?

    /// The observer hears the present at once and then every change, one time each. A player nobody observes tells nobody anything.
    public func observePlayback(_ observer: @escaping @MainActor (PlaybackContext) -> Void) {
        playbackObserver = observer
        lastReportedContext = nil
        reportPlayback()
    }

    private func reportPlayback() {
        guard let observer = playbackObserver else { return }
        let context = playbackContext
        guard context != lastReportedContext else { return }
        lastReportedContext = context
        observer(context)
    }

    /// Internal, not private: the tests build their own player on a folder of their own.
    init(
        store: OfflineStore = .shared, api: MondropAPIProtocol = MondropAPI(), recorder: PlayRecorder? = nil,
        snapshots: QueueSnapshotStore = QueueSnapshotStore(), lyricsLoader: LyricsLoader = .shared,
        repeatStore: RepeatModeStore? = nil, likes: LikesStore? = nil, commandLog: RemoteCommandLog? = nil
    ) {
        self.store = store
        self.api = api
        self.recorder = recorder ?? PlayRecorder.shared
        self.snapshots = snapshots
        self.lyricsLoader = lyricsLoader
        self.repeatStore = repeatStore ?? DefaultsRepeatModeStore(defaults: Settings.shared.storage)
        self.likes = likes ?? LikesStore.shared
        self.commandLog = commandLog ?? RemoteCommandLog.shared
        repeatMode = self.repeatStore.mode
        configureSession()
        configureRemoteCommands()
        // The heart the car shows follows the likes (a like given on the screen, or one that arrived from another phone).
        likesObservation = self.likes.$revision.sink { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshLikeCommand() }
        }
        #if os(iOS)
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] note in
            Task { @MainActor in self?.handleInterruption(note) }
        }
        #endif
        restoreSavedQueue()
    }

    private func configureSession() {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            // Best-effort; playback may still work.
        }
        #endif
    }

    /// Everything the system can press, from Bluetooth, the car, the lock screen and Control Center. The handlers are thin: they reach the
    /// main actor (the system may call from any thread) and ask `perform`, which writes the command down and does it.
    private func configureRemoteCommands() {
        let cc = MPRemoteCommandCenter.shared()
        cc.playCommand.isEnabled = true
        cc.pauseCommand.isEnabled = true
        cc.togglePlayPauseCommand.isEnabled = true
        cc.nextTrackCommand.isEnabled = true
        cc.previousTrackCommand.isEnabled = true
        cc.changeRepeatModeCommand.isEnabled = true
        cc.changeRepeatModeCommand.currentRepeatType = repeatMode.systemType
        cc.likeCommand.isEnabled = true
        cc.likeCommand.localizedTitle = "Mi piace"
        cc.likeCommand.localizedShortTitle = "Mi piace"
        cc.playCommand.addTarget { [weak self] _ in self.map { player in Self.onMain { player.perform(.play) } } ?? .commandFailed }
        cc.pauseCommand.addTarget { [weak self] _ in self.map { player in Self.onMain { player.perform(.pause) } } ?? .commandFailed }
        cc.togglePlayPauseCommand.addTarget { [weak self] _ in self.map { player in Self.onMain { player.perform(.togglePlayPause) } } ?? .commandFailed }
        cc.nextTrackCommand.addTarget { [weak self] _ in self.map { player in Self.onMain { player.perform(.next) } } ?? .commandFailed }
        cc.previousTrackCommand.addTarget { [weak self] _ in self.map { player in Self.onMain { player.perform(.previous) } } ?? .commandFailed }
        cc.changeRepeatModeCommand.addTarget { [weak self] event in
            guard let self, let change = event as? MPChangeRepeatModeCommandEvent else { return .commandFailed }
            let mode = RepeatMode(change.repeatType)
            return Self.onMain { self.perform(.repeatMode(mode)) }
        }
        cc.likeCommand.addTarget { [weak self] event in
            guard let self, let feedback = event as? MPFeedbackCommandEvent else { return .commandFailed }
            let negative = feedback.isNegative
            return Self.onMain { self.perform(.like(negative: negative)) }
        }
    }

    /// The system calls its handlers from any thread; the player lives on the main actor and the answer has to be given before returning.
    private nonisolated static func onMain<T: Sendable>(_ work: @MainActor @Sendable () -> T) -> T {
        if Thread.isMainThread { return MainActor.assumeIsolated { work() } }
        return DispatchQueue.main.sync { MainActor.assumeIsolated { work() } }
    }

    /// The ONE place where a command from outside is written down (the list in the Settings) and done. Returns what the system is told.
    @discardableResult
    func perform(_ command: RemoteCommand) -> MPRemoteCommandHandlerStatus {
        recordCommand(named: command.logName)
        switch command {
        case .play: playOnly()
        case .pause: pauseOnly()
        case .togglePlayPause: toggle()
        case .next: next()
        case .previous: previous()
        case .repeatMode(let mode): setRepeatMode(mode)
        case .like(let negative):
            guard let key = currentSongKey else { return .noActionableNowPlayingItem }
            // A press on the heart of a liked song takes the like back, whether the system says «negative» or not.
            likes.setLiked(negative ? false : !likes.isLiked(key), songKey: key)
        }
        return .success
    }

    /// A voice command (Siri, spec 2026-11-10-mondrop-like-and-repeat-design.md L9): the same player and the same likes as the buttons and the
    /// car, written down in the same list («Siri: Mi piace»). Unlike the heart of the car, the voice is never a switch: «mi piace» on a liked
    /// song changes nothing. Returns what Siri says.
    @discardableResult
    func perform(voice command: VoiceCommand) -> VoiceOutcome {
        recordCommand(named: command.logName)
        switch command {
        case .like, .unlike:
            let wanted = command == .like
            let current = queue.indices.contains(index) ? CurrentSong(songKey: queue[index].songKey, title: queue[index].title) : nil
            let decision = VoiceDecision.like(wanted: wanted, current: current, isLiked: current.map { likes.isLiked($0.songKey) } ?? false)
            if decision.change, let current { likes.setLiked(wanted, songKey: current.songKey) }
            return decision.outcome
        case .repeatMode(let mode):
            setRepeatMode(mode)
            return .repeatSet(mode)
        }
    }

    /// The ONE place that writes a command from outside (the buttons of the car, the lock screen, Siri) in the list of the Settings.
    func recordCommand(named name: String) {
        commandLog.record(name)
    }

    // MARK: - The loop and the like, as the system sees them

    public func setRepeatMode(_ mode: RepeatMode) {
        repeatMode = mode
        repeatStore.mode = mode
        MPRemoteCommandCenter.shared().changeRepeatModeCommand.currentRepeatType = mode.systemType
    }

    /// The button of the Player: none → the whole queue → this song → none.
    public func cycleRepeatMode() { setRepeatMode(repeatMode.next) }

    /// The heart the system shows is the heart of the song that plays.
    private func refreshLikeCommand() {
        MPRemoteCommandCenter.shared().likeCommand.isActive = currentSongKey.map(likes.isLiked) ?? false
    }

    // MARK: - Queue

    /// What a tap on a playlist or on a song does once the queue is built (`LibraryQueueBuilder`, `SearchPlayback`): the queue loads and plays.
    /// The one way every screen, and Siri, starts a queue.
    public func start(_ queue: PlayQueue) {
        setQueue(queue.items, startAt: queue.startIndex, playlistId: queue.playlistId, label: queue.label)
    }

    /// `playlistId`: the playlist the user started this queue from (recorded with every listen), nil otherwise.
    /// `label`: what the user chose («Album · Thriller»), shown as «In coda».
    /// `autoplay: false` loads the queue and SHOWS the song at `startAt` (title, artist, cover, words) without starting it.
    public func setQueue(_ items: [QueueItem], startAt: Int = 0, playlistId: String? = nil, label: String? = nil, autoplay: Bool = true) {
        queue = items
        queuePlaylistId = playlistId
        queueLabel = label
        guard !items.isEmpty else {
            inPlay = false
            persistQueue()                                   // an emptied queue is forgotten too
            return
        }
        let at = min(max(0, startAt), items.count - 1)
        if autoplay { play(at: at) } else { show(at: at) }
    }

    // MARK: - The queue survives a relaunch

    /// The queue the phone kept (see `QueueSnapshot`), back in the player PAUSED — nothing starts by itself — on the song it was on and,
    /// for «Riprendi», where the user was inside it.
    private func restoreSavedQueue() {
        guard let saved = snapshots.load() else { return }
        restoring = true
        setQueue(saved.queueItems, startAt: saved.index, playlistId: saved.playlistId, label: saved.label, autoplay: false)
        restoring = false
        guard queue.indices.contains(index), saved.positionSeconds > 0 else { return }
        // A song that had been heard to its end starts over: there is nothing left to resume.
        let atTheEnd = saved.durationSeconds > 0 && saved.positionSeconds >= saved.durationSeconds - 3
        guard !atTheEnd else { return }
        currentTime = saved.positionSeconds
        duration = saved.durationSeconds
        pendingResume = (queue[index].songKey, saved.positionSeconds)
    }

    private func persistQueue() {
        guard !restoring else { return }
        snapshots.save(QueueSnapshot.make(queue: queue, index: index, label: queueLabel, playlistId: queuePlaylistId))
    }

    /// Where the user is inside the song, kept every few seconds while it plays.
    private func persistPositionIfDue() {
        guard queue.indices.contains(index), Date().timeIntervalSince(lastPositionSave) >= 5 else { return }
        savePositionNow()
    }

    /// Keeps where the user is inside the song, now: the app is going to the background and may not come back.
    public func savePositionNow() {
        guard queue.indices.contains(index), player != nil || currentTime > 0 else { return }
        lastPositionSave = Date()
        snapshots.save(position: queue[index].songKey, seconds: currentTime, duration: duration)
    }

    /// Local-only convenience: everything downloaded on the phone, as one explicit choice («Sul telefono»).
    public func setQueue(local items: [OfflineStore.Item], startAt: Int = 0) {
        setQueue(items.map { QueueItem(local: $0) }, startAt: startAt, playlistId: nil, label: LibraryChoice.onPhone.label)
    }

    /// «Aggiungi in coda» (long press on a song of «Cerca»): after the songs already queued (see `QueueAppend`: a song already
    /// in the queue stays where it is, one that cannot play is not queued). With nothing queued it LOADS the queue and shows its
    /// first song, waiting for «Riproduci»: the play is never automatic (Michele, 8 November: «il play non deve essere automatico»).
    @discardableResult
    public func append(_ tracks: [OfflineTrack], isLocal: (String) -> Bool) -> QueueAppend.Outcome {
        let merged = QueueAppend.merge(existing: queue, adding: tracks, isLocal: isLocal)
        guard merged.added > 0 else { return merged.outcome }
        if queue.isEmpty {
            setQueue(merged.queue, startAt: 0, playlistId: nil, label: "Aggiunti dalla ricerca", autoplay: false)
            inPlay = true                                    // the user put it there; the bar is how they start it
            return .addedToEmptyQueue(merged.added)
        }
        queue = merged.queue
        persistQueue()
        return merged.outcome
    }

    /// Shows the song at `i` and leaves it there, not playing: the queue is loaded, «Riproduci» starts it (`playOnly` plays the
    /// current index when there is no item yet).
    private func show(at i: Int) {
        guard queue.indices.contains(i) else { return }
        resolveTask?.cancel()
        resolveTask = nil
        recorder.tracker.finish(completed: false)       // leaving the previous song: its session ends here
        teardownCurrentItem()
        playing = false
        index = i
        persistQueue()
        let entry = queue[i]
        title = entry.title
        artist = entry.artist
        coverData = CoverLoader.shared.cached(songKey: entry.songKey)
        loadLyrics(for: entry)
        artworkImage = nil
        currentTime = 0
        duration = 0
        playbackStatus = .idle
        loadArtwork(for: entry)
    }

    public func play(at i: Int) {
        guard queue.indices.contains(i) else { return }
        inPlay = true
        resolveTask?.cancel()
        resolveTask = nil
        recorder.tracker.finish(completed: false)       // leaving the previous song: its session ends here
        teardownCurrentItem()
        playing = false
        configureSession()
        index = i
        persistQueue()
        let entry = queue[i]
        title = entry.title
        artist = entry.artist
        coverData = CoverLoader.shared.cached(songKey: entry.songKey)       // what the phone already has, at once, offline too
        loadLyrics(for: entry)
        artworkImage = nil
        currentTime = 0
        duration = 0
        loadArtwork(for: entry)

        // 1) already on the device → the file, no network at all.
        if let file = store.fileURL(songKey: entry.songKey) {
            start(sources: [PlaybackSource.local(file)], status: .local)
            return
        }

        // 2) first play: SoundReel has it (or is asked to prepare it); the network the phone is on changes nothing.
        playbackStatus = .preparing
        resolveTask = Task { [weak self] in
            await self?.resolveRemote(entry, at: i)
        }
    }

    private func resolveRemote(_ entry: QueueItem, at i: Int) async {
        guard !Task.isCancelled, index == i else { return }
        let config = MondropAPIConfig.current()
        // The user deleted this song from the phone to save space: stream it, never download it again behind his back.
        let skipListed = store.isSkipped(entry.songKey)
        // A song brought back from the saved queue carries no view of itself from the server (addresses, state): ask for it now.
        let known = await Self.serverView(of: entry, api: api)
        guard !Task.isCancelled, index == i else { return }
        switch FirstPlay.decide(songKey: entry.songKey, track: known, local: store.fileURL(songKey: entry.songKey), config: config, skipListed: skipListed) {
        case .local(let url):
            start(sources: [PlaybackSource.local(url)], status: .local)
        case .stream(let sources, let download):
            SyncEngine.shared.enqueue([download], front: true, origin: .play)   // in parallel, for next time
            start(sources: sources, status: .streaming)
        case .streamWithoutDownload(let sources):
            start(sources: sources, status: .streaming)
        case .prepare(let track):
            playbackStatus = .preparing
            // The line at the top says «Preparo 1 brano sul server» while the user waits for this one.
            SyncActivity.shared.markPreparing(track.songKey)
            defer { SyncActivity.shared.clear(track.songKey) }
            do {
                let ready = try await PlaybackPreparation.awaitReady(track, api: api)
                guard !Task.isCancelled, index == i else { return }
                store.recordServerNumbers(songKey: ready.songKey, plays: ready.plays, lastPlayedAt: ready.lastPlayedDate)
                switch FirstPlay.decide(songKey: entry.songKey, track: ready, local: store.fileURL(songKey: entry.songKey), config: config, skipListed: skipListed) {
                case .local(let url):
                    start(sources: [PlaybackSource.local(url)], status: .local)
                case .stream(let sources, let download):
                    SyncEngine.shared.enqueue([download], front: true, origin: .play)
                    start(sources: sources, status: .streaming)
                case .streamWithoutDownload(let sources):
                    start(sources: sources, status: .streaming)
                case .prepare, .unavailable:
                    playbackStatus = .failed("brano non disponibile")
                }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, index == i else { return }
                playbackStatus = .failed((error as? PlaybackPreparationError)?.description
                    ?? (error as? MondropAPIError)?.description ?? error.localizedDescription)
            }
        case .unavailable(let reason):
            playbackStatus = .failed(reason)
        }
    }

    /// The server's view of a queue item: the one it came with or — for an item restored from the saved queue — the one SoundReel gives now
    /// (nil when it cannot be reached: the first-play rule then says why the song cannot start).
    static func serverView(of entry: QueueItem, api: MondropAPIProtocol) async -> OfflineTrack? {
        if let track = entry.track { return track }
        return try? await api.track(songKey: entry.songKey)
    }

    // MARK: - The words

    /// What the phone has for the song, no network: what the user typed, else the words the sync brought (the transcript of the post).
    static func localLyrics(for entry: QueueItem, store: OfflineStore) -> (text: String, origin: LyricsOrigin) {
        if store.hasTypedLyrics(for: entry.songKey), let typed = store.lyrics(for: entry.songKey), !typed.isEmpty { return (typed, .typed) }
        if let known = store.lyrics(for: entry.songKey) ?? entry.lyrics, !known.isEmpty { return (known, .transcript) }
        return ("", .none)
    }

    /// The words of the song that starts: what the user typed (never asked, never replaced), what the phone kept of an earlier find and —
    /// otherwise — what SoundReel says (ADR-0021). The transcript the sync brought shows at once, but SoundReel is asked anyway: it
    /// decides what is the words of a song (a transcript that is only a fragment gives way to the text it finds, spec L12) and the
    /// phone keeps its own copy when SoundReel cannot be reached or has nothing. A song that changed meanwhile never takes the words
    /// of another.
    private func loadLyrics(for entry: QueueItem) {
        lyricsTask?.cancel()
        lyricsTask = nil
        lyricsSearching = false
        let local = Self.localLyrics(for: entry, store: store)
        lyrics = local.text
        lyricsOrigin = local.origin
        guard local.origin != .typed else { return }
        if let kept = lyricsLoader.cached(songKey: entry.songKey) {
            applyFound(kept)
            return
        }
        lyricsSearching = local.origin == .none          // «Cerco il testo…» only when there is nothing to read meanwhile
        let key = entry.songKey
        lyricsTask = Task { [weak self] in
            let found = await self?.lyricsLoader.fetch(songKey: key)
            guard let self, !Task.isCancelled, self.currentSongKey == key else { return }
            self.lyricsSearching = false
            // The user may have typed words while SoundReel was being asked: they stay.
            if let found, self.lyricsOrigin != .typed { self.applyFound(found) }
        }
    }

    private func applyFound(_ found: SongLyrics) {
        lyrics = found.text
        lyricsOrigin = found.instrumental ? .instrumental : (found.source == .internet ? .internet : .transcript)
    }

    // MARK: - AVPlayer plumbing

    /// Tries the sources in order (today there is one: the file, or SoundReel); a source that fails to load falls back to the next.
    private func start(sources: [PlaybackSource], status: PlaybackStatus) {
        pendingSources = sources
        playbackStatus = status
        if queue.indices.contains(index) {
            let entry = queue[index]
            // One listening session per song start (a fallback to the next source stays the same session).
            recorder.tracker.begin(
                songKey: entry.songKey,
                durationMs: entry.track?.durationS.map { $0 * 1000 },
                origin: status == .local ? .local : .stream,
                playlistId: queuePlaylistId
            )
        }
        attemptNextSource()
    }

    private func attemptNextSource() {
        guard !pendingSources.isEmpty else {
            playing = false
            if case .failed = playbackStatus {} else { playbackStatus = .failed("impossibile riprodurre il brano") }
            publishNowPlaying()
            return
        }
        let source = pendingSources.removeFirst()
        let item = Self.makeItem(for: source)
        attach(item)
    }

    nonisolated static func makeItem(for source: PlaybackSource) -> AVPlayerItem {
        guard !source.headers.isEmpty else { return AVPlayerItem(url: source.url) }
        // The proxy needs the API key; AVPlayer only sends it through this (long-standing) asset option.
        let asset = AVURLAsset(url: source.url, options: ["AVURLAssetHTTPHeaderFieldsKey": source.headers])
        return AVPlayerItem(asset: asset)
    }

    private func attach(_ item: AVPlayerItem) {
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.songEnded() }
        }
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] observed, _ in
            guard observed.status == .failed else { return }
            Task { @MainActor in self?.itemFailed(observed) }
        }
        let newPlayer = AVPlayer(playerItem: item)
        player = newPlayer
        // «Riprendi»: the first play of a restored queue starts where the user was (once, and only for that song).
        if let resume = pendingResume, queue.indices.contains(index), queue[index].songKey == resume.songKey {
            newPlayer.seek(to: CMTime(seconds: resume.seconds, preferredTimescale: 600))
        }
        pendingResume = nil
        // Only `.playing` counts as listening: pause, buffering stalls and interruptions are `.paused` /
        // `.waitingToPlayAtSpecifiedRate`. Runs in background and on the lock screen too (audio background mode).
        playerGeneration += 1
        let generation = playerGeneration
        timeControlObservation = newPlayer.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self] observed, _ in
            let reallyPlaying = observed.timeControlStatus == .playing
            Task { @MainActor in
                guard let self, self.playerGeneration == generation else { return }   // the player was replaced meanwhile
                self.recorder.tracker.setPlaying(reallyPlaying)
            }
        }
        timeObserver = newPlayer.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
            queue: .main
        ) { [weak self] t in
            Task { @MainActor in
                guard let self else { return }
                self.currentTime = t.seconds.isFinite ? t.seconds : 0
                if let d = self.player?.currentItem?.duration.seconds, d.isFinite {
                    self.duration = d
                    self.recorder.tracker.updateDuration(ms: Int(d * 1000))
                }
                self.recorder.tracker.tick()           // crash-safety checkpoint, throttled inside
                self.persistPositionIfDue()
                self.publishNowPlayingElapsed()
            }
        }
        newPlayer.play()
        playing = true
        publishNowPlaying()
    }

    private func itemFailed(_ item: AVPlayerItem) {
        guard player?.currentItem === item else { return }
        teardownCurrentItem()
        if pendingSources.isEmpty {
            playbackStatus = .failed(item.error?.localizedDescription ?? "impossibile riprodurre il brano")
            playing = false
            publishNowPlaying()
        } else {
            attemptNextSource()   // media server refused → the proxy
        }
    }

    private func teardownCurrentItem() {
        statusObservation?.invalidate()
        statusObservation = nil
        timeControlObservation?.invalidate()
        timeControlObservation = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        if let timeObserver, let player { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        player?.pause()
        player = nil
    }

    // MARK: - Transport

    public func toggle() {
        if playing { pauseOnly() } else { playOnly() }
    }

    public func playOnly() {
        configureSession()
        guard let player else {
            if !queue.isEmpty { play(at: index) }
            return
        }
        player.play()
        playing = true
        publishNowPlaying()
    }

    public func pauseOnly() {
        player?.pause()
        playing = false
        publishNowPlaying()
    }

    public func next() {
        guard !queue.isEmpty else { return }
        switch RepeatPolicy.whenNext(mode: repeatMode, index: index, count: queue.count) {
        case .play(let i):
            play(at: i)
        case .replay:
            replayCurrent(completed: false)
        case .stop:
            playing = false
            inPlay = false
            publishNowPlaying()
        }
    }

    /// The song reached its end by itself. The loop decides what comes next (`RepeatPolicy`); the pass that ended is a listen that arrived at
    /// the end, a repeat included.
    func songEnded() {
        switch RepeatPolicy.whenSongEnds(mode: repeatMode, index: index, count: queue.count) {
        case .play(let i):
            recorder.tracker.finish(completed: true)
            play(at: i)
        case .replay:
            replayCurrent(completed: true)
        case .stop:
            recorder.tracker.finish(completed: true)
            playing = false
            inPlay = false
            publishNowPlaying()
        }
    }

    /// The same song again from the top: the pass that ended is closed and the next one is a listen of its own.
    private func replayCurrent(completed: Bool) {
        guard let player else {
            // Nothing is loaded (a queue that was restored and never played): start the song the usual way.
            recorder.tracker.finish(completed: completed)
            play(at: index)
            return
        }
        closeListenAndStartAnother(completed: completed)
        player.seek(to: .zero) { [weak player] _ in player?.play() }
        currentTime = 0
        playing = true
        publishNowPlaying()
    }

    /// The accounting of a loop: the pass that ended counts as it is (`completed` when it arrived at the end, not when the user cut it with
    /// «avanti»), and a new listen, with a new id, begins for the same song.
    func closeListenAndStartAnother(completed: Bool) {
        if completed { recorder.tracker.finish(completed: true) }
        recorder.tracker.restart()
    }

    public func previous() {
        guard !queue.isEmpty else { return }
        if let player, player.currentTime().seconds > 3 {
            recorder.tracker.restart()                 // the same song from the top: a new listen
            player.seek(to: .zero)
            currentTime = 0
            publishNowPlayingElapsed()
            return
        }
        play(at: max(0, index - 1))
    }

    public func seek(to seconds: Double) {
        let t = CMTime(seconds: max(0, seconds), preferredTimescale: 600)
        player?.seek(to: t)
        currentTime = seconds
        publishNowPlayingElapsed()
    }

    public func setLyrics(_ text: String) {
        lyrics = text
        lyricsOrigin = text.isEmpty ? .none : .typed      // what the user typed wins over everything else, and is not asked of anybody
        lyricsSearching = false
        lyricsTask?.cancel()
        if queue.indices.contains(index) {
            store.saveLyrics(songKey: queue[index].songKey, text: text)
        }
    }

    public var currentSongKey: String? {
        queue.indices.contains(index) ? queue[index].songKey : nil
    }

    #if os(iOS)
    private func handleInterruption(_ note: Notification) {
        guard let info = note.userInfo,
              let typeVal = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeVal) else { return }
        if type == .began {
            pauseOnly()
        } else if type == .ended {
            let opts = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            if AVAudioSession.InterruptionOptions(rawValue: opts).contains(.shouldResume) {
                playOnly()
            }
        }
    }
    #endif

    // MARK: - Artwork + Now Playing

    /// The cover is SoundReel's business (ADR-0019): the phone's own copy if it has one, otherwise `GET coverPath`. Until it arrives,
    /// and when the server has none, the lock screen shows the drawn cover.
    private func loadArtwork(for item: QueueItem) {
        if let data = coverData, let art = Self.artwork(from: data) {
            artworkImage = art
            publishNowPlaying()
            return
        }
        artworkImage = Self.generatedArtwork(title: item.title, artist: item.artist, seed: item.songKey)
        publishNowPlaying()
        let songKey = item.songKey
        Task { [weak self] in
            guard let data = await CoverLoader.shared.data(songKey: songKey, coverPath: item.coverPath) else { return }
            guard let self, self.queue.indices.contains(self.index), self.queue[self.index].songKey == songKey else { return }   // the song changed meanwhile
            self.coverData = data
            if let art = Self.artwork(from: data) {
                self.artworkImage = art
                self.publishNowPlaying()
            }
        }
    }

    private static func artwork(from data: Data) -> MPMediaItemArtwork? {
        #if canImport(UIKit)
        guard let img = UIImage(data: data) else { return nil }
        return MPMediaItemArtwork(boundsSize: img.size) { _ in img }
        #else
        return nil
        #endif
    }

    private static func generatedArtwork(title: String, artist: String, seed: String) -> MPMediaItemArtwork? {
        #if canImport(UIKit) && !os(watchOS)
        let size = CGSize(width: 600, height: 600)
        let renderer = UIGraphicsImageRenderer(size: size)
        let img = renderer.image { ctx in
            let hash = seed.unicodeScalars.reduce(UInt32(0)) { ($0 &* 31) &+ $1.value }
            let c1 = UIColor(
                hue: CGFloat(hash % 360) / 360,
                saturation: 0.55,
                brightness: 0.35,
                alpha: 1
            )
            let c2 = UIColor(
                hue: CGFloat((hash / 7) % 360) / 360,
                saturation: 0.7,
                brightness: 0.55,
                alpha: 1
            )
            let colors = [c1.cgColor, c2.cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                ctx.cgContext.drawLinearGradient(
                    gradient,
                    start: .zero,
                    end: CGPoint(x: size.width, y: size.height),
                    options: []
                )
            }
            let label = ([title, artist].filter { !$0.isEmpty }.joined(separator: "\n"))
            let para = NSMutableParagraphStyle()
            para.alignment = .center
            let drawAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 36, weight: .bold),
                .foregroundColor: UIColor.white.withAlphaComponent(0.9),
                .paragraphStyle: para,
            ]
            let rect = CGRect(x: 40, y: size.height * 0.35, width: size.width - 80, height: 200)
            (label as NSString).draw(in: rect, withAttributes: drawAttrs)
        }
        return MPMediaItemArtwork(boundsSize: size) { _ in img }
        #else
        return nil
        #endif
    }

    private func publishNowPlaying() {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: artist,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
        ]
        if duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        if let artworkImage {
            info[MPMediaItemPropertyArtwork] = artworkImage
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        MPNowPlayingInfoCenter.default().playbackState = playing ? .playing : .paused
    }

    private func publishNowPlayingElapsed() {
        guard var info = MPNowPlayingInfoCenter.default().nowPlayingInfo else {
            publishNowPlaying()
            return
        }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTime
        info[MPNowPlayingInfoPropertyPlaybackRate] = playing ? 1.0 : 0.0
        if duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}
