// ios/Mondrop/MondropApp.swift

import SwiftUI

@main
struct MondropApp: App {
    #if os(iOS)
    // Hands the background-download completion handler to the transport (see MondropAppDelegate).
    @UIApplicationDelegateAdaptor(MondropAppDelegate.self) private var appDelegate
    #endif
    @State private var deepLinkStatus: String?
    @Environment(\.scenePhase) private var scenePhase

    init() {
        #if os(iOS)
        // `beginBackgroundTask` is UIKit: the share extension cannot link it, so the app plugs it in.
        EventUploader.shared.backgroundRunner = UIKitBackgroundTaskRunner()
        #endif
        // «Sync finito» notification: ready before the first download can finish (also on a background relaunch).
        SyncNotifications.install()
    }

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .overlay(alignment: .bottom) {
                    if let deepLinkStatus {
                        Text(deepLinkStatus)
                            .font(.footnote)
                            .padding(10)
                            .background(.ultraThinMaterial, in: Capsule())
                            .padding(.bottom, 24)
                    }
                }
            .onOpenURL { url in
                Task { await handleDeepLink(url) }
            }
            .task {
                // Launch: drop interrupted installs / stale resume data, then pick up downloads the
                // background session kept running while the app was suspended.
                OfflineStore.shared.cleanTemporary()
                await SyncEngine.shared.attachExisting()
                // A listen cut short by a crash becomes its event now, then everything queued goes out.
                PlayRecorder.shared.recoverInterruptedSession()
                // `onChange(of: scenePhase)` does not fire for the phase the app starts in: start the 15-minute
                // foreground timer here too (it is stopped when the app goes to background).
                EventUploader.shared.startForegroundTimer()
                await EventUploader.shared.flush(.launch)
            }
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active:
                    EventUploader.shared.startForegroundTimer()              // every 15 minutes while in foreground
                case .background:
                    PlayRecorder.shared.checkpoint()                          // the open listen survives a kill
                    EventUploader.shared.stopForegroundTimer()
                    Task { await EventUploader.shared.flush(.background) }    // inside a background task
                default:
                    break
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: KeyConnect.didChange)) { _ in
                // A new key: a 401 pause was about the old one.
                EventUploader.shared.clearAuthPause()
                Task { await EventUploader.shared.flush(.keyChanged) }
            }
        }
        #if os(macOS)
        .defaultSize(width: 420, height: 520)
        #endif
    }

    /// Simulator / Shortcuts smoke: `mondrop://share?url=https://…&comment=%23tag`
    private func handleDeepLink(_ url: URL) async {
        guard url.scheme?.lowercased() == "mondrop" else { return }
        let host = (url.host ?? url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))).lowercased()
        if host == "auth" {
            // Key handed back by the SoundReel connect page when it was opened outside the in-app sheet (Safari).
            if let issued = KeyConnect.parseCallback(url) {
                KeyConnect.apply(issued)
                await MainActor.run { deepLinkStatus = "Collegato come \(issued.user) ✓" }
            } else {
                await MainActor.run { deepLinkStatus = "Link di collegamento non valido" }
            }
            return
        }
        guard host == "share" else {
            await MainActor.run { deepLinkStatus = "Deep link sconosciuto" }
            return
        }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let shared = items.first(where: { $0.name == "url" })?.value?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let comment = items.first(where: { $0.name == "comment" })?.value
        guard shared.hasPrefix("http") else {
            await MainActor.run { deepLinkStatus = "URL mancante nel deep link" }
            return
        }
        await MainActor.run { deepLinkStatus = "Invio…" }
        do {
            let resp = try await BackendClient().share(url: shared, comment: comment, tags: nil)
            if resp.success {
                if let tags = resp.tags, !tags.isEmpty {
                    Settings.shared.rememberTags(tags)
                }
                await MainActor.run { deepLinkStatus = "In coda ✓" }
            } else {
                await MainActor.run { deepLinkStatus = resp.error ?? "Errore share" }
            }
        } catch let e as BackendError {
            await MainActor.run { deepLinkStatus = e.description }
        } catch {
            await MainActor.run { deepLinkStatus = "Errore" }
        }
    }
}
