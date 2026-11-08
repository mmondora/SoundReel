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
    public let coverURL: String?
    public let lyrics: String?
    /// Server view of the track (urls, state). nil for items that only exist on the device.
    public let track: OfflineTrack?

    public init(songKey: String, title: String, artist: String, coverURL: String? = nil, lyrics: String? = nil, track: OfflineTrack? = nil) {
        self.songKey = songKey
        self.title = title
        self.artist = artist
        self.coverURL = coverURL
        self.lyrics = lyrics
        self.track = track
    }

    public init(local item: OfflineStore.Item) {
        self.init(songKey: item.songKey, title: item.title, artist: item.artist, coverURL: item.coverURL, lyrics: item.lyrics, track: nil)
    }

    public init(track: OfflineTrack) {
        self.init(songKey: track.songKey, title: track.title, artist: track.artist, coverURL: track.coverUrl, lyrics: track.lyrics, track: track)
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
    public static let shared = LocalAudioPlayer()

    @Published public private(set) var title: String = ""
    @Published public private(set) var artist: String = ""
    @Published public private(set) var coverURL: URL? = nil
    @Published public private(set) var lyrics: String = ""
    @Published public private(set) var playing: Bool = false
    @Published public private(set) var index: Int = 0
    @Published public private(set) var queue: [QueueItem] = []
    @Published public private(set) var currentTime: Double = 0
    @Published public private(set) var duration: Double = 0
    @Published public private(set) var playbackStatus: PlaybackStatus = .idle

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
    /// The playlist the current queue was started from (listening stats), nil for the offline list.
    public private(set) var queuePlaylistId: String?
    private var resolveTask: Task<Void, Never>?
    private var pendingSources: [PlaybackSource] = []
    private var artworkImage: MPMediaItemArtwork? = nil

    private init(store: OfflineStore = .shared, api: MondropAPIProtocol = MondropAPI(), recorder: PlayRecorder? = nil) {
        self.store = store
        self.api = api
        self.recorder = recorder ?? PlayRecorder.shared
        configureSession()
        configureRemoteCommands()
        #if os(iOS)
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] note in
            Task { @MainActor in self?.handleInterruption(note) }
        }
        #endif
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

    private func configureRemoteCommands() {
        let cc = MPRemoteCommandCenter.shared()
        cc.playCommand.isEnabled = true
        cc.pauseCommand.isEnabled = true
        cc.togglePlayPauseCommand.isEnabled = true
        cc.nextTrackCommand.isEnabled = true
        cc.previousTrackCommand.isEnabled = true
        cc.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.playOnly() }
            return .success
        }
        cc.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.pauseOnly() }
            return .success
        }
        cc.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.toggle() }
            return .success
        }
        cc.nextTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.next() }
            return .success
        }
        cc.previousTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.previous() }
            return .success
        }
    }

    // MARK: - Queue

    /// `playlistId`: the playlist the user started this queue from (recorded with every listen), nil otherwise.
    public func setQueue(_ items: [QueueItem], startAt: Int = 0, playlistId: String? = nil) {
        queue = items
        queuePlaylistId = playlistId
        guard !items.isEmpty else { return }
        play(at: min(max(0, startAt), items.count - 1))
    }

    /// Local-only convenience (the "Coda offline" tab).
    public func setQueue(local items: [OfflineStore.Item], startAt: Int = 0) {
        setQueue(items.map { QueueItem(local: $0) }, startAt: startAt, playlistId: nil)
    }

    public func play(at i: Int) {
        guard queue.indices.contains(i) else { return }
        resolveTask?.cancel()
        resolveTask = nil
        recorder.tracker.finish(completed: false)       // leaving the previous song: its session ends here
        teardownCurrentItem()
        playing = false
        configureSession()
        index = i
        let entry = queue[i]
        title = entry.title
        artist = entry.artist
        coverURL = entry.coverURL.flatMap { URL(string: $0) }
        lyrics = store.lyrics(for: entry.songKey) ?? entry.lyrics ?? ""
        artworkImage = nil
        currentTime = 0
        duration = 0
        loadArtwork(for: entry)

        // 1) already on the device → the file, no network at all.
        if let file = store.fileURL(songKey: entry.songKey) {
            start(sources: [PlaybackSource(url: file, headers: [:], kind: nil)], status: .local)
            return
        }

        // 2) first play: decide with the freshest idea of "am I at home".
        playbackStatus = .preparing
        resolveTask = Task { [weak self] in
            await self?.resolveRemote(entry, at: i)
        }
    }

    private func resolveRemote(_ entry: QueueItem, at i: Int) async {
        let home = await NetStatus.shared.currentHome(api: api)
        guard !Task.isCancelled, index == i else { return }
        let config = MondropAPIConfig.current()
        // The user deleted this song from the phone to save space: stream it, never download it again behind his back.
        let skipListed = store.isSkipped(entry.songKey)
        switch FirstPlay.decide(songKey: entry.songKey, track: entry.track, local: store.fileURL(songKey: entry.songKey), home: home, config: config, skipListed: skipListed) {
        case .local(let url):
            start(sources: [PlaybackSource(url: url, headers: [:], kind: nil)], status: .local)
        case .stream(let sources, let download):
            SyncEngine.shared.enqueue([download], home: home, front: true)   // in parallel, for next time
            start(sources: sources, status: .streaming)
        case .streamWithoutDownload(let sources):
            start(sources: sources, status: .streaming)
        case .prepare(let track):
            playbackStatus = .preparing
            do {
                let ready = try await PlaybackPreparation.awaitReady(track, api: api)
                guard !Task.isCancelled, index == i else { return }
                store.recordServerNumbers(songKey: ready.songKey, plays: ready.plays, lastPlayedAt: ready.lastPlayedDate)
                switch FirstPlay.decide(songKey: entry.songKey, track: ready, local: store.fileURL(songKey: entry.songKey), home: home, config: config, skipListed: skipListed) {
                case .local(let url):
                    start(sources: [PlaybackSource(url: url, headers: [:], kind: nil)], status: .local)
                case .stream(let sources, let download):
                    SyncEngine.shared.enqueue([download], home: home, front: true)
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

    // MARK: - AVPlayer plumbing

    /// Tries the sources in order; a stream that fails to load (e.g. media server refused) falls back to the next.
    private func start(sources: [PlaybackSource], status: PlaybackStatus) {
        pendingSources = sources
        playbackStatus = status
        if queue.indices.contains(index) {
            let entry = queue[index]
            // One listening session per song start (a media-server → proxy fallback stays the same session).
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
            Task { @MainActor in
                self?.recorder.tracker.finish(completed: true)   // it arrived at the end
                self?.next()
            }
        }
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] observed, _ in
            guard observed.status == .failed else { return }
            Task { @MainActor in self?.itemFailed(observed) }
        }
        let newPlayer = AVPlayer(playerItem: item)
        player = newPlayer
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
        let n = index + 1
        if n < queue.count {
            play(at: n)
        } else {
            playing = false
            publishNowPlaying()
        }
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

    private func loadArtwork(for item: QueueItem) {
        guard let raw = item.coverURL, let url = URL(string: raw) else {
            artworkImage = Self.generatedArtwork(title: item.title, artist: item.artist, seed: item.songKey)
            publishNowPlaying()
            return
        }
        Task {
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                #if canImport(UIKit)
                if let img = UIImage(data: data) {
                    artworkImage = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
                    publishNowPlaying()
                    return
                }
                #endif
            } catch { /* fall through */ }
            artworkImage = Self.generatedArtwork(title: item.title, artist: item.artist, seed: item.songKey)
            publishNowPlaying()
        }
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
