// MondropIntents.swift — what Siri can do in Mondrop (spec 2026-11-10-mondrop-like-and-repeat-design.md L9; Michele's photos of the Tesla,
// 10 November: over Bluetooth it shows previous / pause / next and nothing else). «Ehi Siri, mi piace questa canzone su Mondrop» works
// whatever the head unit shows. The intents are thin: they carry the request to the player and the likes the app already has
// (`VoiceActions`) and speak the answer in one short Italian sentence. They run in the app's own process and never open the app: Siri
// answers in the car and the music goes on. The sentences are in `MondropShortcuts.swift`.

import AppIntents

/// «Mi piace questa canzone»: the like for the song that is on.
struct LikeCurrentSongIntent: AppIntent {
    static let title: LocalizedStringResource = "Mi piace questa canzone"
    static let description = IntentDescription("Mette «Mi piace» alla canzone che sta suonando in Mondrop.")
    static let openAppWhenRun = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        .result(dialog: IntentDialog(stringLiteral: VoiceActions.run(.like)))
    }
}

/// «Non mi piace più questa canzone»: takes the like back.
struct UnlikeCurrentSongIntent: AppIntent {
    static let title: LocalizedStringResource = "Non mi piace più questa canzone"
    static let description = IntentDescription("Toglie il «Mi piace» alla canzone che sta suonando in Mondrop.")
    static let openAppWhenRun = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        .result(dialog: IntentDialog(stringLiteral: VoiceActions.run(.unlike)))
    }
}

/// The three loops, as the Shortcuts app and Siri name them.
enum RepeatModeOption: String, AppEnum {
    case off, all, one

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Ripetizione")
    static let caseDisplayRepresentations: [RepeatModeOption: DisplayRepresentation] = [
        .off: DisplayRepresentation(title: "Nessuna"),
        .all: DisplayRepresentation(title: "Tutto"),
        .one: DisplayRepresentation(title: "Questo brano"),
    ]

    var mode: RepeatMode { RepeatMode(rawValue: rawValue) ?? .off }
}

/// «Ripeti questo brano» / «Ripeti tutto» / «Non ripetere»: the loop of the player.
struct SetRepeatModeIntent: AppIntent {
    static let title: LocalizedStringResource = "Imposta la ripetizione"
    static let description = IntentDescription("Sceglie se Mondrop ripete il brano, tutta la coda o niente.")
    static let openAppWhenRun = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    @Parameter(title: "Ripetizione")
    var mode: RepeatModeOption

    init() {}

    init(mode: RepeatModeOption) {
        self.mode = mode
    }

    static var parameterSummary: some ParameterSummary {
        Summary("Ripeti \(\.$mode)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        .result(dialog: IntentDialog(stringLiteral: VoiceActions.run(.repeatMode(mode.mode))))
    }
}

/// «Metti la playlist X»: a playlist by name, dynamic and automatic ones too. An audio intent: iOS lets the app start playing in the
/// background when Siri asks, with the phone locked (`authenticationPolicy`), in the car.
struct PlayPlaylistIntent: AudioPlaybackIntent {
    static let title: LocalizedStringResource = "Metti una playlist"
    static let description = IntentDescription("Suona una delle tue playlist, anche una dinamica o automatica.")
    static let openAppWhenRun = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    @Parameter(title: "Playlist", requestValueDialog: "Quale playlist?", requestDisambiguationDialog: "Quale di queste playlist?")
    var playlist: PlaylistEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Metti la playlist \(\.$playlist)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let spoken = await VoiceActions.playPlaylist(id: playlist.id, name: playlist.name)
        return .result(dialog: IntentDialog(stringLiteral: spoken))
    }
}

/// «Metti un brano»: Siri asks «Quale brano?» (a sentence of the shortcuts cannot carry free text) and the answer is searched like the box of
/// Cerca searches; the best match starts, with the ones that follow it.
struct PlaySongIntent: AudioPlaybackIntent {
    static let title: LocalizedStringResource = "Metti un brano"
    static let description = IntentDescription("Cerca un brano nella tua musica e lo suona, con quelli che seguono.")
    static let openAppWhenRun = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    @Parameter(title: "Brano", requestValueDialog: "Quale brano?")
    var song: String

    static var parameterSummary: some ParameterSummary {
        Summary("Metti \(\.$song)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let spoken = await VoiceActions.playSong(spoken: song)
        return .result(dialog: IntentDialog(stringLiteral: spoken))
    }
}
