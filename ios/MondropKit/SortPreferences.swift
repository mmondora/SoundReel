// SortPreferences.swift — the sort the person chose last, kept between launches (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md §12, U17 and U18): one
// for the list of playlists and one for the songs inside a playlist. Anything unreadable is the first choice of the menu, «Stato» with the phone first: what the screens did
// before there was a choice.

import Foundation

public final class SortPreferences {
    public static let playlistSortKey = "sort.playlists.sort"
    public static let playlistOrderKey = "sort.playlists.order"
    public static let songSortKey = "sort.songs.sort"
    public static let songOrderKey = "sort.songs.order"

    private let defaults: UserDefaults

    public init(defaults: UserDefaults) { self.defaults = defaults }

    /// The list of playlists.
    public var playlists: (sort: PlaylistSort, order: PlaylistOrder) {
        get {
            let sort = defaults.string(forKey: Self.playlistSortKey).flatMap(PlaylistSort.init(rawValue:)) ?? .state
            let order = defaults.string(forKey: Self.playlistOrderKey).flatMap(PlaylistOrder.init(rawValue:)) ?? sort.naturalOrder
            return (sort, order)
        }
        set {
            defaults.set(newValue.sort.rawValue, forKey: Self.playlistSortKey)
            defaults.set(newValue.order.rawValue, forKey: Self.playlistOrderKey)
        }
    }

    /// The songs inside a playlist.
    public var songs: (sort: SongSort, order: PlaylistOrder) {
        get {
            let sort = defaults.string(forKey: Self.songSortKey).flatMap(SongSort.init(rawValue:)) ?? .state
            let order = defaults.string(forKey: Self.songOrderKey).flatMap(PlaylistOrder.init(rawValue:)) ?? sort.naturalOrder
            return (sort, order)
        }
        set {
            defaults.set(newValue.sort.rawValue, forKey: Self.songSortKey)
            defaults.set(newValue.order.rawValue, forKey: Self.songOrderKey)
        }
    }
}
