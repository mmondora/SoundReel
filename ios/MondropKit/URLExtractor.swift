// ios/SoundReelKit/URLExtractor.swift

import Foundation
import UniformTypeIdentifiers

public enum URLExtractor {
    /// Returns the first http(s) URL found among the supplied item providers,
    /// either as a direct URL attachment or extracted from a text attachment.
    public static func firstURL(from itemProviders: [NSItemProvider]) async -> URL? {
        for provider in itemProviders {
            if let url = await loadDirectURL(provider) {
                if let normalized = normalize(url) { return normalized }
            }
            if let text = await loadText(provider), let url = extractFirstURL(in: text) {
                if let normalized = normalize(url) { return normalized }
            }
        }
        return nil
    }

    private static func loadDirectURL(_ provider: NSItemProvider) async -> URL? {
        guard provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) else { return nil }
        return await withCheckedContinuation { cont in
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                if let url = item as? URL {
                    cont.resume(returning: url)
                } else if let data = item as? Data, let url = URL(dataRepresentation: data, relativeTo: nil) {
                    cont.resume(returning: url)
                } else {
                    cont.resume(returning: nil)
                }
            }
        }
    }

    private static func loadText(_ provider: NSItemProvider) async -> String? {
        guard provider.hasItemConformingToTypeIdentifier(UTType.text.identifier) else { return nil }
        return await withCheckedContinuation { cont in
            provider.loadItem(forTypeIdentifier: UTType.text.identifier, options: nil) { item, _ in
                cont.resume(returning: (item as? String))
            }
        }
    }

    private static func extractFirstURL(in text: String) -> URL? {
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        let range = NSRange(text.startIndex..., in: text)
        return detector?.firstMatch(in: text, options: [], range: range)?.url
    }

    private static func normalize(_ url: URL) -> URL? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return nil
        }
        return url
    }
}
