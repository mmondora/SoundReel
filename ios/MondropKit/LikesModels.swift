// LikesModels.swift — what `GET /api/mondrop/likes` and `PUT|DELETE /api/mondrop/songs/:key/like` say (docs/mondrop-likes.md), and what the
// store needs of the backend (a fake in tests).
//
// Decoded defensively like the manifest: a field this build does not know is ignored, an element that cannot be read is skipped (one bad
// like must not hide the others), and every field the contract does not guarantee is optional.

import Foundation

/// One like of the person, as the server holds it.
public struct LikeRecord: Decodable, Equatable, Sendable {
    public let songKey: String
    /// When the person gave it; nil when the server did not say or said something that is not a date.
    public let likedAt: Date?

    public init(songKey: String, likedAt: Date?) {
        self.songKey = songKey
        self.likedAt = likedAt
    }

    private enum CodingKeys: String, CodingKey { case songKey, likedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let key = try c.decode(String.self, forKey: .songKey)
        guard !key.isEmpty else { throw DecodingError.dataCorruptedError(forKey: .songKey, in: c, debugDescription: "empty song key") }
        songKey = key
        likedAt = ((try? c.decodeIfPresent(String.self, forKey: .likedAt)) ?? nil).flatMap { ISO.parse($0) }
    }
}

/// `{ "user": "mike", "total": 2, "likes": [ { "songKey": "…", "likedAt": "…" }, … ] }`, the most recent like first.
public struct LikesSnapshot: Decodable, Equatable, Sendable {
    public let user: String?
    public let total: Int?
    public let likes: [LikeRecord]

    public init(user: String? = nil, total: Int? = nil, likes: [LikeRecord] = []) {
        self.user = user
        self.total = total
        self.likes = likes
    }

    private enum CodingKeys: String, CodingKey { case user, total, likes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = (try? c.decodeIfPresent(String.self, forKey: .user)) ?? nil
        total = (try? c.decodeIfPresent(Int.self, forKey: .total)) ?? nil
        likes = ((try? c.decodeIfPresent([LossyDecodable<LikeRecord>].self, forKey: .likes)) ?? nil)?.compactMap { $0.value } ?? []
    }
}

/// What `PUT` and `DELETE` answer: `{ "songKey": "…", "liked": true, "likedAt": "…" }`.
public struct LikeAck: Decodable, Equatable, Sendable {
    public let songKey: String
    public let liked: Bool
    public let likedAt: Date?

    public init(songKey: String, liked: Bool, likedAt: Date? = nil) {
        self.songKey = songKey
        self.liked = liked
        self.likedAt = likedAt
    }

    private enum CodingKeys: String, CodingKey { case songKey, liked, likedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        songKey = try c.decode(String.self, forKey: .songKey)
        liked = try c.decode(Bool.self, forKey: .liked)
        likedAt = ((try? c.decodeIfPresent(String.self, forKey: .likedAt)) ?? nil).flatMap { ISO.parse($0) }
    }

    /// A 200 means the server took the operation: an answer that cannot be read must not make the phone send it again.
    static func reading(_ data: Data, songKey: String, liked: Bool) -> LikeAck {
        (try? JSONDecoder().decode(LikeAck.self, from: data)) ?? LikeAck(songKey: songKey, liked: liked)
    }
}

/// What the likes need from the backend.
public protocol LikesTransport: Sendable {
    func fetchLikes() async throws -> LikesSnapshot
    func putLike(songKey: String, at: Date) async throws -> LikeAck
    func deleteLike(songKey: String) async throws -> LikeAck
}

extension MondropAPI: LikesTransport {
    /// `GET /api/mondrop/likes`: the set of the person of the key. An older server answers 404 (the likes then wait on the phone).
    public func fetchLikes() async throws -> LikesSnapshot {
        let data = try await sendRequest(path: "/api/mondrop/likes", timeout: 30)
        return try decodeBody(LikesSnapshot.self, from: data)
    }

    /// `PUT /api/mondrop/songs/:key/like`: idempotent; `at` is when the person gave the like on the phone.
    public func putLike(songKey: String, at: Date) async throws -> LikeAck {
        let body = Data(#"{"at":"\#(ISO.string(at))"}"#.utf8)
        let data = try await sendRequest(path: Self.songPath(songKey, suffix: "/like"), method: "PUT", body: body, timeout: 30)
        return LikeAck.reading(data, songKey: songKey, liked: true)
    }

    /// `DELETE /api/mondrop/songs/:key/like`: idempotent; fine when there was no like.
    public func deleteLike(songKey: String) async throws -> LikeAck {
        let data = try await sendRequest(path: Self.songPath(songKey, suffix: "/like"), method: "DELETE", timeout: 30)
        return LikeAck.reading(data, songKey: songKey, liked: false)
    }
}
