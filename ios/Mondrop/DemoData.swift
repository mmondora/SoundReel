// DemoData.swift — DEBUG builds only. Launching with `-MondropDemo` makes the Home draw the data below (no server needed) and starts the
// player with a queue, so the screens can be looked at on a simulator: the Home with its rows, the mini player, «Riprendi», the Player.
// `-MondropDemoTab search|playlists|inbox|share|settings` opens another tab (`playlists` pushes the whole list from the Home: the tab is gone), `-MondropDemoPlayer` opens the Player, `-MondropDemoSearch`
// does what a tap on the field of the Home does; `-MondropDemoLiked`, `-MondropDemoRepeat off|all|one` and `-MondropDemoCommands` show
// the hearts, the loop and the list of the commands received (spec 2026-11-10-mondrop-like-and-repeat-design.md). None of this exists in a Release build (TestFlight, the App Store).

#if DEBUG
import Foundation

enum DemoData {
    private static var arguments: [String] { ProcessInfo.processInfo.arguments }

    static var isOn: Bool { arguments.contains("-MondropDemo") }
    static var opensPlayer: Bool { isOn && arguments.contains("-MondropDemoPlayer") }
    static var focusesSearch: Bool { isOn && arguments.contains("-MondropDemoSearch") }
    /// `-MondropDemoPush playlist` (from the Home) / `library` (from Cerca): a page pushed over the tab, to see the mini player on it.
    static var push: String? {
        guard isOn, let at = arguments.firstIndex(of: "-MondropDemoPush"), arguments.indices.contains(at + 1) else { return nil }
        return arguments[at + 1]
    }
    /// `-MondropDemoLyrics internet|transcript|instrumental`: what the phone «kept» for the song the demo queue is on; and
    /// `-MondropDemoLyricsSheet` opens the sheet of the words on the Player.
    static var lyrics: String? {
        guard isOn, let at = arguments.firstIndex(of: "-MondropDemoLyrics"), arguments.indices.contains(at + 1) else { return nil }
        return arguments[at + 1]
    }
    static var opensLyricsSheet: Bool { isOn && arguments.contains("-MondropDemoLyricsSheet") }
    /// `-MondropDemoLiked`: three of the demo songs are liked, as if SoundReel had said so (the one the queue is on is among them).
    static var showsLikes: Bool { isOn && arguments.contains("-MondropDemoLiked") }
    /// `-MondropDemoRepeat off|all|one`: the loop the Player starts with.
    static var repeatMode: RepeatMode? {
        guard isOn, let at = arguments.firstIndex(of: "-MondropDemoRepeat"), arguments.indices.contains(at + 1) else { return nil }
        return RepeatMode(rawValue: arguments[at + 1])
    }
    /// `-MondropDemoCommands`: the list of the commands received (Settings) has a few lines, as after a drive, and is open.
    static var showsCommands: Bool { isOn && arguments.contains("-MondropDemoCommands") }
    /// `-MondropDemoQueueSheet` opens «In coda» on the Player: the rows of the songs, with the hearts of the liked ones.
    static var opensQueueSheet: Bool { isOn && arguments.contains("-MondropDemoQueueSheet") }
    /// The Home pushes the whole list of the playlists: `-MondropDemoPush allplaylists`, or the old `-MondropDemoTab playlists`.
    static var opensAllPlaylists: Bool {
        guard isOn else { return false }
        if push == "allplaylists" { return true }
        guard let at = arguments.firstIndex(of: "-MondropDemoTab"), arguments.indices.contains(at + 1) else { return false }
        return arguments[at + 1] == "playlists"
    }
    /// `-MondropDemoSearchText daft`: the words Cerca starts with, so that its rows can be looked at.
    static var searchText: String? {
        guard isOn, let at = arguments.firstIndex(of: "-MondropDemoSearchText"), arguments.indices.contains(at + 1) else { return nil }
        return arguments[at + 1]
    }
    static var startTab: RootTab? {
        guard isOn, let at = arguments.firstIndex(of: "-MondropDemoTab"), arguments.indices.contains(at + 1) else { return nil }
        switch arguments[at + 1] {
        case "search": return .search
        case "playlists": return .home                // the whole list of the playlists is a page pushed from the Home (see `opensAllPlaylists`)
        case "inbox": return .inbox
        case "share": return .share
        case "settings": return .settings
        default: return nil
        }
    }

    private static func track(_ artist: String, _ title: String, state: String = "ready") -> OfflineTrack {
        OfflineTrack(songKey: "\(artist.lowercased())::\(title.lowercased())", title: title, artist: artist, state: state)
    }

    private static let recent = [
        track("Michael Jackson", "Billie Jean"), track("Daft Punk", "One More Time"), track("Madonna", "Like a Prayer"),
        track("New Order", "Blue Monday"), track("Toto", "Africa"), track("a-ha", "Take On Me"),
    ]
    private static let fresh = [
        track("Fontaines D.C.", "Starburster", state: "missing"), track("Bassi Maestro", "Fuori dal tunnel", state: "missing"),
        track("Charli xcx", "Apple", state: "ready"), track("Tame Impala", "Dracula", state: "missing"),
        track("Rosalía", "Berghain", state: "ready"), track("Nick Cave", "Joy", state: "missing"),
    ]

    static let home = HomeResponse(user: "mike", displayName: "Michele", sections: [
        HomeSection(id: "playlists", title: "Le tue playlist", kind: .playlists, playlists: [
            HomePlaylist(id: "p1", name: "Road trip", songCount: 7, kind: "static", canEdit: true, coverKeys: recent.prefix(4).map(\.songKey)),
            HomePlaylist(id: "p2", name: "Più ascoltate", songCount: 24, kind: "dynamic", ruleSummary: "Più ascoltate · ultimi 30 giorni"),
            HomePlaylist(id: "p3", name: "Anni 80", songCount: 41, kind: "static", canEdit: true, coverKeys: [recent[3].songKey]),
            HomePlaylist(id: "p4", name: "Reel di novembre", songCount: 12, kind: "static", canEdit: true, coverKeys: fresh.prefix(4).map(\.songKey)),
        ]),
        HomeSection(id: "recent", title: "Ascoltati di recente", kind: .tracks, tracks: recent),
        HomeSection(id: "fresh", title: "Nuovi dai tuoi reel", kind: .tracks, tracks: fresh),
    ])

    struct Transport: HomeTransport {
        func home() async throws -> HomeResponse { DemoData.home }
    }

    // MARK: the playlists, their songs and what the phone holds (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U3, U9)

    private static let roadTrip = recent + [track("Dua Lipa", "Houdini")]
    /// Three of them are on the phone (they are in «Road trip» too), two are not: online.
    private static let topPlayed = Array(recent.prefix(3)) + [track("Queen", "Don't Stop Me Now"), track("Prince", "Kiss")]
    private static let eighties = [
        track("Toto", "Africa"), track("a-ha", "Take On Me"),                       // on the phone
        track("Michael Jackson", "Thriller"), track("Madonna", "Material Girl"),    // online
        track("Duran Duran", "Rio", state: "failed"),                               // the server could not prepare it: an error
        track("Cyndi Lauper", "Time After Time", state: "preparing"),                // online, the server is on it
    ]
    private static let novemberReels = fresh

    /// The songs of each playlist, as its manifest says.
    static let playlistTracks: [String: [OfflineTrack]] = ["p1": roadTrip, "p2": topPlayed, "p3": eighties, "p4": novemberReels]

    /// Which of them are on the phone: the whole of «Road trip» (a tick on its card); that makes three of the most played and two of the eighties; none of the reels.
    private static let onPhone: Set<String> = Set(roadTrip.map(\.songKey))

    /// Every playlist the phone «has read» and the files it «holds»: written before the screens look. A tiny file stands for each song.
    static func seedStore() {
        guard isOn else { return }
        let store = OfflineStore.shared
        for (id, name) in [("p1", "Road trip"), ("p2", "Più ascoltate"), ("p3", "Anni 80"), ("p4", "Reel di novembre")] {
            let tracks = playlistTracks[id] ?? []
            store.recordPlaylist(id: id, name: name, songKeys: tracks.map(\.songKey), failedKeys: tracks.filter { $0.resolvedState == .failed }.map(\.songKey))
        }
        for key in onPhone where store.fileURL(songKey: key) == nil {
            let staged = store.stagingURL()
            guard (try? Data(repeating: 1, count: 2_000).write(to: staged)) != nil else { continue }
            let song = (recent + eighties + roadTrip).first { $0.songKey == key }
            _ = try? store.install(stagedFile: staged, songKey: key, metadata: InstallMetadata(title: song?.title ?? key, artist: song?.artist ?? "", version: "demo-1"))
        }
    }

    /// The page of a playlist, without a server.
    struct PlaylistAPI: MondropAPIProtocol {
        func listPlaylists() async throws -> [MondropPlaylist] { DemoData.playlists }
        func offlineManifest(playlistId: String) async throws -> OfflineManifest {
            let name = DemoData.playlists.first { $0.id == playlistId }?.name ?? "Playlist"
            return OfflineManifest(playlistId: playlistId, name: name, tracks: DemoData.playlistTracks[playlistId] ?? [], user: "mike", dynamic: playlistId == "p2")
        }
        func prepare(playlistId: String, retryFailed: Bool) async throws -> OfflineManifest { try await offlineManifest(playlistId: playlistId) }
        func net() async throws -> NetInfo { NetInfo(viaCloudflare: false, home: true) }
        func track(songKey: String) async throws -> OfflineTrack { throw MondropAPIError.http(404, nil) }
        func requestDownload(songKey: String, priority: DownloadPriority) async throws -> DownloadAck { DownloadAck(ok: true, state: "preparing", track: nil) }
        func setSource(songKey: String, youtubeUrl: String) async throws {}
    }

    static let playlists: [MondropPlaylist] = [
        MondropPlaylist(id: "p1", name: "Road trip", songCount: 7, createdAt: "2026-11-02T10:00:00.000Z", kind: "static", canEdit: true),
        MondropPlaylist(id: "p2", name: "Più ascoltate", songCount: 5, createdAt: "2026-10-20T10:00:00.000Z", kind: "dynamic", ruleSummary: "Più ascoltate · ultimi 30 giorni"),
        MondropPlaylist(id: "p3", name: "Anni 80", songCount: 6, createdAt: "2026-09-14T10:00:00.000Z", kind: "static", canEdit: true),
        MondropPlaylist(id: "p4", name: "Reel di novembre", songCount: 6, createdAt: "2026-11-09T10:00:00.000Z", kind: "static", canEdit: true),
        MondropPlaylist(id: "p5", name: "Jazz da ascoltare", songCount: 0, createdAt: "2026-11-10T07:30:00.000Z", kind: "static", canEdit: true, origin: "auto", autoKind: "theme"),
    ]

    /// The full list of the playlists (search, sort, pages) without a server.
    struct PlaylistListAPI: PlaylistListTransport {
        func playlistsPage(_ query: PlaylistListQuery) async throws -> PlaylistPage {
            PlaylistPage(playlists: DemoData.playlists, total: DemoData.playlists.count, limit: nil, offset: 0)
        }
    }

    /// «Cerca» without a server: the same songs for any words, some of them on the phone.
    struct SearchAPI: SearchTransport {
        func search(_ query: SearchQuery) async throws -> SearchPage {
            let tracks = DemoData.recent + DemoData.fresh
            return SearchPage(q: query.text, tracks: tracks, artists: [], albums: [], total: tracks.count, offset: 0, limit: query.limit, user: "mike")
        }
    }

    /// The queue the player starts with: «Playlist · Road trip», on its second song, a minute in. Written BEFORE the player exists: it
    /// restores it, paused, exactly as it does after the system closed the app.
    static func seedQueue() {
        guard isOn else { return }
        let items = recent.map { QueueItem(track: $0) }
        let store = QueueSnapshotStore()
        store.save(QueueSnapshot.make(queue: items, index: 1, label: "Playlist · Road trip", playlistId: "p1"))
        store.save(position: items[1].songKey, seconds: 74, duration: 241)
        seedLyrics(for: items[1].songKey)
        seedLikes()
        seedStore()
        DefaultsRepeatModeStore(defaults: Settings.shared.storage).mode = repeatMode ?? .off
        seedCommands()
    }

    /// The likes file of the phone, written BEFORE the store exists (it reads it at its start). Always written in the demo, so that the
    /// hearts of an earlier run never linger.
    private static func seedLikes() {
        let owner = Settings.shared.autheliaUsername.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let keys: Set<String> = showsLikes ? ["daft punk::one more time", "toto::africa", "michael jackson::billie jean"] : []
        guard let data = try? EventCoding.encoder().encode(LikesState(owner: owner, serverKeys: keys, pending: [])) else { return }
        let dir = OfflineStore.defaultRoot()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? data.write(to: dir.appendingPathComponent("likes.json"), options: .atomic)
    }

    /// A few lines for the list of the commands received, as the list keeps them (newest first).
    private static func seedCommands() {
        var list: [RemoteCommandRecord] = []
        if showsCommands {
            let names = ["Play/Pausa", "Avanti", "Ripeti: tutto", "Mi piace", "Siri: Ripeti: questo brano", "Siri: Mi piace"]
            let start = Date().addingTimeInterval(-3_600)
            for (n, name) in names.enumerated() { list = RemoteCommandHistory.adding(name, at: start.addingTimeInterval(Double(n) * 340), to: list) }
        }
        let data = (try? EventCoding.encoder().encode(list)) ?? Data()
        Settings.shared.storage.set(data, forKey: RemoteCommandLog.key)
    }

    /// Words of the demo (a short original text, not a real song's), kept as if SoundReel had found them earlier.
    private static func seedLyrics(for songKey: String) {
        guard let kind = lyrics else { return }
        let text = """
        Prima riga di prova, scritta per vedere il foglio
        Seconda riga, un poco più lunga della prima riga
        Il ritornello torna e il ritornello è questo qui
        Il ritornello torna e il ritornello è questo qui

        Una strofa nuova comincia dopo la riga vuota
        e finisce quando finiscono le parole di prova
        """
        let dir = LyricsLoader.defaultDirectory
        let file = dir.appendingPathComponent(LyricsLoader.fileStem(songKey)).appendingPathExtension("json")
        let kept: SongLyrics?
        switch kind {
        case "internet": kept = SongLyrics(text: text, source: .internet)
        case "transcript": kept = SongLyrics(text: text, source: .transcript)
        case "instrumental": kept = SongLyrics(text: "", source: .internet, instrumental: true)
        default: kept = nil                          // «none»: forget what an earlier run kept, so the song has no words
        }
        guard let kept, let data = try? JSONEncoder().encode(kept) else {
            try? FileManager.default.removeItem(at: file)
            return
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
    }
}

extension DemoData.PlaylistAPI: PlaylistListing {}

import SwiftUI

/// With `-MondropDemoCommands` the Settings scroll to the list of the commands received (it is below the fold): a screenshot cannot scroll.
struct DemoSettingsScroll<Content: View>: View {
    let content: Content

    var body: some View {
        ScrollViewReader { proxy in
            content.task {
                guard DemoData.showsCommands else { return }
                try? await Task.sleep(for: .seconds(1))
                proxy.scrollTo("commandsRow", anchor: .top)
            }
        }
    }
}
#endif
