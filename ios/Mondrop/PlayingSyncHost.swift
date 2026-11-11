// PlayingSyncHost.swift — the sync of the playlist that PLAYS (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U2; Michele, 11 November:
// «Il sync deve girare solo per playlist che sto suonando. Non di tutti in assoluto.»), wired to the real backend, engine and Settings, and the question it asks
// before a big download: «Da scaricare 3,4 GB (812 brani)» — Scarica tutto · Limita a X GB · Annulla.
// And the check of the playlists the phone holds (Michele, 11 November: «Voglio un check di consistenza con sync sulle impostazioni…», U15), with the same question.
// What decides is pure code in MondropKit (`PlaylistSyncTrigger`, `SyncSizeGuard`, `PlayingSyncGate`, `PlayingPlaylistSync`, `PlaylistConsistencyCheck`); this file only connects it.

import SwiftUI

extension PlayingPlaylistSync {
    /// The one sync of the app: `MondropApp` points the shared player at it, and the root screen puts its question on the display.
    @MainActor
    static let shared = PlayingPlaylistSync(
        api: MondropAPI(),
        engine: .shared,
        limit: { Settings.shared.syncWarnLimit },
        hasKey: { !Settings.shared.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty },
        activity: .shared,
        // Only what the share sheet offers is refreshed here. iOS is asked for notifications when the user asks for a sync of their own (the check in the Settings, a «Riprova»
        // on a song), never behind their back.
        onSyncStarted: { Task { await InboxWiring.refreshPlaylistsCache() } },
        // the list of the playlist that plays is kept, so that its page opens with it
        cache: FilePlaylistManifestCache.shared
    )
}

extension PlaylistConsistencyCheck {
    /// The one check of the app: the button in the Settings starts it, and the Settings put its question on the display.
    @MainActor
    static let shared = PlaylistConsistencyCheck(
        api: MondropAPI(),
        engine: .shared,
        limit: { Settings.shared.syncWarnLimit },
        hasKey: { !Settings.shared.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty },
        cache: FilePlaylistManifestCache.shared,
        activity: .shared
    )
}

/// The question of a big download, over whatever screen the user is on: «Da scaricare 3,4 GB (812 brani)» — Scarica tutto · Limita a X GB · Annulla.
private struct SyncSizeDialogHost: ViewModifier {
    let question: SyncSizeQuestion?
    /// The Player covers the screen: a dialog cannot come up over it, so the question waits (the sync with it) until the Player is closed.
    let suppressed: Bool
    let answer: (SyncSizeChoice) -> Void

    func body(content: Content) -> some View {
        content.confirmationDialog(
            question?.title ?? "",
            isPresented: Binding(
                get: { question != nil && !suppressed },
                // Dismissing the sheet without a choice is «Annulla»; an answer that comes after a choice is ignored by whoever asked.
                set: { shown in if !shown, question != nil, !suppressed { answer(.cancel) } }
            ),
            titleVisibility: .visible
        ) {
            if let question {
                Button(question.allButtonTitle) { answer(.all) }
                Button(question.limitButtonTitle) { answer(.limit) }
                Button(question.cancelButtonTitle, role: .cancel) { answer(.cancel) }
            }
        } message: {
            if let question { Text(question.message) }
        }
    }
}

extension View {
    /// The question of the sync of the playlist that plays (the root screen: it can come up wherever the user is).
    func syncSizeDialog(_ sync: PlayingPlaylistSync, suppressed: Bool) -> some View {
        modifier(SyncSizeDialogHost(question: sync.question, suppressed: suppressed, answer: { sync.answer($0) }))
    }

    /// The question of the check of the playlists (the Settings).
    func syncSizeDialog(_ check: PlaylistConsistencyCheck) -> some View {
        modifier(SyncSizeDialogHost(question: check.question, suppressed: false, answer: { check.answer($0) }))
    }

    /// The question of the «Scarica tutta» of a playlist (its page): the page that started the download puts the question over itself.
    func syncSizeDialog(_ presenter: SizeQuestionPresenter) -> some View {
        modifier(SyncSizeDialogHost(question: presenter.question, suppressed: false, answer: { presenter.answer($0) }))
    }
}
