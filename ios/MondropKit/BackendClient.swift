// ios/MondropKit/BackendClient.swift

import Foundation

public struct ShareDeviceInfo: Codable {
    public let name: String?
    public let model: String?
    public let system: String?
    public let timeZone: String?

    public init(name: String? = nil, model: String? = nil, system: String? = nil, timeZone: String? = nil) {
        self.name = name
        self.model = model
        self.system = system
        self.timeZone = timeZone
    }
}

public struct ShareRequest: Codable {
    public let url: String
    public let comment: String?
    public let tags: [String]?
    public let channel: String
    public let user: String?
    public let sharedAt: String?
    public let device: ShareDeviceInfo?

    public init(
        url: String,
        comment: String? = nil,
        tags: [String]? = nil,
        channel: String = "ios",
        user: String? = nil,
        sharedAt: String? = nil,
        device: ShareDeviceInfo? = nil
    ) {
        self.url = url
        self.comment = comment
        self.tags = tags
        self.channel = channel
        self.user = user
        self.sharedAt = sharedAt
        self.device = device
    }
}

public struct ShareResponse: Codable {
    public let success: Bool
    public let entryId: String?
    public let tags: [String]?
    public let status: String?
    public let error: String?
}

public enum BackendError: Error, CustomStringConvertible {
    case badUrl
    case missingApiKey
    case missingUser
    case transport(Error)
    case http(Int, String?)
    case decode(Error)

    public var description: String {
        switch self {
        case .badUrl: return "URL del backend non valido"
        case .missingApiKey: return "API key mancante — aprila in Impostazioni Mondrop"
        case .missingUser: return "Utente Authelia mancante — sceglilo in Impostazioni"
        case .transport(let e): return "Errore di rete: \(e.localizedDescription)"
        case .http(let code, let body): return "HTTP \(code)\(body.map { ": \($0)" } ?? "")"
        case .decode(let e): return "Risposta non valida: \(e.localizedDescription)"
        }
    }
}

public actor BackendClient {
    public init() {}

    /// Fast share: stub + queue on the server (Share Extension friendly).
    public func share(url: String, comment: String?, tags: [String]?) async throws -> ShareResponse {
        let key = Settings.shared.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw BackendError.missingApiKey }

        let user = Settings.shared.autheliaUsername.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !user.isEmpty else { throw BackendError.missingUser }

        let base = Settings.shared.backendBaseUrl.trimmedTrailingSlash
        guard let endpoint = URL(string: "\(base)/api/share") else {
            throw BackendError.badUrl
        }

        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(key, forHTTPHeaderField: "X-SoundReel-Key")
        req.timeoutInterval = 25
        #if os(macOS)
        let channel = "macos"
        #else
        let channel = "ios"
        #endif

        let sharedAt = ISO8601DateFormatter.mondrop.string(from: Date())
        let device = ShareDeviceInfo(
            name: Settings.deviceDisplayName(),
            model: Settings.deviceModel(),
            system: Settings.systemVersion(),
            timeZone: TimeZone.current.identifier
        )

        req.httpBody = try JSONEncoder().encode(
            ShareRequest(
                url: url,
                comment: comment,
                tags: tags,
                channel: channel,
                user: user,
                sharedAt: sharedAt,
                device: device
            )
        )

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw BackendError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw BackendError.http(-1, nil)
        }
        let bodyText = String(data: data, encoding: .utf8)
        guard (200..<300).contains(http.statusCode) else {
            throw BackendError.http(http.statusCode, bodyText)
        }

        do {
            return try JSONDecoder().decode(ShareResponse.self, from: data)
        } catch {
            throw BackendError.decode(error)
        }
    }
}

private extension ISO8601DateFormatter {
    static let mondrop: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = TimeZone.current
        return f
    }()
}
