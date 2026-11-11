// PlayingSyncHost.swift — the sync of the playlist that PLAYS (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U2; Michele, 11 November:
// «Il sync deve girare solo per playlist che sto suonando. Non di tutti in assoluto.»), wired to the real backend, engine and Settings, and the question it asks
// before a big download: «Da scaricare 3,4 GB (812 brani)» — Scarica tutto · Limita a X GB · Annulla.
// What decides is pure code in MondropKit (`PlaylistSyncTrigger`, `SyncSizeGuard`, `PlayingSyncGate`, `PlayingPlaylistSync`); this file only connects it.

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
        // Only what the share sheet offers is refreshed here. iOS is asked for notifications when the user presses «Sync» inside a playlist, never behind their back.
        onSyncStarted: { Task { await InboxWiring.refreshPlaylistsCache() } }
    )
}

/// The question, over whatever screen the user is on: the sync starts when a playlist begins to play, wherever the user is.
private struct SyncSizeDialogHost: ViewModifier {
    @ObservedObject var sync: PlayingPlaylistSync
    /// The Player covers the screen: a dialog cannot come up over it, so the question waits (the sync with it) until the Player is closed.
    let suppressed: Bool

    private var question: SyncSizeQuestion? {
        if case .asking(let question) = sync.phase { return question }
        return nil
    }

    func body(content: Content) -> some View {
        content.confirmationDialog(
            question?.title ?? "",
            isPresented: Binding(
                get: { question != nil && !suppressed },
                // Dismissing the sheet without a choice is «Annulla»; an answer that comes after a choice is ignored by the coordinator.
                set: { shown in if !shown, question != nil, !suppressed { sync.answer(.cancel) } }
            ),
            titleVisibility: .visible
        ) {
            if let question {
                Button(question.allButtonTitle) { sync.answer(.all) }
                Button(question.limitButtonTitle) { sync.answer(.limit) }
                Button(question.cancelButtonTitle, role: .cancel) { sync.answer(.cancel) }
            }
        } message: {
            if let question { Text(question.message) }
        }
    }
}

extension View {
    func syncSizeDialog(_ sync: PlayingPlaylistSync, suppressed: Bool) -> some View {
        modifier(SyncSizeDialogHost(sync: sync, suppressed: suppressed))
    }
}
