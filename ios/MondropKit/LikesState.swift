// LikesState.swift — the like, as plain data (docs/mondrop-likes.md, spec 2026-11-10-mondrop-like-and-repeat-design.md L1, L3).
//
// A like belongs to a PERSON and lives on the server. The phone keeps two things: the set the server last told it, and, on top of it, the
// operations it has not told the server yet (a like given in a tunnel, with no network). What the heart shows is the server's set with
// those applied, so it never waits for the network. The rules (a like and an unlike of the same song that have not left cancel out; the
// server's set is the truth whenever it arrives; the one that is being sent is answered, never taken back) are here, with no files, no
// network and no clock: `LikesStore` keeps the file and does the talking.

import Foundation

/// One thing the user did that the server has not heard yet.
public struct LikeOperation: Codable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        case like, unlike
    }

    /// Its own, so that «the one that was sent» is never confused with another that says the same.
    public let id: String
    public let kind: Kind
    public let songKey: String
    /// When the user did it, on the phone: it travels with the like (a like given in a tunnel is from the tunnel).
    public let at: Date

    public init(id: String = UUID().uuidString, kind: Kind, songKey: String, at: Date) {
        self.id = id
        self.kind = kind
        self.songKey = songKey
        self.at = at
    }
}

public struct LikesState: Codable, Equatable, Sendable {
    /// Whose likes these are (the user of the key). Another person on the same phone starts from nothing.
    public private(set) var owner: String
    /// The set as the server last said it.
    public private(set) var serverKeys: Set<String>
    /// What has not been told yet, oldest first.
    public private(set) var pending: [LikeOperation]
    /// The operation whose call is in the air. Not kept in the file: after a restart it is simply sent again (the routes are idempotent).
    public private(set) var inFlight: LikeOperation?

    public init(owner: String = "", serverKeys: Set<String> = [], pending: [LikeOperation] = []) {
        self.owner = owner
        self.serverKeys = serverKeys
        self.pending = pending
        self.inFlight = nil
    }

    // MARK: what the heart shows

    /// The server's set with what is waiting applied on top: the last thing the user did to the song wins.
    public func isLiked(_ songKey: String) -> Bool {
        if let last = pending.last(where: { $0.songKey == songKey }) { return last.kind == .like }
        return serverKeys.contains(songKey)
    }

    /// Every song the heart shows full.
    public var likedKeys: Set<String> {
        var keys = serverKeys
        for op in pending {
            if op.kind == .like { keys.insert(op.songKey) } else { keys.remove(op.songKey) }
        }
        return keys
    }

    // MARK: what the user does

    /// The user likes or unlikes a song. Asking for what already is changes nothing (`false`). A like and an unlike of the same song that have
    /// not left the phone cancel out: the server never needs to hear of either. The operation that is being sent cannot be taken back: the
    /// opposite is queued after it.
    @discardableResult
    public mutating func setLiked(_ liked: Bool, songKey: String, at: Date) -> Bool {
        guard isLiked(songKey) != liked else { return false }
        if let last = pending.lastIndex(where: { $0.songKey == songKey }), pending[last].id != inFlight?.id {
            pending.remove(at: last)
        } else {
            pending.append(LikeOperation(kind: liked ? .like : .unlike, songKey: songKey, at: at))
        }
        return true
    }

    // MARK: the sending

    /// The oldest operation, marked as being sent; nil when there is none or one is already on its way (one at a time, in order).
    public mutating func beginSending() -> LikeOperation? {
        guard inFlight == nil, let first = pending.first else { return nil }
        inFlight = first
        return first
    }

    /// The server took it: it leaves the queue and the server's set follows.
    public mutating func settle(_ op: LikeOperation) {
        guard let index = pending.firstIndex(where: { $0.id == op.id }) else { return }
        pending.remove(at: index)
        if op.kind == .like { serverKeys.insert(op.songKey) } else { serverKeys.remove(op.songKey) }
        if inFlight?.id == op.id { inFlight = nil }
    }

    /// The server refused it for good (a key it cannot take): it leaves the queue and the heart goes back to what the server has.
    public mutating func drop(_ op: LikeOperation) {
        pending.removeAll { $0.id == op.id }
        if inFlight?.id == op.id { inFlight = nil }
    }

    /// It could not be sent (no network, a server not well): it stays where it was, first in line.
    public mutating func failed(_ op: LikeOperation) {
        if inFlight?.id == op.id { inFlight = nil }
    }

    // MARK: what the server says

    /// The set the server holds is the truth. What is waiting stays on top of it, except what the server already knows (a like of a song it has
    /// as liked changes nothing: another phone gave it, or the answer of the first try was lost). The operation that is being sent stays.
    public mutating func adopt(serverKeys keys: Set<String>) {
        serverKeys = keys
        var simulated = keys
        var kept: [LikeOperation] = []
        for op in pending {
            let changesSomething = (op.kind == .like) != simulated.contains(op.songKey)
            guard changesSomething || op.id == inFlight?.id else { continue }
            kept.append(op)
            if op.kind == .like { simulated.insert(op.songKey) } else { simulated.remove(op.songKey) }
        }
        pending = kept
    }

    // MARK: whose they are

    /// Another person starts from nothing: their likes are not mine, and mine are never sent as theirs. A phone on which nobody had signed in
    /// yet (no owner) gives its likes to the first person who does.
    public mutating func reset(owner new: String) {
        guard new != owner else { return }
        if owner.isEmpty {
            owner = new
        } else {
            self = LikesState(owner: new)
        }
    }

    // MARK: the file

    private enum CodingKeys: String, CodingKey { case owner, serverKeys, pending }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        owner = ((try? c.decodeIfPresent(String.self, forKey: .owner)) ?? nil) ?? ""
        serverKeys = Set(((try? c.decodeIfPresent([String].self, forKey: .serverKeys)) ?? nil) ?? [])
        pending = ((try? c.decodeIfPresent([LossyDecodable<LikeOperation>].self, forKey: .pending)) ?? nil)?.compactMap { $0.value } ?? []
        inFlight = nil
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(owner, forKey: .owner)
        try c.encode(serverKeys.sorted(), forKey: .serverKeys)
        try c.encode(pending, forKey: .pending)
    }
}
