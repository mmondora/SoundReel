// ios/SoundReelKit/BackendClient.swift

import Foundation

public struct AnalyzeRequest: Codable {
    public let url: String
    public let channel: String
}

public struct AnalyzeResponse: Codable {
    public let success: Bool
    public let entryId: String?
    public let error: String?
}

public enum BackendError: Error, CustomStringConvertible {
    case badUrl
    case transport(Error)
    case http(Int)
    case decode(Error)

    public var description: String {
        switch self {
        case .badUrl: return "URL del backend non valido"
        case .transport(let e): return "Errore di rete: \(e.localizedDescription)"
        case .http(let code): return "HTTP \(code)"
        case .decode(let e): return "Risposta non valida: \(e.localizedDescription)"
        }
    }
}

public actor BackendClient {
    public init() {}

    public func analyze(url: String) async throws -> AnalyzeResponse {
        let base = Settings.shared.backendBaseUrl.trimmedTrailingSlash
        guard let endpoint = URL(string: "\(base)/api/analyze") else {
            throw BackendError.badUrl
        }

        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 30
        req.httpBody = try JSONEncoder().encode(AnalyzeRequest(url: url, channel: "ios"))

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw BackendError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw BackendError.http(-1)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw BackendError.http(http.statusCode)
        }

        do {
            return try JSONDecoder().decode(AnalyzeResponse.self, from: data)
        } catch {
            throw BackendError.decode(error)
        }
    }
}
