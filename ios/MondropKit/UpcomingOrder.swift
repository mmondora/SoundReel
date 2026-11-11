// UpcomingOrder.swift — in which order the songs are downloaded (Michele, 11 November, after trying build 17: «Sync scarica i brani in ordine di stanno per suonare.»;
// spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U16, ADR-0030).
//
// Pure. The player knows what is about to play (its queue and where it is in it); the sync has songs to bring down. A song that is about to be heard is worth more
// than one that will be heard in an hour, so what waits goes down in the order the songs will play: the one that plays now, the ones after it and — round the loop —
// the ones before it. Nothing here touches the player, the engine or the phone.

import Foundation

public enum UpcomingOrder {
    /// The queue in the order it is about to play: from the song at `index` to the end, then round again from the first. A song that is twice in the queue counts
    /// where it comes first. An `index` outside the queue is the first song.
    public static func keys(queue: [String], index: Int) -> [String] {
        guard !queue.isEmpty else { return [] }
        let start = queue.indices.contains(index) ? index : 0
        var seen = Set<String>()
        var order: [String] = []
        order.reserveCapacity(queue.count)
        for step in 0..<queue.count {
            let key = queue[(start + step) % queue.count]
            if seen.insert(key).inserted { order.append(key) }
        }
        return order
    }

    /// `items` in the order they go down: the ones the user asked for by name (`pinned`) first, then the ones whose song is named in `upcoming`, in the order of
    /// `upcoming`, then all the others, as they were. Nothing is added or lost; two items of one song keep the order they had.
    public static func arrange<Item>(
        _ items: [Item], songKey: (Item) -> String, pinned: (Item) -> Bool = { _ in false }, upcoming: [String]
    ) -> [Item] {
        guard !items.isEmpty else { return items }
        var place: [String: Int] = [:]
        for (position, key) in upcoming.enumerated() where place[key] == nil { place[key] = position }
        // (group, place in the order, place it had): the last one makes the sort stable, and the result the same every time
        let ranked = items.enumerated().map { offset, item -> (group: Int, place: Int, offset: Int) in
            if pinned(item) { return (0, 0, offset) }
            if let position = place[songKey(item)] { return (1, position, offset) }
            return (2, 0, offset)
        }
        return ranked.sorted { ($0.group, $0.place, $0.offset) < ($1.group, $1.place, $1.offset) }.map { items[$0.offset] }
    }
}
