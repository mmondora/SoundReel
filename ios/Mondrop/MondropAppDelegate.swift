// MondropAppDelegate.swift — iOS only: relaunch hook for background downloads.

#if os(iOS)
import UIKit

final class MondropAppDelegate: NSObject, UIApplicationDelegate {
    /// The notification delegate must exist before the app finishes launching, or a tap that launched the app is lost.
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        MainActor.assumeIsolated { InboxWiring.install() }
        return true
    }

    /// Push (dormant until the signed app carries `aps-environment`, see ios/README.md): iOS gave a device token…
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in await PushRegistrar.shared.didRegister(deviceToken: deviceToken) }
    }

    /// …or refused (no entitlement, simulator, no network). Push simply stays off: the Posta works without it.
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in PushRegistrar.shared.didFail(error: error) }
    }

    /// iOS relaunches the app (possibly in the background) to deliver the results of the background session.
    /// The completion handler must be called once the session has delivered its events: the transport does it
    /// in `urlSessionDidFinishEvents`. Touching the engine recreates the session, which is what makes the
    /// pending events flow in the first place.
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier == BackgroundDownloadTransport.sessionIdentifier else {
            completionHandler()
            return
        }
        BackgroundDownloadTransport.shared.setBackgroundCompletion(completionHandler)
        Task { @MainActor in
            // Before the engine sees the downloads that finished while the app was away: if one of them is the last
            // of the sync, «Sync finito» is posted from here.
            SyncNotifications.install()
            await SyncEngine.shared.attachExisting()
        }
    }

    /// Best effort: iOS does not always call this. The play journal (checkpointed every ~10 s) covers a plain kill.
    func applicationWillTerminate(_ application: UIApplication) {
        MainActor.assumeIsolated {
            PlayRecorder.shared.applicationWillTerminate()
        }
    }
}
#endif
