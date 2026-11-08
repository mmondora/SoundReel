// PushRegistration.swift — the push CLIENT (ADR-0015 option A), built but DORMANT: the app asks iOS for a device token
// once notifications are allowed and the switch is on, and tells the server which token to ring. Until the signed app
// carries the `aps-environment` entitlement (and the server holds the APNs key) iOS answers «no» and push simply stays
// off — the Posta tab and the local notifications do not depend on it. See ios/README.md for the one step that wakes it.

import Foundation

public enum PushState: Equatable, Sendable {
    /// The switch is off, or notifications are not allowed: nothing asked.
    case off
    /// Asked iOS for a token, no answer yet.
    case waiting
    /// The server has this phone's token.
    case registered
    /// Push cannot work here (this build has no push entitlement, no network…); the reason, in words.
    case unavailable(String)
}

/// `UIApplication.registerForRemoteNotifications()` — UIKit, so the app plugs it in.
@MainActor
public protocol PushSystem: AnyObject {
    func registerForRemoteNotifications()
    func unregisterForRemoteNotifications()
}

/// The token last given to the server, and when: kept so «off» can still tell the server after a relaunch, and so a
/// launch does not post the same token again and again.
public protocol PushTokenStore: AnyObject {
    var token: String? { get set }
    var postedAt: Date? { get set }
}

public final class MemoryPushTokenStore: PushTokenStore {
    public var token: String?
    public var postedAt: Date?
    public init(token: String? = nil, postedAt: Date? = nil) {
        self.token = token
        self.postedAt = postedAt
    }
}

public final class DefaultsPushTokenStore: PushTokenStore {
    private let defaults: UserDefaults
    public init(defaults: UserDefaults) { self.defaults = defaults }

    public var token: String? {
        get { defaults.string(forKey: "pushToken") }
        set { if let newValue { defaults.set(newValue, forKey: "pushToken") } else { defaults.removeObject(forKey: "pushToken") } }
    }

    public var postedAt: Date? {
        get { defaults.object(forKey: "pushTokenPostedAt") as? Date }
        set { if let newValue { defaults.set(newValue, forKey: "pushTokenPostedAt") } else { defaults.removeObject(forKey: "pushTokenPostedAt") } }
    }
}

@MainActor
public final class PushRegistrar: ObservableObject {
    /// The same token is not posted again within this time.
    public static let repostAfter: TimeInterval = 24 * 3600

    @Published public private(set) var state: PushState = .off

    private let transport: PushTransport
    private let store: PushTokenStore
    private let environment: PushEnvironment
    private let now: () -> Date
    /// Plugged in by the app (UIKit). nil in tests of the logic.
    public weak var system: PushSystem?

    public init(
        transport: PushTransport,
        store: PushTokenStore,
        environment: PushEnvironment = .current,
        system: PushSystem? = nil,
        now: @escaping () -> Date = { Date() }
    ) {
        self.transport = transport
        self.store = store
        self.environment = environment
        self.system = system
        self.now = now
    }

    /// The server has a token for this phone: the push rings, so the app does not announce the same thing locally.
    public var isActive: Bool { state == .registered }

    /// iOS gives the token as bytes; the server wants hex.
    public static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// Called at launch, when the app comes to the front, and when the switch or the permission changes.
    public func reconcile(enabled: Bool, permission: NotificationPermission) async {
        if enabled, permission == .allowed {
            enable()
        } else if !enabled, store.token != nil {
            await disable()
        } else {
            state = .off
        }
    }

    /// Notifications are allowed and the switch is on: ask iOS for a token (it answers through `didRegister` or `didFail`).
    public func enable() {
        guard let system else {
            state = .unavailable("push non disponibile qui")
            return
        }
        if state != .registered { state = .waiting }
        system.registerForRemoteNotifications()
    }

    /// iOS gave a token.
    public func didRegister(deviceToken: Data) async {
        let hex = Self.hex(deviceToken)
        let at = now()
        if store.token == hex, let posted = store.postedAt, at.timeIntervalSince(posted) < Self.repostAfter {
            state = .registered           // the server already has it
            return
        }
        do {
            try await transport.registerPushDevice(token: hex, environment: environment)
            store.token = hex
            store.postedAt = at
            state = .registered
        } catch {
            // The token is real but the server did not take it (offline…): the next launch tries again.
            state = .unavailable("il server non ha registrato questo telefono")
        }
    }

    /// iOS refused: this build is not allowed push (no entitlement, simulator…). Not an error for the user — the
    /// Posta tab works without it.
    public func didFail(error: Error) {
        state = .unavailable(Self.explain(error))
    }

    /// The switch was turned off: tell the server to stop ringing this phone, and forget the token.
    public func disable() async {
        system?.unregisterForRemoteNotifications()
        guard let token = store.token else {
            state = .off
            return
        }
        do {
            try await transport.unregisterPushDevice(token: token)
            store.token = nil
            store.postedAt = nil
        } catch {
            // keep the token: the next launch with the switch off tries again, so the server does not keep ringing
        }
        state = .off
    }

    static func explain(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == NSCocoaErrorDomain, ns.code == 3000 {
            return "questa build non ha il permesso di ricevere push"
        }
        return ns.localizedDescription
    }
}
