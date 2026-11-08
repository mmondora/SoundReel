// NetStatus.swift — "Rete: casa / internet" from GET /api/mondrop/net, reset when the network changes.
//
// INFORMATION for the Settings row, nothing else. Sync and play must never read it to choose where a file comes from:
// the app talks to SoundReel only, whatever the network is (rule P, ADR-0018; Mondrop/RulePTests guards it).

import Foundation
import Network

@MainActor
public final class NetStatus: ObservableObject {
    public static let shared = NetStatus(monitorPath: true)

    @Published public private(set) var info: NetInfo?
    @Published public private(set) var checkedAt: Date?
    @Published public private(set) var lastError: String?
    @Published public private(set) var checking = false
    /// Cellular or a personal hotspot: Wi-Fi-only downloads wait while this is true.
    @Published public private(set) var onExpensivePath = false

    private let now: () -> Date
    private var monitor: NWPathMonitor?

    public init(monitorPath: Bool = false, now: @escaping () -> Date = { Date() }) {
        self.now = now
        if monitorPath {
            let monitor = NWPathMonitor()
            monitor.pathUpdateHandler = { [weak self] path in
                let expensive = path.isExpensive
                Task { @MainActor in
                    self?.onExpensivePath = expensive
                    self?.invalidate()   // Wi-Fi ↔ cellular ↔ other Wi-Fi: the answer may have changed
                }
            }
            monitor.start(queue: DispatchQueue(label: "it.mikesoft.mondrop.netstatus", qos: .utility))
            self.monitor = monitor
        }
    }

    /// For the Settings row.
    public var label: String {
        switch info?.home {
        case true?: return "casa"
        case false?: return "internet"
        case nil: return "sconosciuta"
        }
    }

    public func invalidate() {
        checkedAt = nil
    }

    public func refresh(api: MondropAPIProtocol) async {
        checking = true
        defer { checking = false }
        do {
            info = try await api.net()
            checkedAt = now()
            lastError = nil
        } catch {
            info = nil
            checkedAt = nil
            lastError = (error as? MondropAPIError)?.description ?? error.localizedDescription
        }
    }
}

public enum WifiHint {
    /// Background downloads on a metered network with cellular switched off do not fail, they WAIT for Wi-Fi:
    /// without a hint the rows look stuck at "scarico…".
    public static func isWaitingForWifi(onExpensivePath: Bool, allowCellular: Bool, activeDownloads: Int) -> Bool {
        !allowCellular && onExpensivePath && activeDownloads > 0
    }
}
