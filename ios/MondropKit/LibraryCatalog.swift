// LibraryCatalog.swift — the rules of «scegliere cosa suonare», on the phone.
//
// The server filters (GET /api/mondrop/library); when it cannot be reached, or the user asked for «solo sul
// telefono», the SAME rules run here over the songs that are on the device. They are a port of
// `backend/src/services/libraryFacets.ts`: free text with the words in any order, album / artist compared without
// case, accents and punctuation, the decade of the year, and facet counts where each heading ignores its own
// filter (picking a genre narrows the albums but keeps the other genres to switch to).
// Pure functions: no I/O, tested without a device.

import Foundation

public enum SearchText {
    /// No case, no accents, every run of non-letters/digits is one space: «Là Città!» → «la citta».
    public static func normalize(_ text: String) -> String {
        let folded = text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
        var out = ""
        var pendingSpace = false
        for character in folded {
            if character.isLetter || character.isNumber {
                if pendingSpace && !out.isEmpty { out.append(" ") }
                pendingSpace = false
                out.append(character)
            } else {
                pendingSpace = true
            }
        }
        return out
    }

    public static func tokens(_ text: String) -> [String] {
        normalize(text).split(separator: " ").map(String.init)
    }
}

public enum LibraryCatalog {
    /// A facet is never longer than this (a personal library is a few hundred albums).
    static let facetLimit = 2000

    public enum Heading: Sendable { case genre, album, artist, decade }

    // MARK: Filtering

    private static func same(_ a: String?, _ b: String?) -> Bool {
        SearchText.normalize(a ?? "") == SearchText.normalize(b ?? "")
    }

    /// The songs matching every filter, or every filter except `skipping` (what a heading counts over).
    /// Keeps the input order.
    public static func filter(_ songs: [OfflineTrack], _ f: LibraryFilters, skipping: Heading? = nil) -> [OfflineTrack] {
        let tokens = SearchText.tokens(f.q)
        let genre = f.genre.isBlank ? nil : f.genre
        let album = f.album.isBlank ? nil : f.album
        let artist = f.artist.isBlank ? nil : f.artist
        return songs.filter { song in
            if !tokens.isEmpty {
                let haystack = SearchText.normalize("\(song.artist) \(song.title) \(song.album ?? "")")
                guard tokens.allSatisfy({ haystack.contains($0) }) else { return false }
            }
            if let genre, skipping != .genre, !song.genres.contains(where: { same($0, genre) }) { return false }
            if let album, skipping != .album, !same(song.album, album) { return false }
            if let artist, skipping != .artist, !same(song.artist, artist) { return false }
            if let decade = f.decade, skipping != .decade, !decade.matches(year: song.year) { return false }
            return true
        }
    }

    /// Artist, then title: how a person looks for a song in a list.
    public static func sortedByArtistTitle(_ songs: [OfflineTrack]) -> [OfflineTrack] {
        let italian = Locale(identifier: "it")
        return songs.sorted { a, b in
            let byArtist = a.artist.compare(b.artist, locale: italian)
            if byArtist != .orderedSame { return byArtist == .orderedAscending }
            return a.title.compare(b.title, locale: italian) == .orderedAscending
        }
    }

    // MARK: Facets

    /// Counts songs per value; one value is spelt the way most of its songs spell it. Most songs first, then A to Z.
    private static func tally(_ songs: [OfflineTrack], valuesOf: (OfflineTrack) -> [String]) -> [LibraryFacetEntry] {
        struct Group {
            var spellings: [String: Int] = [:]
            var count = 0
        }
        var groups: [String: Group] = [:]
        for song in songs {
            var seenInThisSong = Set<String>()
            for raw in valuesOf(song) {
                let key = SearchText.normalize(raw)
                guard !key.isEmpty, seenInThisSong.insert(key).inserted else { continue }
                var group = groups[key] ?? Group()
                group.count += 1
                group.spellings[raw, default: 0] += 1
                groups[key] = group
            }
        }
        let italian = Locale(identifier: "it")
        let entries = groups.values.map { group -> LibraryFacetEntry in
            let label = group.spellings.sorted { a, b in
                if a.value != b.value { return a.value > b.value }
                return a.key.compare(b.key, locale: italian) == .orderedAscending
            }[0].key
            return LibraryFacetEntry(value: label, label: label, count: group.count)
        }
        return Array(entries.sorted { a, b in
            if a.count != b.count { return a.count > b.count }
            return a.label.compare(b.label, locale: italian) == .orderedAscending
        }.prefix(facetLimit))
    }

    private static func decadeEntries(_ songs: [OfflineTrack]) -> [LibraryFacetEntry] {
        var byDecade: [Int: Int] = [:]
        var withoutYear = 0
        for song in songs {
            switch DecadeFilter.of(year: song.year) {
            case .decade(let decade): byDecade[decade, default: 0] += 1
            case .noYear: withoutYear += 1
            }
        }
        var out = byDecade.keys.sorted().map { decade -> LibraryFacetEntry in
            let filter = DecadeFilter.decade(decade)
            return LibraryFacetEntry(value: filter.value, label: filter.label, count: byDecade[decade] ?? 0)
        }
        if withoutYear > 0 {
            out.append(LibraryFacetEntry(value: DecadeFilter.noYearValue, label: DecadeFilter.noYear.label, count: withoutYear))
        }
        return out
    }

    public static func facets(of songs: [OfflineTrack], filters f: LibraryFilters) -> LibraryFacets {
        LibraryFacets(
            genres: tally(filter(songs, f, skipping: .genre)) { $0.genres },
            albums: tally(filter(songs, f, skipping: .album)) { [$0.album ?? ""] },
            artists: tally(filter(songs, f, skipping: .artist)) { [$0.artist] },
            decades: decadeEntries(filter(songs, f, skipping: .decade))
        )
    }

    // MARK: Page

    /// What the server would answer, computed here: sorted by artist then title, one page, headings if asked.
    public static func page(
        of songs: [OfflineTrack], filters f: LibraryFilters,
        limit: Int = LibraryQuery.maxLimit, offset: Int = 0, withFacets: Bool = true
    ) -> LibraryPage {
        let matching = sortedByArtistTitle(filter(songs, f))
        let start = min(max(offset, 0), matching.count)
        let wanted = max(limit, 0)
        let end = wanted >= matching.count - start ? matching.count : start + wanted   // no overflow with a huge limit
        return LibraryPage(
            songs: Array(matching[start..<end]),
            total: matching.count,
            offset: start,
            limit: limit,
            facets: withFacets ? facets(of: songs, filters: f) : nil
        )
    }
}
