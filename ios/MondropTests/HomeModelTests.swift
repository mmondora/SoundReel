import XCTest
@testable import Mondrop

/// The Home: the greeting, the «Riprendi» card, the state of the screen, and loading (spec 2026-11-08-mondrop-home-spotify-design.md H1, H4, H7).
@MainActor
final class HomeModelTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    // MARK: fakes

    private final class FakeHome: HomeTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var script: [Result<HomeResponse, Error>]
        private var _calls = 0
        var calls: Int { lock.withLock { _calls } }

        init(_ script: [Result<HomeResponse, Error>]) { self.script = script }

        func home() async throws -> HomeResponse {
            let next: Result<HomeResponse, Error> = lock.withLock {
                _calls += 1
                return script.count > 1 ? script.removeFirst() : script[0]
            }
            return try next.get()
        }
    }

    /// Does not answer until released: to see what a second `load()` does while the first is waiting.
    private final class SlowHome: HomeTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var _calls = 0
        private var waiters: [CheckedContinuation<Void, Never>] = []
        var calls: Int { lock.withLock { _calls } }

        func home() async throws -> HomeResponse {
            lock.withLock { _calls += 1 }
            await withCheckedContinuation { continuation in lock.withLock { waiters.append(continuation) } }
            return HomeResponse(user: "mike", displayName: "Michele", sections: [])
        }

        func release() {
            let pending = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
                let all = waiters
                waiters = []
                return all
            }
            pending.forEach { $0.resume() }
        }
    }

    private func tracks(_ keys: String...) -> [OfflineTrack] { keys.map { TestSupport.track($0) } }

    private func response(name: String? = "Michele", _ sections: [HomeSection]) -> HomeResponse {
        HomeResponse(user: "mike", displayName: name, sections: sections)
    }

    private let recent = { (keys: [OfflineTrack]) in HomeSection(id: "recent", title: "Ascoltati di recente", kind: .tracks, tracks: keys) }

    // MARK: the greeting

    func testTheGreetingFollowsTheHourOfThePhone() {
        let expected: [(Int, String)] = [
            (0, "Buonasera"), (4, "Buonasera"), (5, "Buongiorno"), (9, "Buongiorno"), (12, "Buongiorno"),
            (13, "Buon pomeriggio"), (17, "Buon pomeriggio"), (18, "Buonasera"), (23, "Buonasera"),
        ]
        for (hour, word) in expected {
            XCTAssertEqual(HomeGreeting.word(hour: hour), word, "at \(hour)")
        }
    }

    func testTheGreetingUsesTheNameWhenThereIsOne() {
        XCTAssertEqual(HomeGreeting.make(hour: 9, name: "Michele"), "Buongiorno, Michele")
        XCTAssertEqual(HomeGreeting.make(hour: 20, name: "  Sara \n"), "Buonasera, Sara")
        XCTAssertEqual(HomeGreeting.make(hour: 9, name: nil), "Buongiorno")
        XCTAssertEqual(HomeGreeting.make(hour: 9, name: "   "), "Buongiorno")
    }

    func testTheGreetingReadsTheHourInTheCalendarItIsGiven() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Rome")!
        let evening = calendar.date(from: DateComponents(year: 2026, month: 11, day: 8, hour: 19, minute: 30))!
        XCTAssertEqual(HomeGreeting.make(at: evening, calendar: calendar, name: "Michele"), "Buonasera, Michele")
    }

    // MARK: «Riprendi»

    private func queue(_ n: Int) -> [QueueItem] {
        (1...n).map { QueueItem(songKey: "a::t\($0)", title: "t\($0)", artist: "a", coverPath: "/c/\($0)") }
    }

    func testThereIsNothingToResumeWithoutAQueue() {
        XCTAssertNil(ResumeCard.make(queue: [], index: 0, label: nil, currentTime: 0, duration: 0, playing: false))
        XCTAssertNil(ResumeCard.make(queue: queue(3), index: 3, label: nil, currentTime: 0, duration: 0, playing: false))
        XCTAssertNil(ResumeCard.make(queue: queue(3), index: -1, label: nil, currentTime: 0, duration: 0, playing: false))
    }

    func testTheCardIsTheSongTheQueuePointsAtAndWhereInTheQueueItIs() throws {
        let card = try XCTUnwrap(ResumeCard.make(queue: queue(7), index: 1, label: "Playlist · Road trip", currentTime: 30, duration: 120, playing: false))
        XCTAssertEqual(card.songKey, "a::t2")
        XCTAssertEqual(card.title, "t2")
        XCTAssertEqual(card.artist, "a")
        XCTAssertEqual(card.coverPath, "/c/2")
        XCTAssertEqual(card.queueLine, "Playlist · Road trip · 2 / 7")
        XCTAssertEqual(card.progress, 0.25, accuracy: 0.0001)
        XCTAssertFalse(card.isPlaying)
    }

    func testTheLineHasOnlyWhatThereIs() throws {
        func line(_ n: Int, _ label: String?) throws -> String {
            try XCTUnwrap(ResumeCard.make(queue: queue(n), index: 0, label: label, currentTime: 0, duration: 0, playing: true)).queueLine
        }
        XCTAssertEqual(try line(5, nil), "1 / 5")
        XCTAssertEqual(try line(1, "Brano · t1"), "Brano · t1")
        XCTAssertEqual(try line(1, nil), "In coda")
        XCTAssertEqual(try line(3, "   "), "1 / 3")
    }

    func testTheProgressStaysBetweenZeroAndOneWhateverTheTimes() throws {
        func progress(_ time: Double, _ duration: Double) throws -> Double {
            try XCTUnwrap(ResumeCard.make(queue: queue(1), index: 0, label: nil, currentTime: time, duration: duration, playing: false)).progress
        }
        XCTAssertEqual(try progress(10, 0), 0)                 // the length is not known yet
        XCTAssertEqual(try progress(500, 100), 1)
        XCTAssertEqual(try progress(-5, 100), 0)
        XCTAssertEqual(try progress(.nan, 100), 0)
        XCTAssertEqual(try progress(10, .infinity), 0)
    }

    // MARK: the state of the screen

    func testTheScreenStateComesFromWhatThereIsToShow() {
        let one = [recent(tracks("a::b"))]
        XCTAssertEqual(HomeScreenState.make(phase: .idle, sections: []), .loading)
        XCTAssertEqual(HomeScreenState.make(phase: .loading, sections: []), .loading)
        XCTAssertEqual(HomeScreenState.make(phase: .loaded, sections: []), .empty)
        XCTAssertEqual(HomeScreenState.make(phase: .failed("HTTP 500"), sections: []), .failed("HTTP 500"))
        // A stale Home stays on screen whatever happens to the reload.
        XCTAssertEqual(HomeScreenState.make(phase: .loaded, sections: one), .sections)
        XCTAssertEqual(HomeScreenState.make(phase: .loading, sections: one), .sections)
        XCTAssertEqual(HomeScreenState.make(phase: .failed("offline"), sections: one), .sections)
    }

    // MARK: loading

    func testItLoadsTheSectionsTheServerSentInItsOrder() async {
        let playlists = HomeSection(id: "playlists", title: "Le tue playlist", kind: .playlists, playlists: [HomePlaylist(id: "p", name: "P", songCount: 1)])
        let model = HomeModel(transport: FakeHome([.success(response([playlists, recent(tracks("a::b"))]))]))
        await model.load()
        XCTAssertEqual(model.phase, .loaded)
        XCTAssertEqual(model.sections.map(\.id), ["playlists", "recent"])
        XCTAssertEqual(model.displayName, "Michele")
        XCTAssertEqual(model.state, .sections)
        XCTAssertNil(model.failure)
    }

    func testItDropsWhatTheScreenCannotDraw() async {
        let unknown = HomeSection(id: "x", title: "?", kind: .unknown("carousel"))
        let empty = HomeSection(id: "recent", title: "R", kind: .tracks)
        let model = HomeModel(transport: FakeHome([.success(response([unknown, empty]))]))
        await model.load()
        XCTAssertTrue(model.sections.isEmpty)
        XCTAssertEqual(model.state, .empty)
    }

    func testABlankNameIsNoName() async {
        let model = HomeModel(transport: FakeHome([.success(response(name: "  ", [recent(tracks("a::b"))]))]))
        await model.load()
        XCTAssertNil(model.displayName)
    }

    func testAFirstFailureLeavesNothingToShowAndSaysWhy() async {
        let model = HomeModel(transport: FakeHome([.failure(MondropAPIError.http(500, "boom"))]))
        await model.load()
        XCTAssertEqual(model.state, .failed("HTTP 500: boom"))
        XCTAssertEqual(model.failure, "HTTP 500: boom")
    }

    func testAFailedReloadKeepsWhatWasOnScreen() async {
        let transport = FakeHome([.success(response([recent(tracks("a::b"))])), .failure(MondropAPIError.transport("offline"))])
        let model = HomeModel(transport: transport)
        await model.load()
        await model.load()
        XCTAssertEqual(model.sections.map(\.id), ["recent"])
        XCTAssertEqual(model.state, .sections)
        XCTAssertEqual(model.failure, "offline")
        // And the next reload that works clears the line.
        let again = HomeModel(transport: FakeHome([.failure(MondropAPIError.transport("offline")), .success(response([recent(tracks("a::b"))]))]))
        await again.load()
        await again.load()
        XCTAssertNil(again.failure)
    }

    func testAnOlderServerThatDoesNotKnowTheRouteIsAFailureNotACrash() async {
        let model = HomeModel(transport: FakeHome([.failure(MondropAPIError.http(404, "not found"))]))
        await model.load()
        XCTAssertEqual(model.state, .failed("HTTP 404: not found"))
    }

    func testLeavingTheScreenIsNotAFailure() async {
        let first = HomeModel(transport: FakeHome([.failure(CancellationError())]))
        await first.load()
        XCTAssertEqual(first.phase, .idle)
        XCTAssertNil(first.failure)

        let second = HomeModel(transport: FakeHome([.success(response([recent(tracks("a::b"))])), .failure(URLError(.cancelled))]))
        await second.load()
        await second.load()
        XCTAssertEqual(second.phase, .loaded)
        XCTAssertNil(second.failure)
    }

    func testOneLoadAtATime() async {
        let slow = SlowHome()
        let model = HomeModel(transport: slow)
        let first = Task { await model.load() }
        for _ in 0..<200 where slow.calls == 0 { await Task.yield() }
        XCTAssertEqual(slow.calls, 1)
        XCTAssertEqual(model.phase, .loading)
        // Asked again while the first one waits: nothing new goes out. (Not awaited here: without the guard the second load would wait
        // for an answer that only comes below, and the test would hang instead of failing.)
        let second = Task { await model.load() }
        for _ in 0..<100 { await Task.yield() }
        XCTAssertEqual(slow.calls, 1, "a second load while one is on its way must not ask the server again")
        slow.release()
        await first.value
        await second.value
        XCTAssertEqual(model.phase, .loaded)
        XCTAssertEqual(slow.calls, 1)
    }
}
