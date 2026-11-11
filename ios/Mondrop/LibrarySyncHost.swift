// LibrarySyncHost.swift — the one sync of every playlist the app has (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U2), wired to the real
// backend, engine and Settings, and the question it asks before a big download: «Da scaricare 3,4 GB (812 brani)» — Scarica tutto · Limita a X GB · Annulla.
// What decides is pure code in MondropKit (`SyncSizeGuard`, `LibrarySyncCoordinator`); this file only connects it.

import SwiftUI

extension LibrarySyncCoordinator {
    /// The first access and the «Sync» of the first page run through this one.
    @MainActor
    static let shared = LibrarySyncCoordinator(
        api: MondropAPI(),
        engine: .shared,
        limit: { Settings.shared.syncWarnLimit },
        hasKey: { !Settings.shared.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty },
        isFirstSyncDone: { Settings.shared.firstSyncDone },
        markFirstSyncDone: { Settings.shared.firstSyncDone = true },
        onSyncStarted: {
            // The right moment to ask iOS for notifications, once: the user has just pressed «Sync». And to refresh the playlists the share sheet offers.
            Task { await SyncNotifier.shared.ensurePermission() }
            Task { await InboxWiring.refreshPlaylistsCache() }
        }
    )
}

/// The question, over whatever screen the user is on: the first-access sync can start anywhere.
private struct SyncSizeDialogHost: ViewModifier {
    @ObservedObject var sync: LibrarySyncCoordinator

    private var question: SyncSizeQuestion? {
        if case .asking(let question) = sync.phase { return question }
        return nil
    }

    func body(content: Content) -> some View {
        content.confirmationDialog(
            question?.title ?? "",
            isPresented: Binding(
                get: { question != nil },
                // Dismissing the sheet without a choice is «Annulla»; an answer that comes after a choice is ignored by the coordinator.
                set: { shown in if !shown { sync.answer(.cancel) } }
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
    func syncSizeDialog(_ sync: LibrarySyncCoordinator) -> some View {
        modifier(SyncSizeDialogHost(sync: sync))
    }
}
