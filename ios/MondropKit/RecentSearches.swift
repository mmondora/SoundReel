// RecentSearches.swift — «Ricerche recenti»: the last things looked for, kept on THIS phone (they are a convenience of
// the screen, not data of the family: nothing is sent anywhere). Pure value + a thin UserDefaults store.

import Foundation

public struct RecentSearches: Equatable, Sendable {
    public static let maxCount = 10
    /// A single letter is a slip of the finger, not a search worth remembering.
    public static let minLength = 2

    /// Newest first.
    public private(set) var items: [String]

    public init(items: [String] = []) {
        self.items = []
        for item in items.reversed() { record(item) }   // keeps the order, the cap and the one-per-text rule
        self.items = Array(self.items.prefix(Self.maxCount))
    }

    private static func key(_ text: String) -> String { SearchText.normalize(text) }

    /// Remembers `text` as the newest; an earlier one that reads the same (case, accents, punctuation aside) goes away.
    public mutating func record(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = Self.key(trimmed)
        guard key.count >= Self.minLength else { return }
        items.removeAll { Self.key($0) == key }
        items.insert(trimmed, at: 0)
        if items.count > Self.maxCount { items.removeLast(items.count - Self.maxCount) }
    }

    public mutating func remove(_ text: String) {
        let key = Self.key(text)
        items.removeAll { Self.key($0) == key }
    }

    public mutating func clear() { items = [] }

    public var isEmpty: Bool { items.isEmpty }
}

/// Where the recent searches live on the phone. `UserDefaults` is injected so tests use their own suite.
public struct RecentSearchesStore: @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "mondrop.recentSearches") {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> RecentSearches {
        RecentSearches(items: defaults.stringArray(forKey: key) ?? [])
    }

    public func save(_ searches: RecentSearches) {
        defaults.set(searches.items, forKey: key)
    }
}
