import XCTest
@testable import Mondrop

/// «Su Mondrop le playlist e i brani devono essere in ordine di scaricati in locale e poi online. […] Vanno privilegiati i file già scaricati.» (Michele, 11 November,
/// trying build 16; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U10): what is on the phone comes before what is online, and what failed comes
/// last; inside each group the order is the one the server gave. These tables are the rule.
final class LocalFirstTests: XCTestCase {
    private func tracks(_ keys: [String]) -> [OfflineTrack] { keys.map { TestSupport.track($0) } }

    /// The state of a song from what the phone knows: the keys of its files and the downloads that went wrong.
    private func state(local: Set<String> = [], failed: Set<String> = [], downloading: [String: Double] = [:]) -> (OfflineTrack) -> SongState {
        { track in
            let progress: TrackProgress? = failed.contains(track.songKey) ? .failed("boom") : downloading[track.songKey].map { .downloading($0) }
            return SongState(TrackRowStatus.make(track: track, isLocal: local.contains(track.songKey), progress: progress))
        }
    }

    private func keys(_ list: [OfflineTrack]) -> [String] { list.map(\.songKey) }

    // MARK: the songs of a list

    func testTheSongsOnThePhoneComeFirstTheOnlineOnesAfterThemAndTheErrorsLast() {
        let list = tracks(["a", "b", "c", "d", "e", "f"])
        let ordered = LocalFirst.songs(list, state: state(local: ["c", "e"], failed: ["a"], downloading: ["d": 0.4]))
        XCTAssertEqual(keys(ordered), ["c", "e", "b", "d", "f", "a"], "on the phone: c e; online (a download in progress is online): b d f; error: a")
    }

    func testInsideEachGroupTheOrderOfTheServerIsKept() {
        let list = tracks(["z", "y", "x", "w", "v", "u"])
        let ordered = LocalFirst.songs(list, state: state(local: ["w", "z", "u"]))
        XCTAssertEqual(keys(ordered), ["z", "w", "u", "y", "x", "v"], "stable: no group is sorted by name or by anything else")
    }

    func testAListThatIsAlreadyInOrderOrOfOneGroupDoesNotChange() {
        let list = tracks(["a", "b", "c"])
        XCTAssertEqual(keys(LocalFirst.songs(list, state: state(local: ["a", "b", "c"]))), ["a", "b", "c"], "all on the phone")
        XCTAssertEqual(keys(LocalFirst.songs(list, state: state())), ["a", "b", "c"], "all online")
        XCTAssertEqual(keys(LocalFirst.songs(list, state: state(local: ["a"]))), ["a", "b", "c"], "already in order")
        XCTAssertEqual(LocalFirst.songs([], state: state()), [])
    }

    func testNothingIsDroppedOrRepeated() {
        let list = tracks((0..<40).map { "k\($0)" })
        let local = Set((0..<40).filter { $0 % 3 == 0 }.map { "k\($0)" })
        let ordered = LocalFirst.songs(list, state: state(local: local, failed: ["k7", "k8"]))
        XCTAssertEqual(ordered.count, 40)
        XCTAssertEqual(Set(keys(ordered)), Set(keys(list)))
    }

    func testTheRankOfTheThreeStates() {
        XCTAssertEqual(LocalFirst.rank(.local), 0)
        XCTAssertEqual(LocalFirst.rank(.online(percent: nil)), 1)
        XCTAssertEqual(LocalFirst.rank(.online(percent: 40)), 1, "a download in progress is online: it is not on the phone yet")
        XCTAssertEqual(LocalFirst.rank(.error("errore")), 2)
    }

    // MARK: the playlists

    private func record(_ keys: [String]) -> OfflineStore.PlaylistRecord { OfflineStore.PlaylistRecord(songKeys: keys) }

    func testAPlaylistWithEverySongOnThePhoneIsFirstThenOneWithSomeThenOneWithNone() {
        let local: Set<String> = ["a1", "a2", "b1"]
        XCTAssertEqual(LocalFirst.rank(songCount: 2, record: record(["a1", "a2"]), local: local), 0, "every song")
        XCTAssertEqual(LocalFirst.rank(songCount: 3, record: record(["b1", "b2", "b3"]), local: local), 1, "some of them")
        XCTAssertEqual(LocalFirst.rank(songCount: 2, record: record(["c1", "c2"]), local: local), 2, "none: it is online")
    }

    func testAPlaylistThePhoneHasNotReadIsOnlineIfTheServerSaysItHasSongsAndLastIfItHasNone() {
        XCTAssertEqual(LocalFirst.rank(songCount: 12, record: nil, local: ["a"]), 2)
        XCTAssertEqual(LocalFirst.rank(songCount: 0, record: nil, local: ["a"]), 3)
        XCTAssertEqual(LocalFirst.rank(songCount: 0, record: record([]), local: ["a"]), 3, "a playlist with no songs has nothing on the phone and nothing online")
    }

    func testThePlaylistsAreOrderedByHowMuchOfThemIsOnThePhoneAndTheServersOrderDecidesTheRest() {
        struct P: Equatable { let id: String; let count: Int }
        let list = [P(id: "none1", count: 2), P(id: "some1", count: 3), P(id: "all1", count: 2), P(id: "empty", count: 0), P(id: "all2", count: 1), P(id: "none2", count: 5), P(id: "some2", count: 2)]
        let records = [
            "none1": record(["n1", "n2"]), "some1": record(["s1", "x1", "x2"]), "all1": record(["l1", "l2"]), "empty": record([]),
            "all2": record(["l3"]), "none2": record(["m1", "m2", "m3", "m4", "m5"]), "some2": record(["l1", "x9"]),
        ]
        let marks = PlaylistMarks(records: records, local: ["s1", "l1", "l2", "l3"], failedOnPhone: [])
        let ordered = marks.ordered(list, id: \.id, songCount: \.count)
        XCTAssertEqual(ordered.map(\.id), ["all1", "all2", "some1", "some2", "none1", "none2", "empty"])
    }

    func testAnErrorOnAPlaylistDoesNotSinkItWhatCountsIsHowMuchIsOnThePhone() {
        // the mark of a playlist with a failed song is the error mark, but the order is about where the files are: «a» has one song of two on the phone, «c» has none
        struct P { let id: String; let count: Int }
        let marks = PlaylistMarks(
            records: ["a": OfflineStore.PlaylistRecord(songKeys: ["x", "y"], failedKeys: ["y"]), "c": record(["m", "n"])],
            local: ["x"], failedOnPhone: []
        )
        let ordered = marks.ordered([P(id: "c", count: 2), P(id: "a", count: 2)], id: \.id, songCount: \.count)
        XCTAssertEqual(ordered.map(\.id), ["a", "c"])
    }

    func testTheGenericStablePartitionKeepsEverythingAndTheOrder() {
        XCTAssertEqual(LocalFirst.stable([5, 4, 3, 2, 1], rank: { $0 % 2 }), [4, 2, 5, 3, 1])
        XCTAssertEqual(LocalFirst.stable([Int](), rank: { $0 }), [])
        XCTAssertEqual(LocalFirst.stable([1, 2, 3], rank: { _ in 7 }), [1, 2, 3])
    }
}
