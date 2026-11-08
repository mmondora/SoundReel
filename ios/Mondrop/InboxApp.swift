// InboxApp.swift — the app's own instances of the Posta pieces, and the system parts MondropKit cannot link
// (UIKit's push registration, the icon badge). What decides anything is tested in MondropKit.

import SwiftUI
import UserNotifications
#if os(iOS)
import UIKit
#endif

/// The number on the app icon (iOS 16+). It needs the «badge» permission; without it the call fails and nothing is lost.
struct UNBadgeSetter: BadgeSetting {
    func setBadge(_ count: Int) async {
        try? await UNUserNotificationCenter.current().setBadgeCount(count)
    }
}

#if os(iOS)
/// `registerForRemoteNotifications` — answered in the app delegate (`didRegister…` / `didFail…`). Without the
/// `aps-environment` entitlement iOS answers «no» at once and push stays off: see ios/README.md.
@MainActor
final class UIKitPushSystem: PushSystem {
    static let shared = UIKitPushSystem()
    func registerForRemoteNotifications() { UIApplication.shared.registerForRemoteNotifications() }
    func unregisterForRemoteNotifications() { UIApplication.shared.unregisterForRemoteNotifications() }
}
#endif

extension PushRegistrar {
    static let shared: PushRegistrar = {
        #if os(iOS)
        let system: PushSystem? = UIKitPushSystem.shared
        #else
        let system: PushSystem? = nil
        #endif
        return PushRegistrar(
            transport: MondropAPI(),
            store: DefaultsPushTokenStore(defaults: Settings.shared.storage),
            system: system
        )
    }()
}

extension InboxModel {
    static let shared = InboxModel(
        transport: MondropAPI(),
        sender: BackendClient(),
        badge: UNBadgeSetter(),
        announcer: InboxAnnouncer(
            store: DefaultsAnnouncedIDs(defaults: Settings.shared.storage),
            center: { SyncNotifier.shared.center },
            isEnabled: { Settings.shared.inboxNotificationsEnabled },
            // When the server rings this phone, the app does not announce the same thing a second time.
            pushActive: { PushRegistrar.shared.isActive }
        )
    )
}

/// A tap on a notification (push or local) asks for the Posta tab; a notification that arrives while the app is open
/// is shown as a banner.
@MainActor
final class NotificationRouter: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationRouter()

    /// Counts the taps: the root view opens the Posta when it grows.
    @Published private(set) var openInboxRequests = 0
    private(set) var lastTappedInboxId: String?
    private(set) var lastTappedEntryId: String?

    func install() {
        UNUserNotificationCenter.current().delegate = self
    }

    private func tapped(inboxId: String?, entryId: String?) {
        guard inboxId != nil || entryId != nil else { return }   // the «Sync finito» notification opens nothing special
        lastTappedInboxId = inboxId
        lastTappedEntryId = entryId
        openInboxRequests += 1
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let inboxId = notification.request.content.userInfo["inboxId"] as? String
        if let inboxId {
            // The system is showing it: remember that, and read the inbox so the list and the badge are current.
            Task { @MainActor in
                InboxModel.shared.markAnnounced(inboxId)
                await InboxModel.shared.refresh(.push)
            }
        }
        completionHandler([.banner, .sound, .badge])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let inboxId = info["inboxId"] as? String
        let entryId = info["entryId"] as? String
        Task { @MainActor in
            self.tapped(inboxId: inboxId, entryId: entryId)
            if let inboxId { InboxModel.shared.markAnnounced(inboxId) }
        }
        completionHandler()
    }
}

/// What the app does around the Posta, in one place: at launch and whenever it comes to the front.
@MainActor
enum InboxWiring {
    /// Idempotent. Before the first notification can arrive (also on a relaunch in the background).
    static func install() {
        NotificationRouter.shared.install()
    }

    /// Launch (`first`) and every time the app comes to the front.
    static func appBecameActive(first: Bool) async {
        if ShareLog.shared.hasEntries { await ensurePermissionIfNeeded() }
        await InboxModel.shared.refresh(first ? .launch : .foreground)
        await refreshPlaylistsCache()
        await reconcilePush()
    }

    /// The playlists the share sheet may offer: refreshed at every opening and every sync, so the sheet — which cannot
    /// wait for the network — always finds a list that is at most one opening old.
    static func refreshPlaylistsCache() async {
        guard let playlists = try? await MondropAPI().listPlaylists() else { return }
        PlaylistsCache.shared.store(playlists, user: Settings.shared.autheliaUsername)
    }

    /// The first time notifications are NEEDED — the Posta tab opened, the switch turned on, something shared from this
    /// phone — not at launch for nothing. iOS asks once; a refusal is respected and nothing breaks.
    static func ensurePermissionIfNeeded() async {
        guard let center = SyncNotifier.shared.center else { return }
        let permission = await center.permission()
        if SyncNotificationPolicy.shouldRequestPermission(enabled: Settings.shared.inboxNotificationsEnabled, permission: permission) {
            _ = await center.requestPermission()
        }
    }

    /// Push: ask for a token when the switch is on and notifications are allowed; tell the server «stop» when it is off.
    static func reconcilePush() async {
        let permission = await SyncNotifier.shared.center?.permission() ?? .notDetermined
        await PushRegistrar.shared.reconcile(enabled: Settings.shared.inboxNotificationsEnabled, permission: permission)
    }
}
