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
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
    }

    func post(_ content: SyncNotificationContent) async {
        let body = UNMutableNotificationContent()
        body.title = content.title
        body.body = content.body
        body.sound = .default
        // One fixed identifier: a new «Sync finito» replaces the previous one instead of piling up.
        let request = UNNotificationRequest(identifier: Self.identifier, content: body, trigger: nil)
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
            Task { await SyncNotifier.shared.syncFinished(summary) }
        }
    }

    static func appIsActive() -> Bool {
        #if os(iOS)
        return UIApplication.shared.applicationState == .active
        #else
        return NSApplication.shared.isActive
        #endif
    }
}
