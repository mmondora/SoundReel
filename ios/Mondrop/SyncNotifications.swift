// SyncNotifications.swift — plugs the real system pieces into the «Sync finito» notification.
//
// What to say and when is pure code in MondropKit (SyncNotificationPolicy); here live the two things that need the
// system: UNUserNotificationCenter, and whether the user is looking at the app (UIKit / AppKit, which MondropKit —
// compiled into the share extension too — cannot link).

import SwiftUI
import UserNotifications
#if os(iOS)
import UIKit
#endif
#if os(macOS)
import AppKit
#endif

struct UNSyncNotificationCenter: SyncNotificationCenter {
    private static let identifier = "mondrop.sync.finished"

    func permission() async -> NotificationPermission {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined: return .notDetermined
        case .denied: return .denied
        default: return .allowed        // authorized, provisional, ephemeral
        }
    }

    func requestPermission() async -> Bool {
        // `.badge` is the number on the app icon (the Posta's unread count). iOS fixes the options at the FIRST request:
        // an install that already answered with alert + sound only keeps them (see ios/README.md).
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    func post(_ content: SyncNotificationContent) async {
        let body = UNMutableNotificationContent()
        body.title = content.title
        body.body = content.body
        body.sound = .default
        if !content.userInfo.isEmpty { body.userInfo = content.userInfo }
        if let badge = content.badge { body.badge = NSNumber(value: badge) }
        // «Sync finito» uses one fixed identifier: a new one replaces the previous instead of piling up. The Posta's
        // notifications carry their own (one per inbox item), so a tap and a dedupe can find them.
        let request = UNNotificationRequest(identifier: content.identifier ?? Self.identifier, content: body, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}

@MainActor
enum SyncNotifications {
    /// Idempotent. Called at launch and when iOS relaunches the app in the background to deliver the last download —
    /// that is exactly when the notification has to be ready.
    static func install() {
        let notifier = SyncNotifier.shared
        guard notifier.center == nil else { return }
        notifier.center = UNSyncNotificationCenter()
        notifier.isEnabled = { Settings.shared.syncNotificationsEnabled }
        notifier.isAppActive = { appIsActive() }
        notifier.stillPreparing = { SyncActivity.shared.preparingCount() }
        #if os(iOS)
        notifier.backgroundRunner = UIKitBackgroundTaskRunner()
        #endif
        SyncEngine.shared.onBatchFinished = { summary in
            Task {
                await SyncNotifier.shared.syncFinished(summary)
                // A sync is also a good moment to look at the Posta (and the playlists the share sheet offers).
                await InboxModel.shared.refresh(.sync)
                await InboxWiring.refreshPlaylistsCache()
            }
        }
        InboxWiring.install()
    }

    static func appIsActive() -> Bool {
        #if os(iOS)
        return UIApplication.shared.applicationState == .active
        #else
        return NSApplication.shared.isActive
        #endif
    }
}
