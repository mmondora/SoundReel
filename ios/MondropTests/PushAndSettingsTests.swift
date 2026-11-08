import XCTest
@testable import Mondrop

/// The push CLIENT: built, dormant until the signed app carries the entitlement and the server holds the APNs key.
@MainActor
final class PushRegistrarTests: XCTestCase {
    private struct Rig {
        let registrar: PushRegistrar
        let transport: FakePushTransport
        let system: FakePushSystem
        let store: MemoryPushTokenStore
        let clock: Time
    }

    private final class Time { var now = Date(timeIntervalSince1970: 1_794_000_000) }

    private func rig(token: String? = nil, postedAt: Date? = nil, environment: PushEnvironment = .development) -> Rig {
        let transport = FakePushTransport()
        let system = FakePushSystem()
        let store = MemoryPushTokenStore(token: token, postedAt: postedAt)
        let clock = Time()
        let registrar = PushRegistrar(transport: transport, store: store, environment: environment, system: system, now: { clock.now })
        return Rig(registrar: registrar, transport: transport, system: system, store: store, clock: clock)
    }

    private let bytes = Data([0x00, 0xAB, 0x0F, 0xFF, 0x10])

    // MARK: the token

    func testTheTokenGoesToTheServerAsLowercaseHex() {
        XCTAssertEqual(PushRegistrar.hex(bytes), "00ab0fff10")
        XCTAssertEqual(PushRegistrar.hex(Data()), "")
    }

    // MARK: asking iOS

    func testEnablingAsksIOSForAToken() {
        let r = rig()
        r.registrar.enable()
        XCTAssertEqual(r.system.registerCalls, 1)
        XCTAssertEqual(r.registrar.state, .waiting)
        XCTAssertFalse(r.registrar.isActive, "not active until the server has the token")
    }

    func testWithoutASystemItSaysPushIsNotAvailable() {
        let registrar = PushRegistrar(transport: FakePushTransport(), store: MemoryPushTokenStore(), system: nil)
        registrar.enable()
        XCTAssertEqual(registrar.state, .unavailable("push non disponibile qui"))
    }

    // MARK: success path

    func testATokenIsRegisteredWithTheServerAndRemembered() async {
        let r = rig(environment: .development)
        r.registrar.enable()
        await r.registrar.didRegister(deviceToken: bytes)
        XCTAssertEqual(r.transport.registered.map(\.token), ["00ab0fff10"])
        XCTAssertEqual(r.transport.registered.map(\.environment), [.development], "an Xcode build has a SANDBOX token")
        XCTAssertEqual(r.store.token, "00ab0fff10")
        XCTAssertEqual(r.store.postedAt, r.clock.now)
        XCTAssertEqual(r.registrar.state, .registered)
        XCTAssertTrue(r.registrar.isActive)
    }

    func testAProductionBuildSaysProduction() async {
        let r = rig(environment: .production)
        await r.registrar.didRegister(deviceToken: bytes)
        XCTAssertEqual(r.transport.registered.map(\.environment), [.production])
    }

    func testTheSameTokenIsNotPostedAgainEveryLaunch() async {
        let r = rig()
        await r.registrar.didRegister(deviceToken: bytes)
        r.clock.now = r.clock.now.addingTimeInterval(3600)
        await r.registrar.didRegister(deviceToken: bytes)
        XCTAssertEqual(r.transport.registered.count, 1)
        XCTAssertEqual(r.registrar.state, .registered)
        r.clock.now = r.clock.now.addingTimeInterval(PushRegistrar.repostAfter)
        await r.registrar.didRegister(deviceToken: bytes)
        XCTAssertEqual(r.transport.registered.count, 2, "a day later it is posted again, in case the server lost it")
    }

    func testANewTokenIsPostedAtOnce() async {
        let r = rig()
        await r.registrar.didRegister(deviceToken: bytes)
        await r.registrar.didRegister(deviceToken: Data([0x01, 0x02]))
        XCTAssertEqual(r.transport.registered.map(\.token), ["00ab0fff10", "0102"])
        XCTAssertEqual(r.store.token, "0102")
    }

    // MARK: failure paths

    func testIOSRefusingPushLeavesItOffWithoutBotheringTheServer() async {
        let r = rig()
        r.registrar.enable()
        let noEntitlement = NSError(domain: NSCocoaErrorDomain, code: 3000, userInfo: [NSLocalizedDescriptionKey: "no valid 'aps-environment' entitlement string found for application"])
        r.registrar.didFail(error: noEntitlement)
        XCTAssertEqual(r.registrar.state, .unavailable("questa build non ha il permesso di ricevere push"))
        XCTAssertFalse(r.registrar.isActive)
        XCTAssertTrue(r.transport.registered.isEmpty)
        XCTAssertNil(r.store.token)
    }

    func testAnyOtherFailureIsExplainedInItsOwnWords() {
        let r = rig()
        r.registrar.didFail(error: NSError(domain: "x", code: 1, userInfo: [NSLocalizedDescriptionKey: "no network"]))
        XCTAssertEqual(r.registrar.state, .unavailable("no network"))
    }

    func testAServerThatDoesNotTakeTheTokenIsRetriedNextLaunch() async {
        let r = rig()
        r.transport.fail(true)
        await r.registrar.didRegister(deviceToken: bytes)
        guard case .unavailable = r.registrar.state else { return XCTFail("\(r.registrar.state)") }
        XCTAssertNil(r.store.token, "not remembered: the next launch posts it again")
        r.transport.fail(false)
        await r.registrar.didRegister(deviceToken: bytes)
        XCTAssertEqual(r.registrar.state, .registered)
    }

    func testAFailureThenASuccessIsFine() async {
        let r = rig()
        r.registrar.didFail(error: NSError(domain: NSCocoaErrorDomain, code: 3000))
        await r.registrar.didRegister(deviceToken: bytes)
        XCTAssertEqual(r.registrar.state, .registered)
    }

    // MARK: switching it off

    func testTurningTheSwitchOffTellsTheServerAndForgetsTheToken() async {
        let r = rig()
        await r.registrar.didRegister(deviceToken: bytes)
        await r.registrar.disable()
        XCTAssertEqual(r.transport.unregistered, ["00ab0fff10"])
        XCTAssertNil(r.store.token)
        XCTAssertEqual(r.registrar.state, .off)
        XCTAssertEqual(r.system.unregisterCalls, 1)
    }

    func testTurningItOffWithNoTokenSaysNothingToTheServer() async {
        let r = rig()
        await r.registrar.disable()
        XCTAssertTrue(r.transport.unregistered.isEmpty)
        XCTAssertEqual(r.registrar.state, .off)
    }

    func testAnOffThatCouldNotReachTheServerIsRetriedLater() async {
        let r = rig(token: "abc", postedAt: Date())
        r.transport.fail(true)
        await r.registrar.disable()
        XCTAssertEqual(r.store.token, "abc", "kept: otherwise the server would keep ringing a phone that said stop")
        XCTAssertEqual(r.registrar.state, .off)
        r.transport.fail(false)
        await r.registrar.reconcile(enabled: false, permission: .allowed)
        XCTAssertEqual(r.transport.unregistered, ["abc"])
        XCTAssertNil(r.store.token)
    }

    // MARK: reconcile (launch / foreground / settings change)

    func testSwitchOnAndAllowedAsksForAToken() async {
        let r = rig()
        await r.registrar.reconcile(enabled: true, permission: .allowed)
        XCTAssertEqual(r.system.registerCalls, 1)
        XCTAssertEqual(r.registrar.state, .waiting)
    }

    func testSwitchOnButNotAllowedDoesNothing() async {
        for permission in [NotificationPermission.denied, .notDetermined] {
            let r = rig()
            await r.registrar.reconcile(enabled: true, permission: permission)
            XCTAssertEqual(r.system.registerCalls, 0)
            XCTAssertEqual(r.registrar.state, .off)
        }
    }

    func testSwitchOffNeverAsksForAToken() async {
        let r = rig()
        await r.registrar.reconcile(enabled: false, permission: .allowed)
        XCTAssertEqual(r.system.registerCalls, 0)
        XCTAssertEqual(r.registrar.state, .off)
    }

    func testAlreadyRegisteredStaysRegisteredWhileTheTokenIsRefreshed() async {
        let r = rig()
        await r.registrar.didRegister(deviceToken: bytes)
        await r.registrar.reconcile(enabled: true, permission: .allowed)
        XCTAssertEqual(r.registrar.state, .registered, "asking for the token again does not make push look off")
        XCTAssertEqual(r.system.registerCalls, 1)
    }

    // MARK: where the token lives

    func testTheTokenSurvivesInTheDefaults() {
        let suite = UserDefaults(suiteName: "push-test-\(UUID().uuidString)")!
        let store = DefaultsPushTokenStore(defaults: suite)
        XCTAssertNil(store.token)
        store.token = "abc"
        store.postedAt = Date(timeIntervalSince1970: 100)
        XCTAssertEqual(DefaultsPushTokenStore(defaults: suite).token, "abc")
        XCTAssertEqual(DefaultsPushTokenStore(defaults: suite).postedAt, Date(timeIntervalSince1970: 100))
        store.token = nil
        XCTAssertNil(store.token)
    }

    func testTheEnvironmentOfADebugBuildIsDevelopment() {
        #if DEBUG
        XCTAssertEqual(PushEnvironment.current, .development)
        #else
        XCTAssertEqual(PushEnvironment.current, .production)
        #endif
    }
}

/// The new settings (IN7) and the stores that keep what the sheet and the inbox remember.
final class InboxSettingsTests: XCTestCase {
    func testTheAnnouncedIdsLiveInTheDefaults() {
        let suite = UserDefaults(suiteName: "announced-test-\(UUID().uuidString)")!
        let store = DefaultsAnnouncedIDs(defaults: suite)
        XCTAssertEqual(store.ids, [])
        store.ids = ["a", "b"]
        XCTAssertEqual(DefaultsAnnouncedIDs(defaults: suite).ids, ["a", "b"])
    }

    #if targetEnvironment(simulator)
    private let keys = ["inboxNotificationsEnabled", "defaultShareWith", "autheliaUsername"]
    private var saved: [String: Any?] = [:]

    override func setUp() {
        super.setUp()
        saved = Dictionary(uniqueKeysWithValues: keys.map { ($0, UserDefaults.standard.object(forKey: $0)) })
    }

    override func tearDown() {
        for (key, value) in saved {
            if let value { UserDefaults.standard.set(value, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
        }
        super.tearDown()
    }

    func testNotificationsOfTheSharesAreOnUntilSwitchedOff() {
        UserDefaults.standard.removeObject(forKey: "inboxNotificationsEnabled")
        XCTAssertTrue(Settings.shared.inboxNotificationsEnabled, "default ON — a missing key must not read as OFF")
        Settings.shared.inboxNotificationsEnabled = false
        XCTAssertFalse(Settings.shared.inboxNotificationsEnabled)
        Settings.shared.inboxNotificationsEnabled = true
        XCTAssertTrue(Settings.shared.inboxNotificationsEnabled)
    }

    func testShareWithNobodyByDefault() {
        UserDefaults.standard.removeObject(forKey: "defaultShareWith")
        XCTAssertEqual(Settings.shared.defaultShareWith, [])
    }

    func testTheDefaultRecipientsAreKeptCleanAndNeverIncludeThePhonesOwnUser() {
        Settings.shared.autheliaUsername = "mike"
        Settings.shared.defaultShareWith = ["sara", "mike", "ghost", "archi", "sara"]
        XCTAssertEqual(Settings.shared.defaultShareWith, ["archi", "sara"])
        Settings.shared.autheliaUsername = "sara"
        XCTAssertEqual(Settings.shared.defaultShareWith, ["archi"], "if this phone becomes sara's, sara is no longer a recipient")
    }
    #endif
}
