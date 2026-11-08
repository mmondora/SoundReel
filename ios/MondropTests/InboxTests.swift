import XCTest
@testable import Mondrop

/// «Posta»: reading the inbox (docs/mondrop-inbox.md), what is shown, and what the user can do with it.
final class InboxDecodingTests: XCTestCase {
    /// The example of the contract, field by field.
    static let documented = #"""
    {
      "notifications": [
        {
          "id": "b6a1", "kind": "share_result", "level": "info",
          "title": "Salvato su SoundReel", "body": "2 canzoni, 1 film · aggiunte a Road trip",
          "entryId": "75c141a1", "url": "https://soundreel.casamon.dev/?entry=75c141a1",
          "createdAt": "2026-11-08T07:10:00Z", "readAt": null, "expiresAt": "2026-11-11T07:10:00Z",
          "data": { "songs": 2, "films": 1, "notes": 0, "software": 0, "tags": 3, "playlist": { "id": "p1", "name": "Road trip", "added": 2 } }
        },
        {
          "id": "c0de", "kind": "share_result", "level": "error",
          "title": "Analisi non riuscita", "body": "Non sono riuscito a leggere il reel. Puoi riprovare.",
          "entryId": "e2", "url": "https://soundreel.casamon.dev/?entry=e2", "createdAt": "2026-11-08T07:00:00Z", "readAt": null, "expiresAt": null,
          "data": { "sourceUrl": "https://www.instagram.com/reel/abc/", "reason": "ai_output_unusable" }
        }
      ],
      "received": [
        { "entryId": "r1", "from": "sara", "sharedAt": "2026-11-08T06:00:00Z", "title": "Say it Ain't So", "kind": "spotify",
          "counts": { "songs": 1, "films": 0, "notes": 0, "software": 0 }, "seen": false, "url": "https://soundreel.casamon.dev/?entry=r1" }
      ],
      "unread": 2,
      "serverTime": "2026-11-08T07:12:00Z"
    }
    """#

    private func decode(_ json: String) throws -> InboxSnapshot {
        try JSONDecoder().decode(InboxSnapshot.self, from: Data(json.utf8))
    }

    func testTheDocumentedResponseDecodes() throws {
        let s = try decode(Self.documented)
        XCTAssertEqual(s.unread, 2)
        XCTAssertEqual(s.serverTime, "2026-11-08T07:12:00Z")
        XCTAssertEqual(s.notifications.map(\.id), ["b6a1", "c0de"])
        XCTAssertEqual(s.received.map(\.entryId), ["r1"])

        let info = s.notifications[0]
        XCTAssertEqual(info.kind, "share_result")
        XCTAssertEqual(info.level, .info)
        XCTAssertEqual(info.title, "Salvato su SoundReel")
        XCTAssertEqual(info.body, "2 canzoni, 1 film · aggiunte a Road trip")
        XCTAssertEqual(info.url, "https://soundreel.casamon.dev/?entry=75c141a1")
        XCTAssertNil(info.readAt)
        XCTAssertNotNil(info.createdAt)
        XCTAssertNotNil(info.expiresAt)
        XCTAssertEqual(info.data.songs, 2)
        XCTAssertEqual(info.data.films, 1)
        XCTAssertEqual(info.data.tags, 3)
        XCTAssertEqual(info.data.playlist, InboxPlaylistInfo(id: "p1", name: "Road trip", added: 2))
    }

    func testAnErrorNeverExpiresAndCarriesTheLinkToSendAgain() throws {
        let error = try decode(Self.documented).notifications[1]
        XCTAssertEqual(error.level, .error)
        XCTAssertTrue(error.isError)
        XCTAssertNil(error.expiresAt)
        XCTAssertEqual(error.data.sourceUrl, "https://www.instagram.com/reel/abc/")
        XCTAssertEqual(error.data.reason, "ai_output_unusable")
    }

    func testAReceivedShare() throws {
        let share = try decode(Self.documented).received[0]
        XCTAssertEqual(share.from, "sara")
        XCTAssertEqual(share.title, "Say it Ain't So")
        XCTAssertEqual(share.kind, "spotify")
        XCTAssertEqual(share.counts, ShareCounts(songs: 1))
        XCTAssertFalse(share.seen)
        XCTAssertEqual(share.url, "https://soundreel.casamon.dev/?entry=r1")
        XCTAssertEqual(share.id, "r1")
    }

    func testTheCountsReadLikeTheTelegramMessage() {
        XCTAssertEqual(ShareCounts(songs: 2, films: 1).summary, "2 canzoni, 1 film")
        XCTAssertEqual(ShareCounts(songs: 1).summary, "1 canzone")
        XCTAssertEqual(ShareCounts(songs: 1, films: 3, notes: 1, software: 2).summary, "1 canzone, 3 film, 1 nota, 2 software")
        XCTAssertEqual(ShareCounts(notes: 4).summary, "4 note")
        XCTAssertEqual(ShareCounts().summary, "")
    }

    func testAnEmptyInbox() throws {
        let s = try decode(#"{"notifications":[],"received":[],"unread":0,"serverTime":"2026-11-08T07:12:00Z"}"#)
        XCTAssertTrue(s.notifications.isEmpty)
        XCTAssertTrue(s.received.isEmpty)
        XCTAssertEqual(s.unread, 0)
    }

    func testEveryFieldIsOptional() throws {
        let s = try decode(#"{"notifications":[{"id":"x"}],"received":[{"entryId":"y"}]}"#)
        XCTAssertNil(s.unread)
        XCTAssertNil(s.serverTime)
        let n = s.notifications[0]
        XCTAssertEqual(n.level, .info, "no level = an info")
        XCTAssertEqual(n.title, "")
        XCTAssertNil(n.url)
        XCTAssertEqual(n.data, InboxData())
        XCTAssertEqual(s.received[0].from, "")
        XCTAssertFalse(s.received[0].seen)
    }

    func testAnUnknownLevelOrKindDoesNotBreakAnything() throws {
        let n = try decode(#"{"notifications":[{"id":"x","level":"critical","kind":"something_new","future":true}]}"#).notifications[0]
        XCTAssertEqual(n.level, .info)
        XCTAssertEqual(n.kind, "something_new")
    }

    func testAMalformedElementIsSkippedNotFatal() throws {
        let s = try decode(#"{"notifications":[{"title":"no id"},{"id":"ok"},7],"received":[{"from":"nobody"},{"entryId":"r"}],"unread":1}"#)
        XCTAssertEqual(s.notifications.map(\.id), ["ok"])
        XCTAssertEqual(s.received.map(\.entryId), ["r"])
    }

    func testBadDatesAndWrongTypesAreNotFatal() throws {
        let n = try decode(#"{"notifications":[{"id":"x","createdAt":"yesterday","readAt":5,"expiresAt":"","data":"nope"}]}"#).notifications[0]
        XCTAssertNil(n.createdAt)
        XCTAssertNil(n.readAt)
        XCTAssertNil(n.expiresAt)
        XCTAssertEqual(n.data, InboxData())
    }

    func testAPlaylistInTheDataWithoutAnIdIsIgnored() throws {
        let n = try decode(#"{"notifications":[{"id":"x","data":{"playlist":{"name":"orphan"}}}]}"#).notifications[0]
        XCTAssertNil(n.data.playlist)
    }

    func testNotAnInboxAtAllIsAnEmptyOne() throws {
        let s = try decode("{}")
        XCTAssertTrue(s.notifications.isEmpty)
        XCTAssertTrue(s.received.isEmpty)
        XCTAssertTrue(s.removedIds.isEmpty)
    }

    // MARK: the final contract (2.10.0): removedIds, data.options, data.retrying

    /// The answer of a light reading as the 2.10.0 server composes it.
    static let final = #"""
    {
      "notifications": [
        {
          "id": "b6a1", "kind": "share_result", "level": "info",
          "title": "Cloudflare ha rilasciato una skill", "body": "Una skill open source.\n2 canzoni, 1 film · aggiunte a «Road trip»",
          "entryId": "75c141a1", "url": "https://soundreel.casamon.dev/?entry=75c141a1",
          "createdAt": "2026-11-08T07:10:00.000Z", "readAt": null, "expiresAt": "2026-11-11T07:10:00.000Z",
          "data": { "songs": 2, "films": 1, "notes": 0, "software": 0, "tags": 3, "playlist": { "id": "p1", "name": "Road trip", "added": 2 } }
        },
        {
          "id": "c0de", "kind": "share_result", "level": "error",
          "title": "Analisi non riuscita", "body": "Non sono riuscito a leggere il contenuto (instagram.com). Puoi riprovare.",
          "entryId": "e2", "url": "https://soundreel.casamon.dev/?entry=e2", "createdAt": "2026-11-08T07:00:00.000Z", "readAt": null, "expiresAt": null,
          "data": { "reason": "ai_output_unusable", "sourceUrl": "https://www.instagram.com/reel/abc/",
                    "options": { "playlistId": "p1", "shareWith": ["archi"], "comment": "#tesla" } }
        },
        {
          "id": "d00d", "kind": "share_result", "level": "error",
          "title": "Instagram non risponde", "body": "Instagram richiede una nuova autorizzazione. Riprovo da solo: può volerci un po'.",
          "entryId": "e3", "url": "https://soundreel.casamon.dev/?entry=e3", "createdAt": "2026-11-08T07:01:00.000Z", "readAt": null, "expiresAt": null,
          "data": { "reason": "instagram_session", "sourceUrl": "https://www.instagram.com/reel/def/", "retrying": true }
        }
      ],
      "received": [],
      "removedIds": ["gone1", "gone2"],
      "unread": 3,
      "serverTime": "2026-11-08T07:12:00.123Z"
    }
    """#

    func testTheRemovedIdsOfALightReadingDecode() throws {
        let s = try decode(Self.final)
        XCTAssertEqual(s.removedIds, ["gone1", "gone2"])
        XCTAssertEqual(s.unread, 3)
        XCTAssertEqual(s.notifications.map(\.id), ["b6a1", "c0de", "d00d"])
    }

    func testRemovedIdsAreOptionalAndTolerant() throws {
        XCTAssertEqual(try decode(#"{"notifications":[]}"#).removedIds, [], "an older server does not say")
        XCTAssertEqual(try decode(#"{"removedIds":["a",7,null,"b",{}]}"#).removedIds, ["a", "b"], "only the ids are kept")
        XCTAssertEqual(try decode(#"{"removedIds":"nope"}"#).removedIds, [])
    }

    func testAnErrorCarriesTheOptionsTheShareWasSentWith() throws {
        let error = try decode(Self.final).notifications[1]
        XCTAssertEqual(error.data.reason, "ai_output_unusable")
        XCTAssertEqual(error.data.options, InboxRetryOptions(playlistId: "p1", shareWith: ["archi"], comment: "#tesla"))
        XCTAssertEqual(error.data.options?.shareOptions, ShareOptions(playlistId: "p1", shareWith: ["archi"]))
        XCTAssertFalse(error.data.retrying)
    }

    func testAnErrorTheServerKeepsRetryingSaysSo() throws {
        let error = try decode(Self.final).notifications[2]
        XCTAssertTrue(error.data.retrying)
        XCTAssertEqual(error.data.reasonKind, .instagramSession)
        XCTAssertNil(error.data.options, "a share with no options sends none")
    }

    func testTheOptionsAreTolerant() throws {
        func options(_ json: String) throws -> InboxRetryOptions? {
            try decode(#"{"notifications":[{"id":"x","data":\#(json)}]}"#).notifications[0].data.options
        }
        XCTAssertEqual(try options(#"{"options":{}}"#), InboxRetryOptions(), "present but empty: nothing was asked")
        XCTAssertEqual(try options(#"{"options":{"shareWith":["sara",3,""],"playlistId":"  ","comment":""}}"#), InboxRetryOptions(shareWith: ["sara"]))
        XCTAssertNil(try options(#"{"options":"nope"}"#))
        XCTAssertNil(try options(#"{"options":[1,2]}"#))
        XCTAssertNil(try options(#"{"reason":"x"}"#))
    }

    func testEveryReasonTheServerSends() {
        let expected: [(String, InboxReason, Bool)] = [
            ("analysis_failed", .analysisFailed, false),
            ("instagram_session", .instagramSession, false),
            ("ai_output_unusable", .aiOutputUnusable, false),
            ("shazam_unreadable", .shazamUnreadable, false),
            ("playlist_not_found", .playlistNotFound, true),
            ("playlist_dynamic", .playlistDynamic, true),
            ("playlist_read_only", .playlistReadOnly, true),
        ]
        for (text, reason, isPlaylist) in expected {
            XCTAssertEqual(InboxReason(serverValue: text), reason, text)
            XCTAssertEqual(reason.isPlaylistProblem, isPlaylist, text)
        }
        XCTAssertEqual(InboxReason(serverValue: "PLAYLIST_DYNAMIC"), .playlistDynamic, "case does not matter")
        XCTAssertEqual(InboxReason(serverValue: "quota"), .other("quota"), "a reason from a newer server is kept, not dropped")
        XCTAssertFalse(InboxReason.other("quota").isPlaylistProblem)
    }

    func testNoReasonOrABlankOneIsNoReason() {
        XCTAssertNil(InboxData().reasonKind)
        XCTAssertNil(InboxData(reason: "  ").reasonKind)
        XCTAssertEqual(InboxData(reason: "analysis_failed").reasonKind, .analysisFailed)
    }
}

final class InboxVisibilityTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_794_100_000)

    func testAnInfoNotificationDisappearsWhenItExpires() {
        let live = TestSupport.notification("a", expires: now.addingTimeInterval(60))
        let expired = TestSupport.notification("b", expires: now.addingTimeInterval(-60))
        XCTAssertTrue(InboxVisibility.isVisible(live, now: now))
        XCTAssertFalse(InboxVisibility.isVisible(expired, now: now), "the server sweeps once a day, the phone does not wait")
        XCTAssertTrue(InboxVisibility.isVisible(TestSupport.notification("c", expires: nil), now: now))
    }

    func testAnErrorIsShownWhateverItsDatesSay() {
        let ancient = TestSupport.notification("e1", level: .error, created: now.addingTimeInterval(-90 * 86_400), expires: nil)
        let expiredByMistake = TestSupport.notification("e2", level: .error, created: now.addingTimeInterval(-90 * 86_400), expires: now.addingTimeInterval(-86_400))
        XCTAssertTrue(InboxVisibility.isVisible(ancient, now: now))
        XCTAssertTrue(InboxVisibility.isVisible(expiredByMistake, now: now), "errors never expire")
    }

    func testErrorsComeFirstThenNewestFirstAndExpiredOnesAreLeftOut() {
        let list = [
            TestSupport.notification("old", created: now.addingTimeInterval(-3_000)),
            TestSupport.notification("new", created: now.addingTimeInterval(-100)),
            TestSupport.notification("err", level: .error, created: now.addingTimeInterval(-9_000)),
            TestSupport.notification("gone", created: now.addingTimeInterval(-5_000), expires: now.addingTimeInterval(-1)),
        ]
        XCTAssertEqual(InboxVisibility.ordered(list, now: now).map(\.id), ["err", "new", "old"])
    }
}

@MainActor
final class InboxModelTests: XCTestCase {
    private struct Rig {
        let model: InboxModel
        let inbox: FakeInbox
        let sender: FakeShareSender
        let badge: FakeBadge
        let log: ShareLog
        let clock: Clock
    }

    private final class Clock {
        var now = TestSupport.inboxNow
    }

    private func rig(_ snapshots: [InboxSnapshot] = [InboxSnapshot()], results: [Result<ShareResponse, Error>]? = nil) throws -> Rig {
        let inbox = FakeInbox(snapshots)
        let sender = FakeShareSender(results ?? [.success(ShareResponse(success: true, status: "queued", kind: "generic"))])
        let badge = FakeBadge()
        let log = ShareLog(url: try TestSupport.tempFile("share-log.json"))
        let clock = Clock()
        let model = InboxModel(transport: inbox, sender: sender, log: log, badge: badge, now: { clock.now })
        return Rig(model: model, inbox: inbox, sender: sender, badge: badge, log: log, clock: clock)
    }

    private func snapshot(
        _ notifications: [InboxNotification] = [], received: [ReceivedShare] = [], unread: Int? = nil, time: String = "2026-11-08T07:12:00Z"
    ) -> InboxSnapshot {
        InboxSnapshot(notifications: notifications, received: received, unread: unread, serverTime: time)
    }

    // MARK: reading

    func testTheFirstReadingIsTheWholeInbox() async throws {
        let r = try rig([snapshot([TestSupport.notification("a")], received: [TestSupport.receivedShare("r1")], unread: 2)])
        await r.model.refresh(.open)
        XCTAssertEqual(r.model.notifications.map(\.id), ["a"])
        XCTAssertEqual(r.model.received.map(\.entryId), ["r1"])
        XCTAssertEqual(r.model.unread, 2)
        XCTAssertEqual(r.inbox.sinceValues, [nil])
        XCTAssertEqual(r.model.serverTime, "2026-11-08T07:12:00Z")
        XCTAssertNil(r.model.error)
        XCTAssertEqual(r.badge.last, 2, "the app icon follows")
    }

    func testTheNextLightReadingSendsTheLastServerTimeAsSince() async throws {
        let r = try rig([snapshot(time: "T1"), snapshot(time: "T2"), snapshot(time: "T3")])
        await r.model.refresh(.open)
        await r.model.refresh(.foreground)
        await r.model.refresh(.sync)
        XCTAssertEqual(r.inbox.sinceValues, [nil, "T1", "T2"])
    }

    func testOpeningTheTabAndPullToRefreshAlwaysReadEverything() async throws {
        let r = try rig([snapshot(time: "T1"), snapshot(time: "T2"), snapshot(time: "T3"), snapshot(time: "T4")])
        await r.model.refresh(.open)
        await r.model.refresh(.open)
        await r.model.refresh(.pull)
        await r.model.refresh(.launch)
        XCTAssertEqual(r.inbox.sinceValues, [nil, nil, nil, nil])
    }

    func testALightReadingBecomesAFullOneWhenTheLastFullOneIsOld() async throws {
        let r = try rig([snapshot(time: "T1"), snapshot(time: "T2"), snapshot(time: "T3")])
        await r.model.refresh(.open)
        r.clock.now = r.clock.now.addingTimeInterval(InboxModel.fullEvery - 1)
        await r.model.refresh(.foreground)
        r.clock.now = r.clock.now.addingTimeInterval(InboxModel.fullEvery)
        await r.model.refresh(.foreground)
        XCTAssertEqual(r.inbox.sinceValues, [nil, "T1", nil], "«since» cannot say that an error was closed elsewhere: look at everything now and then")
    }

    func testALightReadingAddsAndUpdatesNotificationsButDoesNotForgetThem() async throws {
        let first = snapshot([TestSupport.notification("a"), TestSupport.notification("b", level: .error)], received: [TestSupport.receivedShare("r1")], unread: 3)
        var changed = TestSupport.notification("a")
        changed.readAt = TestSupport.inboxNow
        let delta = snapshot([changed, TestSupport.notification("c")], received: [TestSupport.receivedShare("r1")], unread: 2, time: "T2")
        let r = try rig([first, delta])
        await r.model.refresh(.open)
        await r.model.refresh(.foreground)
        XCTAssertEqual(Set(r.model.notifications.map(\.id)), ["a", "b", "c"], "b was not in the delta: it is not gone (`removedIds` would say so), the next full reading will tell")
        XCTAssertTrue(try XCTUnwrap(r.model.notifications.first { $0.id == "a" }).isRead, "the changed one is updated")
        XCTAssertEqual(r.model.received.map(\.entryId), ["r1"])
        XCTAssertEqual(r.model.unread, 2, "the count is the server's")
    }

    // MARK: `received` is the whole list in EVERY answer (`since` only narrows the notifications)

    func testALightReadingReplacesTheReceivedShares() async throws {
        let first = snapshot(received: [TestSupport.receivedShare("r1"), TestSupport.receivedShare("r2")], unread: 2)
        let delta = snapshot(received: [TestSupport.receivedShare("r2", seen: true), TestSupport.receivedShare("r3")], unread: 1, time: "T2")
        let r = try rig([first, delta])
        await r.model.refresh(.open)
        await r.model.refresh(.foreground)
        XCTAssertEqual(r.inbox.sinceValues, [nil, "2026-11-08T07:12:00Z"], "it was a light reading")
        XCTAssertEqual(r.model.received.map(\.entryId), ["r2", "r3"], "r1 was withdrawn: gone at once, not in ten minutes; r3 is new")
        XCTAssertTrue(try XCTUnwrap(r.model.received.first { $0.entryId == "r2" }).seen, "the server's `seen` wins")
        XCTAssertEqual(r.model.unread, 1)
    }

    func testAnEmptyReceivedInALightReadingMeansNoSharesAreLeft() async throws {
        let r = try rig([snapshot(received: [TestSupport.receivedShare("r1")], unread: 1), snapshot(received: [], unread: 0, time: "T2")])
        await r.model.refresh(.open)
        await r.model.refresh(.sync)
        XCTAssertTrue(r.model.received.isEmpty, "the owner withdrew it")
        XCTAssertEqual(r.model.unseenReceived, 0)
    }

    func testAShareSeenOnAnotherDeviceIsSeenHereAtTheNextLightReading() async throws {
        let r = try rig([
            sharedWith([TestSupport.sharedWithYou("n1", entry: "r1")], shares: ["r1"], unread: 1),
            snapshot(received: [TestSupport.receivedShare("r1", seen: true)], unread: 0, time: "T2"),
        ])
        await r.model.refresh(.open)
        await r.model.refresh(.foreground)
        XCTAssertTrue(try XCTUnwrap(r.model.received.first).seen)
        XCTAssertEqual(r.model.unread, 0)
    }

    func testTheReceivedSharesOfALightReadingAreKeptEvenWhenNoNotificationChanged() async throws {
        let r = try rig([snapshot(unread: 0), snapshot(received: [TestSupport.receivedShare("r1")], unread: 1, time: "T2")])
        await r.model.refresh(.open)
        await r.model.refresh(.foreground)
        XCTAssertEqual(r.model.received.map(\.entryId), ["r1"], "a share that arrived with no notice yet shows up on a light reading")
    }

    func testWithoutAnUnreadFieldALightReadingCountsFromTheReplacedLists() async throws {
        let r = try rig([snapshot(received: [TestSupport.receivedShare("r1"), TestSupport.receivedShare("r2")], unread: 2), snapshot(received: [TestSupport.receivedShare("r2")], unread: nil, time: "T2")])
        await r.model.refresh(.open)
        await r.model.refresh(.foreground)
        XCTAssertEqual(r.model.unread, 1, "r1 is gone: only r2 is left to see")
    }

    func testAFullReadingReplacesEverything() async throws {
        let r = try rig([
            snapshot([TestSupport.notification("a"), TestSupport.notification("b", level: .error)], received: [TestSupport.receivedShare("r1")], unread: 3),
            snapshot([TestSupport.notification("a")], received: [], unread: 1),
        ])
        await r.model.refresh(.open)
        await r.model.refresh(.pull)
        XCTAssertEqual(r.model.notifications.map(\.id), ["a"], "the error was closed on the server: gone")
        XCTAssertTrue(r.model.received.isEmpty, "a withdrawn share is gone")
        XCTAssertEqual(r.model.unread, 1)
    }

    func testWithoutAnUnreadFieldTheCountIsWorkedOutFromTheLists() async throws {
        let r = try rig([snapshot([TestSupport.notification("a"), TestSupport.notification("b", read: TestSupport.inboxNow)], received: [TestSupport.receivedShare("r1"), TestSupport.receivedShare("r2", seen: true)], unread: nil)])
        await r.model.refresh(.open)
        XCTAssertEqual(r.model.unread, 2, "one unread notification + one unseen share")
    }

    func testANotificationPastItsExpiryIsNotKept() async throws {
        let expired = TestSupport.notification("old", expires: TestSupport.inboxNow.addingTimeInterval(-10))
        let r = try rig([snapshot([expired, TestSupport.notification("live")], unread: 1)])
        await r.model.refresh(.open)
        XCTAssertEqual(r.model.notifications.map(\.id), ["live"])
    }

    func testAnErrorStaysInTheListHoweverOldItIs() async throws {
        let old = TestSupport.notification("e", level: .error, created: TestSupport.inboxNow.addingTimeInterval(-60 * 86_400), expires: nil, sourceUrl: "https://x.test/a")
        let r = try rig([snapshot([old], unread: 1)])
        await r.model.refresh(.open)
        XCTAssertEqual(r.model.visibleNotifications.map(\.id), ["e"])
    }

    func testAFailedReadingKeepsTheListAndSaysSoQuietly() async throws {
        let r = try rig([snapshot([TestSupport.notification("a")], unread: 1)])
        await r.model.refresh(.open)
        r.inbox.fail(["inbox"])
        await r.model.refresh(.open)
        XCTAssertEqual(r.model.notifications.map(\.id), ["a"], "the last good list stays")
        XCTAssertNotNil(r.model.error)
        r.inbox.fail([])
        await r.model.refresh(.open)
        XCTAssertNil(r.model.error)
    }

    func testABackendWithoutThePostaIsSaidInPlainWords() async throws {
        let r = try rig()
        r.inbox.failWith(MondropAPIError.http(404, "not found"))
        await r.model.refresh(.open)
        XCTAssertEqual(r.model.error, "il server non ha ancora la Posta (backend da aggiornare)")
        XCTAssertTrue(r.model.notifications.isEmpty)
    }

    // MARK: the unread count

    func testReadingOneLowersTheCountAtOnceAndTellsTheServer() async throws {
        let r = try rig([snapshot([TestSupport.notification("a"), TestSupport.notification("b")], unread: 2)])
        await r.model.refresh(.open)
        await r.model.markRead("a")
        XCTAssertEqual(r.model.unread, 1)
        XCTAssertTrue(try XCTUnwrap(r.model.notifications.first { $0.id == "a" }).isRead)
        XCTAssertEqual(r.inbox.calls.filter { $0.hasPrefix("markRead") }, ["markRead:a"])
        XCTAssertEqual(r.badge.last, 1)
    }

    func testReadingTheSameOneTwiceCountsOnce() async throws {
        let r = try rig([snapshot([TestSupport.notification("a")], unread: 1)])
        await r.model.refresh(.open)
        await r.model.markRead("a")
        await r.model.markRead("a")
        XCTAssertEqual(r.model.unread, 0)
        XCTAssertEqual(r.inbox.calls.filter { $0.hasPrefix("markRead") }.count, 1)
    }

    func testTheCountNeverGoesBelowZero() async throws {
        let r = try rig([snapshot([TestSupport.notification("a")], unread: 0)])
        await r.model.refresh(.open)
        await r.model.markRead("a")
        XCTAssertEqual(r.model.unread, 0)
    }

    func testMarkReadOnViewReadsEveryUnreadOneOnScreen() async throws {
        let r = try rig([snapshot([
            TestSupport.notification("a"), TestSupport.notification("b", level: .error), TestSupport.notification("c", read: TestSupport.inboxNow),
        ], unread: 2)])
        await r.model.refresh(.open)
        await r.model.markVisibleRead()
        XCTAssertEqual(Set(r.inbox.calls.filter { $0.hasPrefix("markRead") }), ["markRead:a", "markRead:b"], "the one already read is not sent again")
        XCTAssertEqual(r.model.unread, 0)
        XCTAssertEqual(r.model.notifications.count, 3, "reading an error does not remove it")
    }

    func testAReadThatTheServerDidNotConfirmIsTakenBack() async throws {
        let r = try rig([snapshot([TestSupport.notification("a")], unread: 1)])
        await r.model.refresh(.open)
        r.inbox.fail(["markRead"])
        await r.model.markRead("a")
        XCTAssertFalse(try XCTUnwrap(r.model.notifications.first).isRead)
        XCTAssertEqual(r.model.unread, 1)
        XCTAssertEqual(r.badge.last, 1)
    }

    func testReadAll() async throws {
        let r = try rig([snapshot([TestSupport.notification("a"), TestSupport.notification("b")], unread: 2)])
        await r.model.refresh(.open)
        await r.model.markAllRead()
        XCTAssertEqual(r.model.unread, 0)
        XCTAssertTrue(r.model.notifications.allSatisfy(\.isRead))
        XCTAssertEqual(r.inbox.calls.filter { $0 == "readAll" }.count, 1)
    }

    func testReadAllThatFailsIsTakenBack() async throws {
        let r = try rig([snapshot([TestSupport.notification("a")], unread: 1)])
        await r.model.refresh(.open)
        r.inbox.fail(["readAll"])
        await r.model.markAllRead()
        XCTAssertEqual(r.model.unread, 1)
        XCTAssertFalse(try XCTUnwrap(r.model.notifications.first).isRead)
        XCTAssertNotNil(r.model.error)
    }

    // MARK: delete

    func testDeleteRemovesTheNotificationAndCallsTheServer() async throws {
        let r = try rig([snapshot([TestSupport.notification("a"), TestSupport.notification("b", level: .error)], unread: 2)])
        await r.model.refresh(.open)
        await r.model.delete("b")
        XCTAssertEqual(r.model.notifications.map(\.id), ["a"])
        XCTAssertEqual(r.model.unread, 1, "it was unread")
        XCTAssertEqual(r.inbox.calls.filter { $0.hasPrefix("delete") }, ["delete:b"])
        XCTAssertEqual(r.badge.last, 1)
    }

    func testDeletingAReadOneDoesNotChangeTheCount() async throws {
        let r = try rig([snapshot([TestSupport.notification("a", read: TestSupport.inboxNow), TestSupport.notification("b")], unread: 1)])
        await r.model.refresh(.open)
        await r.model.delete("a")
        XCTAssertEqual(r.model.unread, 1)
    }

    func testADeleteThatFailsPutsItBackWhereItWas() async throws {
        let r = try rig([snapshot([TestSupport.notification("a"), TestSupport.notification("b")], unread: 2)])
        await r.model.refresh(.open)
        let order = r.model.notifications.map(\.id)
        r.inbox.fail(["delete"])
        await r.model.delete("a")
        XCTAssertEqual(r.model.notifications.map(\.id), order)
        XCTAssertEqual(r.model.unread, 2)
        XCTAssertNotNil(r.model.error)
    }

    func testDeletingSomethingThatIsNotThereDoesNothing() async throws {
        let r = try rig([snapshot([TestSupport.notification("a")], unread: 1)])
        await r.model.refresh(.open)
        await r.model.delete("zzz")
        XCTAssertTrue(r.inbox.calls.filter { $0.hasPrefix("delete") }.isEmpty)
    }

    // MARK: received shares

    func testOpeningAReceivedShareMarksItSeen() async throws {
        let r = try rig([snapshot(received: [TestSupport.receivedShare("r1"), TestSupport.receivedShare("r2")], unread: 2)])
        await r.model.refresh(.open)
        await r.model.markSeen("r1")
        XCTAssertTrue(try XCTUnwrap(r.model.received.first { $0.entryId == "r1" }).seen)
        XCTAssertEqual(r.model.unread, 1)
        XCTAssertEqual(r.inbox.calls.filter { $0.hasPrefix("seen") }, ["seen:r1"])
        await r.model.markSeen("r1")
        XCTAssertEqual(r.inbox.calls.filter { $0.hasPrefix("seen") }.count, 1, "already seen: nothing to tell")
    }

    func testASeenThatTheServerDidNotConfirmIsTakenBack() async throws {
        let r = try rig([snapshot(received: [TestSupport.receivedShare("r1")], unread: 1)])
        await r.model.refresh(.open)
        r.inbox.fail(["seen"])
        await r.model.markSeen("r1")
        XCTAssertFalse(try XCTUnwrap(r.model.received.first).seen)
        XCTAssertEqual(r.model.unread, 1)
    }

    func testReceivedSharesNeverExpire() async throws {
        let old = ReceivedShare(entryId: "r", from: "sara", sharedAt: TestSupport.inboxNow.addingTimeInterval(-200 * 86_400), seen: true)
        let r = try rig([snapshot(received: [old], unread: 0)])
        await r.model.refresh(.open)
        XCTAssertEqual(r.model.received.map(\.entryId), ["r"])
    }

    // MARK: removedIds (the server says what disappeared)

    private func light(_ notifications: [InboxNotification] = [], removed: [String], unread: Int? = nil, time: String = "T2") -> InboxSnapshot {
        InboxSnapshot(notifications: notifications, received: [], removedIds: removed, unread: unread, serverTime: time)
    }

    func testALightReadingForgetsWhatTheServerSaysIsGone() async throws {
        let first = snapshot([TestSupport.notification("a"), TestSupport.notification("b", level: .error), TestSupport.notification("c")], unread: 3)
        let r = try rig([first, light(removed: ["b"], unread: 2)])
        await r.model.refresh(.open)
        await r.model.refresh(.foreground)
        XCTAssertEqual(Set(r.model.notifications.map(\.id)), ["a", "c"], "the error was closed elsewhere: gone now, not in ten minutes")
        XCTAssertEqual(r.inbox.sinceValues, [nil, "2026-11-08T07:12:00Z"], "it was a light reading")
        XCTAssertEqual(r.model.unread, 2)
    }

    func testAChangedAndARemovedOneInTheSameAnswer() async throws {
        var changed = TestSupport.notification("a")
        changed.readAt = TestSupport.inboxNow
        let r = try rig([snapshot([TestSupport.notification("a"), TestSupport.notification("b")], unread: 2), light([changed, TestSupport.notification("n")], removed: ["b"], unread: 1)])
        await r.model.refresh(.open)
        await r.model.refresh(.sync)
        XCTAssertEqual(Set(r.model.notifications.map(\.id)), ["a", "n"])
        XCTAssertTrue(try XCTUnwrap(r.model.notifications.first { $0.id == "a" }).isRead)
    }

    func testRemovingSomethingThePhoneNeverHadIsNotAnError() async throws {
        let r = try rig([snapshot([TestSupport.notification("a")], unread: 1), light(removed: ["zzz", "yyy"], unread: 1)])
        await r.model.refresh(.open)
        await r.model.refresh(.foreground)
        XCTAssertEqual(r.model.notifications.map(\.id), ["a"])
        XCTAssertNil(r.model.error)
    }

    func testWhatWasDeletedHereAndComesBackAsRemovedIsAlreadyGone() async throws {
        let r = try rig([snapshot([TestSupport.notification("a"), TestSupport.notification("b")], unread: 2), light(removed: ["a"], unread: 1)])
        await r.model.refresh(.open)
        await r.model.delete("a")
        await r.model.refresh(.foreground)
        XCTAssertEqual(r.model.notifications.map(\.id), ["b"])
    }

    func testTheRememberedRiprovaGoesWhenItsErrorGoes() async throws {
        let err = TestSupport.notification("e1", level: .error, sourceUrl: "https://www.instagram.com/reel/abc/")
        let r = try rig([snapshot([err], unread: 1), light(removed: ["e1"], unread: 0)])
        await r.model.refresh(.open)
        _ = await r.model.retry(err)
        XCTAssertNotNil(r.model.resent["e1"])
        await r.model.refresh(.foreground)
        XCTAssertTrue(r.model.notifications.isEmpty)
        XCTAssertNil(r.model.resent["e1"], "the server closed it because the link went through")
    }

    func testTheTenMinuteFullReadingStaysAsTheSafetyNetForAnOlderServer() async throws {
        let r = try rig([snapshot([TestSupport.notification("a"), TestSupport.notification("b")], unread: 2), snapshot([TestSupport.notification("a")], unread: 1)])
        await r.model.refresh(.open)
        r.clock.now = r.clock.now.addingTimeInterval(InboxModel.fullEvery + 1)
        await r.model.refresh(.foreground)
        XCTAssertEqual(r.model.notifications.map(\.id), ["a"], "an old server sends no removedIds: the full reading still catches it")
        XCTAssertEqual(r.inbox.sinceValues, [nil, nil])
    }

    // MARK: one badge — a received share counts ONCE, seen == read

    private func sharedWith(_ notices: [InboxNotification], shares: [String], unread: Int?) -> InboxSnapshot {
        snapshot(notices, received: shares.map { TestSupport.receivedShare($0) }, unread: unread)
    }

    func testWithoutAnUnreadFieldASharedEntryAndItsNoticeCountOnce() async throws {
        let r = try rig([sharedWith([TestSupport.sharedWithYou("n1", entry: "r1")], shares: ["r1", "r2"], unread: nil)])
        await r.model.refresh(.open)
        XCTAssertEqual(r.model.unread, 2, "r1 (its notice stands for it) + r2 (unseen, no notice) — not 3")
    }

    func testAnExpiredNoticeNoLongerStandsForItsShare() async throws {
        let expired = TestSupport.sharedWithYou("n1", entry: "r1", expires: TestSupport.inboxNow.addingTimeInterval(-10))
        let r = try rig([sharedWith([expired], shares: ["r1"], unread: nil)])
        await r.model.refresh(.open)
        XCTAssertTrue(r.model.notifications.isEmpty)
        XCTAssertEqual(r.model.unread, 1, "the notice is gone but the share is still unseen: it counts")
    }

    func testTheServersNumberIsTheTruthWheneverItIsThere() async throws {
        let r = try rig([sharedWith([TestSupport.sharedWithYou("n1", entry: "r1")], shares: ["r1"], unread: 5)])
        await r.model.refresh(.open)
        XCTAssertEqual(r.model.unread, 5, "this phone's list may hold less than the server has: do not second-guess it")
    }

    func testReadingTheNoticeOfAReceivedShareSeesTheShare() async throws {
        let r = try rig([sharedWith([TestSupport.sharedWithYou("n1", entry: "r1")], shares: ["r1", "r2"], unread: 2)])
        await r.model.refresh(.open)
        await r.model.markRead("n1")
        XCTAssertEqual(r.model.unread, 1, "the pair counted once: reading it takes ONE off, not two")
        XCTAssertTrue(try XCTUnwrap(r.model.received.first { $0.entryId == "r1" }).seen)
        XCTAssertFalse(try XCTUnwrap(r.model.received.first { $0.entryId == "r2" }).seen, "another share is not touched")
        XCTAssertEqual(r.inbox.calls.filter { $0.hasPrefix("markRead") || $0.hasPrefix("seen") }, ["markRead:n1"], "the server does the other half itself")
        XCTAssertEqual(r.badge.last, 1)
    }

    func testSeeingAReceivedShareReadsItsNotice() async throws {
        let r = try rig([sharedWith([TestSupport.sharedWithYou("n1", entry: "r1")], shares: ["r1", "r2"], unread: 2)])
        await r.model.refresh(.open)
        await r.model.markSeen("r1")
        XCTAssertEqual(r.model.unread, 1)
        XCTAssertTrue(try XCTUnwrap(r.model.notifications.first { $0.id == "n1" }).isRead)
        XCTAssertEqual(r.inbox.calls.filter { $0.hasPrefix("markRead") || $0.hasPrefix("seen") }, ["seen:r1"])
        XCTAssertEqual(r.model.unreadNotifications, 0, "the tab title agrees")
        XCTAssertEqual(r.model.unseenReceived, 1)
    }

    func testReadingTheNoticeAndThenOpeningTheShareDoesNotCountTwice() async throws {
        let r = try rig([sharedWith([TestSupport.sharedWithYou("n1", entry: "r1")], shares: ["r1"], unread: 1)])
        await r.model.refresh(.open)
        await r.model.markRead("n1")
        await r.model.markSeen("r1")
        XCTAssertEqual(r.model.unread, 0)
        XCTAssertEqual(r.inbox.calls.filter { $0.hasPrefix("seen") }.count, 0, "already seen when the notice was read: nothing to tell")
    }

    func testDeletingAnUnreadNoticeOfAShareSeesTheShare() async throws {
        let r = try rig([sharedWith([TestSupport.sharedWithYou("n1", entry: "r1")], shares: ["r1", "r2"], unread: 2)])
        await r.model.refresh(.open)
        await r.model.delete("n1")
        XCTAssertTrue(r.model.notifications.isEmpty)
        XCTAssertTrue(try XCTUnwrap(r.model.received.first { $0.entryId == "r1" }).seen, "the badge must drop, as it does on the server")
        XCTAssertEqual(r.model.unread, 1)
        XCTAssertEqual(r.inbox.calls.filter { $0.hasPrefix("delete") || $0.hasPrefix("seen") }, ["delete:n1"])
    }

    func testDeletingAResultNoticeNeverTouchesTheShares() async throws {
        // a «share_result» that happens to carry the same entry id as a received share is NOT its notice
        let result = TestSupport.notification("n1", entryId: "r1")
        let r = try rig([sharedWith([result], shares: ["r1"], unread: 2)])
        await r.model.refresh(.open)
        await r.model.delete("n1")
        XCTAssertFalse(try XCTUnwrap(r.model.received.first).seen)
        XCTAssertEqual(r.model.unread, 1)
    }

    func testMarkVisibleReadKeepsTheLinkedPairCountedOnce() async throws {
        let r = try rig([sharedWith([TestSupport.sharedWithYou("n1", entry: "r1"), TestSupport.notification("a")], shares: ["r1"], unread: 2)])
        await r.model.refresh(.open)
        await r.model.markVisibleRead()
        XCTAssertEqual(r.model.unread, 0)
        XCTAssertTrue(try XCTUnwrap(r.model.received.first).seen)
        XCTAssertEqual(Set(r.inbox.calls.filter { $0.hasPrefix("markRead") }), ["markRead:n1", "markRead:a"])
    }

    func testBetweenTwoReadingsTheNumberMovesFromTheServersBaseline() async throws {
        let r = try rig([snapshot([TestSupport.notification("a"), TestSupport.notification("b")], unread: 7)])
        await r.model.refresh(.open)
        await r.model.markRead("a")
        XCTAssertEqual(r.model.unread, 6, "the server counts 7, this phone sees 2: one fewer is 6, not 1")
    }

    func testAReadThatFailsTakesBackTheSharesSeenToo() async throws {
        let r = try rig([sharedWith([TestSupport.sharedWithYou("n1", entry: "r1")], shares: ["r1"], unread: 1)])
        await r.model.refresh(.open)
        r.inbox.fail(["markRead"])
        await r.model.markRead("n1")
        XCTAssertFalse(try XCTUnwrap(r.model.notifications.first).isRead)
        XCTAssertFalse(try XCTUnwrap(r.model.received.first).seen)
        XCTAssertEqual(r.model.unread, 1)
        XCTAssertEqual(r.badge.last, 1)
    }

    func testASeenThatFailsTakesBackTheNoticeToo() async throws {
        let r = try rig([sharedWith([TestSupport.sharedWithYou("n1", entry: "r1")], shares: ["r1"], unread: 1)])
        await r.model.refresh(.open)
        r.inbox.fail(["seen"])
        await r.model.markSeen("r1")
        XCTAssertFalse(try XCTUnwrap(r.model.received.first).seen)
        XCTAssertFalse(try XCTUnwrap(r.model.notifications.first).isRead)
        XCTAssertEqual(r.model.unread, 1)
    }

    func testADeleteThatFailsTakesBackTheShareToo() async throws {
        let r = try rig([sharedWith([TestSupport.sharedWithYou("n1", entry: "r1")], shares: ["r1"], unread: 1)])
        await r.model.refresh(.open)
        r.inbox.fail(["delete"])
        await r.model.delete("n1")
        XCTAssertEqual(r.model.notifications.map(\.id), ["n1"])
        XCTAssertFalse(try XCTUnwrap(r.model.received.first).seen)
        XCTAssertEqual(r.model.unread, 1)
    }

    func testAnUndoGivesBackExactlyWhatWasTakenOff() async throws {
        // the count was already 0 (a reading raced): reading one cannot take a number off 0, so undoing it must not add one
        let r = try rig([snapshot([TestSupport.notification("a")], unread: 0)])
        await r.model.refresh(.open)
        r.inbox.fail(["markRead"])
        await r.model.markRead("a")
        XCTAssertEqual(r.model.unread, 0)
    }

    func testReadAllSeesEveryShareAndLeavesNothingWhateverThePhoneHolds() async throws {
        let r = try rig([sharedWith([TestSupport.sharedWithYou("n1", entry: "r1"), TestSupport.notification("a")], shares: ["r1", "r2"], unread: 150)])
        await r.model.refresh(.open)
        await r.model.markAllRead()
        XCTAssertEqual(r.model.unread, 0, "the server read everything, also what this phone never loaded")
        XCTAssertTrue(r.model.notifications.allSatisfy(\.isRead))
        XCTAssertTrue(r.model.received.allSatisfy(\.seen))
        XCTAssertEqual(r.badge.last, 0)
    }

    func testReadAllThatFailsTakesBackBothLists() async throws {
        let r = try rig([sharedWith([TestSupport.sharedWithYou("n1", entry: "r1")], shares: ["r1", "r2"], unread: 2)])
        await r.model.refresh(.open)
        r.inbox.fail(["readAll"])
        await r.model.markAllRead()
        XCTAssertEqual(r.model.unread, 2)
        XCTAssertFalse(try XCTUnwrap(r.model.notifications.first).isRead)
        XCTAssertEqual(r.model.received.filter(\.seen).count, 0)
        XCTAssertNotNil(r.model.error)
    }

    // MARK: «Riprova»

    private func error(_ id: String = "e1", source: String? = "https://www.instagram.com/reel/abc/") -> InboxNotification {
        TestSupport.notification(id, level: .error, sourceUrl: source)
    }

    func testRiprovaSendsTheSourceLinkThroughTheSameShareCall() async throws {
        let r = try rig()
        let result = await r.model.retry(error())
        guard case .sent = result else { return XCTFail("\(result)") }
        XCTAssertEqual(r.sender.calls, [.init(url: "https://www.instagram.com/reel/abc/", comment: nil, tags: nil, options: .none)])
    }

    func testRiprovaSendsItTheWayItWasSentTheFirstTime() async throws {
        let r = try rig()
        r.log.record(url: "https://www.instagram.com/reel/abc/?igsh=xyz", comment: "#tesla", options: ShareOptions(playlistId: "p1", shareWith: ["archi", "sara"]))
        _ = await r.model.retry(error())
        XCTAssertEqual(
            r.sender.calls,
            [.init(url: "https://www.instagram.com/reel/abc/", comment: "#tesla", tags: nil, options: ShareOptions(playlistId: "p1", shareWith: ["archi", "sara"]))],
            "same playlist, same recipients, same comment — found through the canonical link"
        )
    }

    func testRiprovaTwiceSendsTheSameBodyTwice() async throws {
        let r = try rig()
        r.log.record(url: "https://www.instagram.com/reel/abc/", comment: nil, options: ShareOptions(playlistId: "p1"))
        _ = await r.model.retry(error())
        _ = await r.model.retry(error())
        XCTAssertEqual(r.sender.calls.count, 2)
        XCTAssertEqual(r.sender.calls[0], r.sender.calls[1])
    }

    func testRiprovaMarksTheErrorAsSentAgain() async throws {
        let r = try rig()
        XCTAssertNil(r.model.resent["e1"])
        _ = await r.model.retry(error())
        XCTAssertEqual(r.model.resent["e1"], TestSupport.inboxNow)
    }

    func testAnErrorWithNoLinkCannotBeRetried() async throws {
        let r = try rig()
        let result = await r.model.retry(error(source: nil))
        XCTAssertEqual(result, .noLink)
        XCTAssertTrue(r.sender.calls.isEmpty)
        let blank = await r.model.retry(error(source: "  "))
        XCTAssertEqual(blank, .noLink)
    }

    func testRiprovaThatFailsSaysWhy() async throws {
        let r = try rig(results: [.failure(BackendError.transport(URLError(.notConnectedToInternet)))])
        let result = await r.model.retry(error())
        guard case .failed(let reason) = result else { return XCTFail("\(result)") }
        XCTAssertTrue(reason.hasPrefix("Server non raggiungibile"))
        XCTAssertNil(r.model.resent["e1"], "it was not sent")

        let refused = try rig(results: [.success(ShareResponse(success: false, error: "Shazam: HTTP 503"))])
        let answer = await refused.model.retry(error())
        XCTAssertEqual(answer, .failed("Shazam: HTTP 503"))
    }

    func testRiprovaDoesNotRemoveTheErrorItself() async throws {
        let r = try rig([snapshot([error()], unread: 1)])
        await r.model.refresh(.open)
        _ = await r.model.retry(error())
        XCTAssertEqual(r.model.notifications.map(\.id), ["e1"], "the server closes it when the link later succeeds")
        XCTAssertTrue(r.inbox.calls.filter { $0.hasPrefix("delete") }.isEmpty)
    }

    // MARK: «Riprova» with what the server kept (a share made on another device)

    private let source = "https://www.instagram.com/reel/abc/"
    private let kept = InboxRetryOptions(playlistId: "p1", shareWith: ["archi", "sara"], comment: "#tesla")

    private func failed(reason: String? = "ai_output_unusable", options: InboxRetryOptions? = nil, retrying: Bool = false) -> InboxNotification {
        TestSupport.notification("e1", level: .error, sourceUrl: source, reason: reason, options: options, retrying: retrying)
    }

    func testRiprovaOfAShareFromAnotherDeviceUsesWhatTheServerKept() async throws {
        let r = try rig()
        let result = await r.model.retry(failed(options: kept))
        guard case .sent = result else { return XCTFail("\(result)") }
        XCTAssertEqual(
            r.sender.calls,
            [.init(url: source, comment: "#tesla", tags: nil, options: ShareOptions(playlistId: "p1", shareWith: ["archi", "sara"]))],
            "this phone never sent it, the server remembered how"
        )
    }

    func testThisPhonesOwnRecordWinsOverWhatTheServerKept() async throws {
        let r = try rig()
        r.log.record(url: source, comment: "#local", options: ShareOptions(playlistId: "pLocal", shareWith: ["sara"]))
        _ = await r.model.retry(failed(options: kept))
        XCTAssertEqual(r.sender.calls, [.init(url: source, comment: "#local", tags: nil, options: ShareOptions(playlistId: "pLocal", shareWith: ["sara"]))])
    }

    func testAnErrorOfAnOlderServerWithNoOptionsAnywhereSendsTheBareLink() async throws {
        let r = try rig()
        _ = await r.model.retry(failed(options: nil))
        XCTAssertEqual(r.sender.calls, [.init(url: source, comment: nil, tags: nil, options: .none)])
    }

    func testWhenThePlaylistWasTheProblemRiprovaLeavesItOutAndKeepsTheRest() async throws {
        for reason in ["playlist_not_found", "playlist_dynamic", "playlist_read_only"] {
            // from what the server kept…
            let fromServer = try rig()
            _ = await fromServer.model.retry(failed(reason: reason, options: kept))
            XCTAssertEqual(
                fromServer.sender.calls,
                [.init(url: source, comment: "#tesla", tags: nil, options: ShareOptions(playlistId: nil, shareWith: ["archi", "sara"]))],
                "\(reason): no playlist, same recipients, same comment"
            )
            // …and from this phone's own record
            let fromPhone = try rig()
            fromPhone.log.record(url: source, comment: "#x", options: ShareOptions(playlistId: "p9", shareWith: ["archi"]))
            _ = await fromPhone.model.retry(failed(reason: reason, options: nil))
            XCTAssertEqual(fromPhone.sender.calls, [.init(url: source, comment: "#x", tags: nil, options: ShareOptions(playlistId: nil, shareWith: ["archi"]))], reason)
        }
    }

    func testAnotherReasonKeepsThePlaylist() async throws {
        for reason in ["analysis_failed", "ai_output_unusable", "instagram_session", "shazam_unreadable", "something_new"] {
            let r = try rig()
            _ = await r.model.retry(failed(reason: reason, options: kept))
            XCTAssertEqual(r.sender.calls.first?.options.playlistId, "p1", reason)
        }
    }

    func testRiprovaRecordsWhatItSentSoTheNextOneStartsFromIt() async throws {
        let r = try rig()
        _ = await r.model.retry(failed(reason: "playlist_dynamic", options: kept))
        let recorded = try XCTUnwrap(r.log.lastEntry(forURL: source, now: TestSupport.inboxNow))
        XCTAssertNil(recorded.playlistId, "the playlist that did not work is not remembered")
        XCTAssertEqual(recorded.shareWith, ["archi", "sara"])
        XCTAssertEqual(recorded.comment, "#tesla")
    }

    func testARiprovaThatFailsRecordsNothing() async throws {
        let r = try rig(results: [.failure(BackendError.transport(URLError(.notConnectedToInternet)))])
        _ = await r.model.retry(failed(options: kept))
        XCTAssertNil(r.log.lastEntry(forURL: source, now: TestSupport.inboxNow))
        let refused = try rig(results: [.success(ShareResponse(success: false, error: "Shazam: HTTP 503"))])
        _ = await refused.model.retry(failed(options: kept))
        XCTAssertNil(refused.log.lastEntry(forURL: source, now: TestSupport.inboxNow))
    }
}

/// What «Riprova» is called and how loud it is, from what the server says about the error.
final class InboxRetryActionTests: XCTestCase {
    private func error(reason: String? = nil, retrying: Bool = false, source: String? = "https://x.test/a") -> InboxNotification {
        TestSupport.notification("e", level: .error, sourceUrl: source, reason: reason, retrying: retrying)
    }

    func testAnOrdinaryErrorSaysRiprova() {
        for reason in [nil, "analysis_failed", "ai_output_unusable", "shazam_unreadable", "something_new"] {
            XCTAssertEqual(error(reason: reason).retryAction, InboxRetryAction(label: "Riprova", dropsPlaylist: false, isPrimary: true), reason ?? "no reason")
        }
    }

    func testEveryPlaylistProblemSaysRiprovaSenzaPlaylist() {
        for reason in ["playlist_not_found", "playlist_dynamic", "playlist_read_only"] {
            XCTAssertEqual(error(reason: reason).retryAction, InboxRetryAction(label: "Riprova senza playlist", dropsPlaylist: true, isPrimary: true), reason)
        }
    }

    func testWhileTheServerKeepsTryingRiprovaIsOnlyASecondChoice() {
        XCTAssertEqual(
            error(reason: "instagram_session", retrying: true).retryAction,
            InboxRetryAction(label: "Riprova comunque", dropsPlaylist: false, isPrimary: false)
        )
    }

    func testInformationHasNothingToRetry() {
        XCTAssertNil(TestSupport.notification("a").retryAction)
        XCTAssertNil(TestSupport.sharedWithYou("n", entry: "r1").retryAction)
    }

    func testTheNoteAfterASuccessfulRiprovaSaysWhenThePlaylistWasLeftOut() {
        XCTAssertEqual(error(reason: "playlist_dynamic").retryAction?.sentNote("Link in analisi, ti avviso"), "Rimandato senza playlist: Link in analisi, ti avviso")
        XCTAssertEqual(error().retryAction?.sentNote("Link in analisi, ti avviso"), "Rimandato: Link in analisi, ti avviso")
    }

    func testTheFootnoteSaysHowAnErrorCloses() {
        XCTAssertEqual(error().errorFootnote, "non scade: resta finché non la togli o il link riesce")
        XCTAssertEqual(error(reason: "instagram_session", retrying: true).errorFootnote, "il server riprova da solo: si chiude quando il link riesce")
    }

    // MARK: what is sent (pure)

    private let kept = InboxRetryOptions(playlistId: "p1", shareWith: ["archi"], comment: "#tesla")
    private func entry(playlist: String?, with: [String], comment: String?) -> ShareLogEntry {
        ShareLogEntry(url: "https://x.test/a", comment: comment, playlistId: playlist, shareWith: with, sentAt: TestSupport.inboxNow)
    }

    func testTheRequestIsTheLinkOfTheError() {
        XCTAssertEqual(
            InboxRetry.request(for: error(), local: nil),
            InboxRetryRequest(url: "https://x.test/a", comment: nil, options: .none)
        )
    }

    func testNoLinkNoRequest() {
        XCTAssertNil(InboxRetry.request(for: error(source: nil), local: nil))
        XCTAssertNil(InboxRetry.request(for: error(source: "  "), local: entry(playlist: "p", with: [], comment: nil)))
    }

    func testThePhonesRecordBeatsTheServersAndTheServersBeatsNothing() {
        let withServer = TestSupport.notification("e", level: .error, sourceUrl: "https://x.test/a", reason: "analysis_failed", options: kept)
        XCTAssertEqual(
            InboxRetry.request(for: withServer, local: entry(playlist: "pl", with: ["sara"], comment: "#l")),
            InboxRetryRequest(url: "https://x.test/a", comment: "#l", options: ShareOptions(playlistId: "pl", shareWith: ["sara"]))
        )
        XCTAssertEqual(
            InboxRetry.request(for: withServer, local: nil),
            InboxRetryRequest(url: "https://x.test/a", comment: "#tesla", options: ShareOptions(playlistId: "p1", shareWith: ["archi"]))
        )
    }

    func testAPlaylistProblemDropsOnlyThePlaylist() {
        let problem = TestSupport.notification("e", level: .error, sourceUrl: "https://x.test/a", reason: "playlist_read_only", options: kept)
        XCTAssertEqual(
            InboxRetry.request(for: problem, local: nil),
            InboxRetryRequest(url: "https://x.test/a", comment: "#tesla", options: ShareOptions(playlistId: nil, shareWith: ["archi"]))
        )
        XCTAssertEqual(
            InboxRetry.request(for: problem, local: entry(playlist: "p7", with: ["sara"], comment: nil))?.options,
            ShareOptions(playlistId: nil, shareWith: ["sara"])
        )
    }
}

/// The badge as the server counts it, worked out from the lists.
final class InboxUnreadTests: XCTestCase {
    private let now = TestSupport.inboxNow
    private func count(_ n: [InboxNotification], _ shares: [ReceivedShare]) -> Int { InboxUnread.count(notifications: n, received: shares, now: now) }
    private func share(_ id: String, seen: Bool = false) -> ReceivedShare { TestSupport.receivedShare(id, seen: seen) }

    func testNothingIsZero() {
        XCTAssertEqual(count([], []), 0)
    }

    func testUnreadNotificationsAndUnseenSharesAreAdded() {
        XCTAssertEqual(count([TestSupport.notification("a"), TestSupport.notification("b", read: now)], [share("r1"), share("r2", seen: true)]), 2)
    }

    func testTheNoticeOfASharedEntryStandsForItsShare() {
        XCTAssertEqual(count([TestSupport.sharedWithYou("n", entry: "r1")], [share("r1")]), 1, "one thing, not two")
    }

    func testOnceTheNoticeIsReadTheShareCountsOnItsOwnUntilItIsSeen() {
        XCTAssertEqual(count([TestSupport.sharedWithYou("n", entry: "r1", read: now)], [share("r1")]), 1)
        XCTAssertEqual(count([TestSupport.sharedWithYou("n", entry: "r1", read: now)], [share("r1", seen: true)]), 0)
    }

    func testANoticeOfAnotherEntryDoesNotHideAShare() {
        XCTAssertEqual(count([TestSupport.sharedWithYou("n", entry: "r9")], [share("r1")]), 2)
    }

    func testOnlyASharedWithYouNoticeStandsForAShare() {
        XCTAssertEqual(count([TestSupport.notification("n", entryId: "r1")], [share("r1")]), 2, "a result notice about the same entry is a different thing")
    }

    func testAnExpiredNoticeDoesNotCountAndDoesNotHideItsShare() {
        let expired = TestSupport.sharedWithYou("n", entry: "r1", expires: now.addingTimeInterval(-1))
        XCTAssertEqual(count([expired], [share("r1")]), 1)
    }

    func testAnUnreadErrorCounts() {
        XCTAssertEqual(count([TestSupport.notification("e", level: .error)], []), 1)
    }
}

final class InboxAnnouncementPolicyTests: XCTestCase {
    private let now = TestSupport.inboxNow

    private func plan(
        _ notifications: [InboxNotification], announced: [String] = [], unread: Int = 1, enabled: Bool = true,
        permission: NotificationPermission = .allowed, visible: Bool = false, push: Bool = false
    ) -> InboxAnnouncementPolicy.Plan {
        InboxAnnouncementPolicy.plan(
            notifications: notifications, announced: announced, unread: unread, now: now, enabled: enabled,
            permission: permission, postaVisible: visible, pushActive: push
        )
    }

    func testOneNewNotificationIsAnnouncedWithItsOwnWords() {
        let n = TestSupport.notification("a", title: "Salvato su SoundReel", body: "2 canzoni, 1 film", entryId: "e9")
        let p = plan([n], unread: 3)
        XCTAssertEqual(p.content?.title, "Salvato su SoundReel")
        XCTAssertEqual(p.content?.body, "2 canzoni, 1 film")
        XCTAssertEqual(p.content?.identifier, "mondrop.inbox.a")
        XCTAssertEqual(p.content?.userInfo, ["inboxId": "a", "entryId": "e9"])
        XCTAssertEqual(p.content?.badge, 3)
        XCTAssertEqual(p.known, ["a"])
    }

    func testSeveralNewOnesAreOneNotification() {
        let list = [
            TestSupport.notification("a", created: now.addingTimeInterval(-300)),
            TestSupport.notification("b", level: .error, created: now.addingTimeInterval(-100)),
            TestSupport.notification("c", created: now.addingTimeInterval(-200)),
        ]
        let p = plan(list, unread: 3)
        XCTAssertEqual(p.content?.title, "SoundReel")
        XCTAssertEqual(p.content?.body, "3 nuove notifiche · 1 con errore")
        XCTAssertEqual(p.content?.identifier, "mondrop.inbox.summary")
        XCTAssertEqual(p.content?.userInfo["inboxId"], "b", "the latest one")
        XCTAssertEqual(Set(p.known), ["a", "b", "c"])
    }

    func testAnnouncedOnceNeverTwice() {
        let n = TestSupport.notification("a")
        XCTAssertNotNil(plan([n]).content)
        XCTAssertNil(plan([n], announced: ["a"]).content)
        XCTAssertEqual(plan([n], announced: ["a"]).known, [])
        let mixed = plan([n, TestSupport.notification("b")], announced: ["a"])
        XCTAssertEqual(mixed.content?.identifier, "mondrop.inbox.b", "only the new one")
    }

    func testWhatIsAlreadyReadIsNotNews() {
        XCTAssertNil(plan([TestSupport.notification("a", read: now)]).content)
    }

    func testSwitchedOffNothingIsPostedButNothingIsLeftToAnnounceLater() {
        let p = plan([TestSupport.notification("a")], enabled: false)
        XCTAssertNil(p.content)
        XCTAssertEqual(p.known, ["a"], "switching it on later must not announce the backlog")
    }

    func testWithoutPermissionNothingIsPosted() {
        XCTAssertNil(plan([TestSupport.notification("a")], permission: .denied).content)
        XCTAssertNil(plan([TestSupport.notification("a")], permission: .notDetermined).content)
    }

    func testWhileTheUserIsReadingTheListNothingIsPosted() {
        let p = plan([TestSupport.notification("a")], visible: true)
        XCTAssertNil(p.content)
        XCTAssertEqual(p.known, ["a"])
    }

    func testWhenThePushRingsTheAppDoesNotAnnounceAgain() {
        let p = plan([TestSupport.notification("a")], push: true)
        XCTAssertNil(p.content)
        XCTAssertEqual(p.known, ["a"])
    }

    func testOldNewsIsNotAnnounced() {
        let stale = TestSupport.notification("a", created: now.addingTimeInterval(-InboxAnnouncementPolicy.maxAge - 60))
        let p = plan([stale])
        XCTAssertNil(p.content, "a first launch must not announce a backlog of days")
        XCTAssertEqual(p.known, ["a"])
        let recent = TestSupport.notification("b", created: now.addingTimeInterval(-InboxAnnouncementPolicy.maxAge + 60))
        XCTAssertNotNil(plan([recent]).content)
    }

    func testAnExpiredNotificationIsNotAnnounced() {
        let expired = TestSupport.notification("a", expires: now.addingTimeInterval(-5))
        XCTAssertNil(plan([expired]).content)
    }

    func testAnErrorIsAnnouncedLikeAnyOther() {
        let p = plan([TestSupport.notification("e", level: .error, title: "Analisi non riuscita", body: "Puoi riprovare.")])
        XCTAssertEqual(p.content?.title, "Analisi non riuscita")
    }

    func testNothingNewMeansNothing() {
        let p = plan([])
        XCTAssertNil(p.content)
        XCTAssertEqual(p.known, [])
    }
}

@MainActor
final class InboxAnnouncerTests: XCTestCase {
    private struct Rig {
        let announcer: InboxAnnouncer
        let center: FakeNotificationCenter
        let store: MemoryAnnouncedIDs
    }

    private func rig(permission: NotificationPermission = .allowed, enabled: Bool = true, push: Bool = false, ids: [String] = []) -> Rig {
        let center = FakeNotificationCenter(permission: permission)
        let store = MemoryAnnouncedIDs(ids)
        let announcer = InboxAnnouncer(
            store: store, center: { center }, isEnabled: { enabled }, pushActive: { push }, now: { TestSupport.inboxNow }
        )
        return Rig(announcer: announcer, center: center, store: store)
    }

    func testItPostsOnceAndRemembersTheId() async {
        let r = rig()
        let n = TestSupport.notification("a")
        await r.announcer.announce([n], unread: 1, postaVisible: false)
        await r.announcer.announce([n], unread: 1, postaVisible: false)
        XCTAssertEqual(r.center.posted.count, 1, "the same notification is never announced twice")
        XCTAssertEqual(r.store.ids, ["a"])
    }

    func testItNeverPromptsForPermission() async {
        let r = rig(permission: .notDetermined)
        await r.announcer.announce([TestSupport.notification("a")], unread: 1, postaVisible: false)
        XCTAssertEqual(r.center.requestCount, 0)
        XCTAssertTrue(r.center.posted.isEmpty)
    }

    func testSwitchedOffPostsNothing() async {
        let r = rig(enabled: false)
        await r.announcer.announce([TestSupport.notification("a")], unread: 1, postaVisible: false)
        XCTAssertTrue(r.center.posted.isEmpty)
        XCTAssertEqual(r.store.ids, ["a"])
    }

    func testAPushThatRangIsNotAnnouncedAgain() async {
        let r = rig(push: true)
        await r.announcer.announce([TestSupport.notification("a")], unread: 1, postaVisible: false)
        XCTAssertTrue(r.center.posted.isEmpty)
    }

    func testAPushThatArrivedWhileTheAppRanIsRememberedBeforeTheReading() async {
        let r = rig()
        r.announcer.markAnnounced("a")
        await r.announcer.announce([TestSupport.notification("a")], unread: 1, postaVisible: false)
        XCTAssertTrue(r.center.posted.isEmpty)
    }

    func testTheMemoryIsBounded() async {
        let r = rig(ids: (0..<InboxAnnouncementPolicy.memory).map { "old\($0)" })
        await r.announcer.announce([TestSupport.notification("fresh")], unread: 1, postaVisible: false)
        XCTAssertEqual(r.store.ids.count, InboxAnnouncementPolicy.memory)
        XCTAssertEqual(r.store.ids.last, "fresh")
        XCTAssertFalse(r.store.ids.contains("old0"), "the oldest went out")
    }

    func testWithoutACenterNothingHappens() async {
        let store = MemoryAnnouncedIDs()
        let announcer = InboxAnnouncer(store: store, center: { nil }, isEnabled: { true })
        await announcer.announce([TestSupport.notification("a", created: TestSupport.inboxNow)], unread: 1, postaVisible: false)
        XCTAssertEqual(store.ids, ["a"])
    }

    func testTheModelAnnouncesWhatItReadsAndNeverTwice() async throws {
        let center = FakeNotificationCenter(permission: .allowed)
        let announcer = InboxAnnouncer(store: MemoryAnnouncedIDs(), center: { center }, isEnabled: { true }, now: { TestSupport.inboxNow })
        let inbox = FakeInbox([
            InboxSnapshot(notifications: [TestSupport.notification("a")], unread: 1, serverTime: "T1"),
            InboxSnapshot(notifications: [TestSupport.notification("a"), TestSupport.notification("b")], unread: 2, serverTime: "T2"),
        ])
        let model = InboxModel(
            transport: inbox, sender: FakeShareSender(), log: ShareLog(url: try TestSupport.tempFile("log.json")),
            badge: FakeBadge(), announcer: announcer, now: { TestSupport.inboxNow }
        )
        await model.refresh(.launch)
        await model.refresh(.open)
        XCTAssertEqual(center.posted.map(\.identifier), ["mondrop.inbox.a", "mondrop.inbox.b"])
    }

    func testWhileTheTabIsOnScreenTheModelDoesNotAnnounce() async throws {
        let center = FakeNotificationCenter(permission: .allowed)
        let announcer = InboxAnnouncer(store: MemoryAnnouncedIDs(), center: { center }, isEnabled: { true }, now: { TestSupport.inboxNow })
        let model = InboxModel(
            transport: FakeInbox([InboxSnapshot(notifications: [TestSupport.notification("a")], unread: 1, serverTime: "T")]),
            sender: FakeShareSender(), log: ShareLog(url: try TestSupport.tempFile("log.json")),
            badge: FakeBadge(), announcer: announcer, now: { TestSupport.inboxNow }
        )
        await model.refresh(.open, postaVisible: true)
        XCTAssertTrue(center.posted.isEmpty)
    }
}
