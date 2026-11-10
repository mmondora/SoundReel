// MondropShortcuts.swift — the sentences Siri understands for Mondrop (spec 2026-11-10-mondrop-like-and-repeat-design.md L9). Every sentence
// has to name the app (`\(.applicationName)`: «Ehi Siri, mi piace questa canzone su Mondrop»), none may repeat another, and they carry no
// punctuation. A sentence can carry a playlist (Siri knows them by name: «metti la playlist Road trip su Mondrop») but never free text: a song
// is asked as an answer («Quale brano?»). The app is written in Italian and declared so (`developmentLanguage: it` in project.yml, `CFBundleLocalizations` in the
// Info.plist): Siri takes the sentences of an app in the language the app is written in. `SiriIntentsTests` reads this file.

import AppIntents

struct MondropShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: LikeCurrentSongIntent(),
            phrases: [
                "Mi piace questa canzone su \(.applicationName)",
                "Mi piace questo brano su \(.applicationName)",
                "Metti mi piace su \(.applicationName)",
            ],
            shortTitle: "Mi piace",
            systemImageName: "heart"
        )
        AppShortcut(
            intent: UnlikeCurrentSongIntent(),
            phrases: [
                "Non mi piace più questa canzone su \(.applicationName)",
                "Non mi piace più questo brano su \(.applicationName)",
                "Togli mi piace su \(.applicationName)",
            ],
            shortTitle: "Non mi piace più",
            systemImageName: "heart.slash"
        )
        AppShortcut(
            intent: SetRepeatModeIntent(mode: .one),
            phrases: [
                "Ripeti questo brano su \(.applicationName)",
                "Ripeti questa canzone su \(.applicationName)",
            ],
            shortTitle: "Ripeti questo brano",
            systemImageName: "repeat.1"
        )
        AppShortcut(
            intent: SetRepeatModeIntent(mode: .all),
            phrases: [
                "Ripeti tutto su \(.applicationName)",
                "Ripeti tutta la coda su \(.applicationName)",
            ],
            shortTitle: "Ripeti tutto",
            systemImageName: "repeat"
        )
        AppShortcut(
            intent: SetRepeatModeIntent(mode: .off),
            phrases: [
                "Non ripetere su \(.applicationName)",
                "Smetti di ripetere su \(.applicationName)",
            ],
            shortTitle: "Non ripetere",
            systemImageName: "arrow.right"
        )
        AppShortcut(
            intent: PlayPlaylistIntent(),
            phrases: [
                "Metti la playlist \(\.$playlist) su \(.applicationName)",
                "Riproduci la playlist \(\.$playlist) su \(.applicationName)",
                "Suona la playlist \(\.$playlist) su \(.applicationName)",
                "Riproduci \(\.$playlist) su \(.applicationName)",
            ],
            shortTitle: "Metti una playlist",
            systemImageName: "music.note.list"
        )
        AppShortcut(
            intent: PlaySongIntent(),
            phrases: [
                "Metti un brano su \(.applicationName)",
                "Metti una canzone su \(.applicationName)",
                "Cerca un brano su \(.applicationName)",
            ],
            shortTitle: "Metti un brano",
            systemImageName: "music.note"
        )
    }
}
