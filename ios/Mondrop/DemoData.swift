// DemoData.swift — DEBUG builds only. Launching with `-MondropDemo` makes the Home draw the data below (no server needed) and starts the
// player with a queue, so the screens can be looked at on a simulator: the Home with its rows, the mini player, «Riprendi», the Player.
// `-MondropDemoTab search|playlists|inbox|share|settings` opens another tab, `-MondropDemoPlayer` opens the Player, `-MondropDemoSearch`
// does what a tap on the field of the Home does. None of this exists in a Release build (TestFlight, the App Store).

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
    static var startTab: RootTab? {
        guard isOn, let at = arguments.firstIndex(of: "-MondropDemoTab"), arguments.indices.contains(at + 1) else { return nil }
        switch arguments[at + 1] {
        case "search": return .search
        case "playlists": return .playlists
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

    /// The queue the player starts with: «Playlist · Road trip», on its second song, a minute in. Written BEFORE the player exists: it
    /// restores it, paused, exactly as it does after the system closed the app.
    static func seedQueue() {
        guard isOn else { return }
        let items = recent.map { QueueItem(track: $0) }
        let store = QueueSnapshotStore()
        store.save(QueueSnapshot.make(queue: items, index: 1, label: "Playlist · Road trip", playlistId: "p1"))
        store.save(position: items[1].songKey, seconds: 74, duration: 241)
    }
}
#endif
