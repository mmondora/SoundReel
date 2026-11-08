// MondropAppDelegate.swift — iOS only: relaunch hook for background downloads.

#if os(iOS)
import UIKit

final class MondropAppDelegate: NSObject, UIApplicationDelegate {
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
