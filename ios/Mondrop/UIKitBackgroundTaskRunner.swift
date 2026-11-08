// UIKitBackgroundTaskRunner.swift — iOS only: `beginBackgroundTask` for the upload that runs when the app goes to
// background. MondropKit (also compiled into the share extension) only knows the protocol.

#if os(iOS)
import UIKit

struct UIKitBackgroundTaskRunner: BackgroundTaskRunner {
    /// Ends the task exactly once, whether the work finished or iOS said time is up.
    @MainActor
    private final class Token {
        private var identifier = UIBackgroundTaskIdentifier.invalid

        init(name: String) {
            identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
                // Time is up: end the task or iOS terminates the app. Nothing is lost — events leave the queue
                // only after the server answered 200.
                self?.end()
            }
        }

        func end() {
            guard identifier != .invalid else { return }
            UIApplication.shared.endBackgroundTask(identifier)
            identifier = .invalid
        }
    }

    func run(name: String, _ work: @escaping @Sendable () async -> Void) async {
        let token = await MainActor.run { Token(name: name) }
        await work()
        await MainActor.run { token.end() }
    }
}
#endif
