import XCTest
@testable import Mondrop

/// The gate between what the sync of the playing playlist WANTS to download and what it may (Michele, 11 November: «Il sync deve girare solo per playlist che
/// sto suonando», with the earlier «Se sono molti gb deve avvisare oppure limitare»; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U2):
/// under the limit everything goes without a word, over it the user is asked, and what was answered holds for the rest of that playlist's sync.
@MainActor
final class PlayingSyncGateTests: XCTestCase {
    private let mb = 1_000_000
    private let gb = 1_000_000_000

    /// Answers the questions it is asked with `answers` (in order; `.all` when they run out) and keeps them.
    private final class Asker {
        var questions: [SyncSizeQuestion] = []
        var answers: [SyncSizeChoice?]

        init(_ answers: [SyncSizeChoice?]) { self.answers = answers }

        func ask(_ question: SyncSizeQuestion) async -> SyncSizeChoice? {
            questions.append(question)
            return answers.isEmpty ? .all : answers.removeFirst()
        }
    }

    private func make(limit: SyncWarnLimit = .gb2, answers: [SyncSizeChoice?] = [], declines: SyncDeclines = SyncDeclines()) -> (PlayingSyncGate, Asker, SyncDeclines) {
        let asker = Asker(answers)
        let gate = PlayingSyncGate(playlistId: "pl", limit: { limit }, declines: declines, ask: { await asker.ask($0) })
        return (gate, asker, declines)
    }

    private func songs(_ sizes: [Int?], prefix: String = "s") -> [OfflineTrack] {
        sizes.enumerated().map { TestSupport.track("\(prefix)\($0.offset)", bytes: $0.element) }
    }

    private let manifest = TestSupport.manifest("pl", [])

    private func keys(_ tracks: [OfflineTrack]) -> [String] { tracks.map(\.songKey) }

    // MARK: under the limit

    func testUnderTheLimitEverythingGoesWithoutAQuestion() async {
        let (gate, asker, _) = make()
        let wanted = songs([500 * mb, 500 * mb, 500 * mb])
        let admitted = await gate.admit(wanted, in: manifest)
        XCTAssertEqual(keys(admitted), ["s0", "s1", "s2"])
        XCTAssertTrue(asker.questions.isEmpty)
        XCTAssertFalse(gate.isClosed)
    }

    func testExactlyTheLimitIsStillUnderIt() async {
        let (gate, asker, _) = make()
        let admitted = await gate.admit(songs([gb, gb]), in: manifest)
        XCTAssertEqual(admitted.count, 2)
        XCTAssertTrue(asker.questions.isEmpty)
    }

    func testNothingWantedIsNothingToAsk() async {
        let (gate, asker, _) = make(limit: .gb1)
        let admitted = await gate.admit([], in: manifest)
        XCTAssertTrue(admitted.isEmpty)
        XCTAssertTrue(asker.questions.isEmpty)
        XCTAssertFalse(gate.isClosed, "an empty round closes nothing: songs may turn ready later")
    }

    func testWithTheLimitSetToNeverItNeverAsks() async {
        let (gate, asker, _) = make(limit: .never)
        let admitted = await gate.admit(songs([40 * gb, 40 * gb]), in: manifest)
        XCTAssertEqual(admitted.count, 2)
        XCTAssertTrue(asker.questions.isEmpty)
    }

    func testASongWhoseSizeIsNotKnownWeighsNothingButIsStillAdmitted() async {
        let (gate, asker, _) = make()
        let admitted = await gate.admit(songs([nil, nil, gb]), in: manifest)
        XCTAssertEqual(admitted.count, 3)
        XCTAssertTrue(asker.questions.isEmpty)
    }

    // MARK: over the limit it asks

    func testOverTheLimitItAsksOnceSayingWhichPlaylistHowManySongsAndHowMuch() async {
        let (gate, asker, _) = make(answers: [.all])
        _ = await gate.admit(songs([gb, gb, gb]), in: manifest)
        XCTAssertEqual(asker.questions.count, 1)
        let question = asker.questions[0]
        XCTAssertEqual(question.songs, 3)
        XCTAssertEqual(question.bytes, 3 * gb)
        XCTAssertEqual(question.limit, .gb2)
        XCTAssertEqual(question.playlistName, "Playlist pl")
    }

    func testAllAdmitsEverythingAndTheLaterWavesToo() async {
        let (gate, asker, _) = make(answers: [.all])
        let first = await gate.admit(songs([gb, gb, gb], prefix: "a"), in: manifest)
        XCTAssertEqual(keys(first), ["a0", "a1", "a2"])
        XCTAssertFalse(gate.isClosed)
        // songs that turn ready later: the user already said «Scarica tutto» for this playlist
        let later = await gate.admit(songs([10 * gb], prefix: "b"), in: manifest)
        XCTAssertEqual(keys(later), ["b0"])
        XCTAssertEqual(asker.questions.count, 1, "asked once")
    }

    func testLimitAdmitsTheSongsInOrderUntilTheLimitAndClosesTheGate() async {
        let (gate, asker, declines) = make(answers: [.limit])
        let admitted = await gate.admit(songs([gb, gb, gb, gb]), in: manifest)
        XCTAssertEqual(keys(admitted), ["s0", "s1"], "the first 2 GB, in the order of the playlist")
        XCTAssertTrue(gate.isClosed, "nothing more is admitted: the rest stays online")
        let later = await gate.admit(songs([100 * mb], prefix: "later"), in: manifest)
        XCTAssertTrue(later.isEmpty)
        XCTAssertEqual(asker.questions.count, 1)
        XCTAssertFalse(declines.isDeclined("pl"), "«Limita» is not «Annulla»")
    }

    func testLimitStopsAtTheFirstSongThatDoesNotFit() async {
        let (gate, _, _) = make(answers: [.limit])
        let admitted = await gate.admit(songs([gb, 1_500 * mb, 100 * mb, 100 * mb]), in: manifest)
        XCTAssertEqual(keys(admitted), ["s0"], "the order is the promise: a small song further down does not jump the queue")
    }

    func testCancelAdmitsNothingClosesTheGateAndRemembersThePlaylistWasDeclined() async {
        let (gate, asker, declines) = make(answers: [.cancel])
        let admitted = await gate.admit(songs([gb, gb, gb]), in: manifest)
        XCTAssertTrue(admitted.isEmpty)
        XCTAssertTrue(gate.isClosed)
        XCTAssertTrue(declines.isDeclined("pl"))
        let later = await gate.admit(songs([gb], prefix: "later"), in: manifest)
        XCTAssertTrue(later.isEmpty)
        XCTAssertEqual(asker.questions.count, 1)
    }

    func testAQuestionThatWasWithdrawnAdmitsNothingAndIsNotRemembered() async {
        // the user went on to another playlist before answering: nothing was said about this one
        let (gate, _, declines) = make(answers: [nil])
        let admitted = await gate.admit(songs([gb, gb, gb]), in: manifest)
        XCTAssertTrue(admitted.isEmpty)
        XCTAssertTrue(gate.isClosed)
        XCTAssertFalse(declines.isDeclined("pl"))
    }

    // MARK: the waves after a sync that needed no question

    func testALaterWaveThatIsOverTheLimitOnItsOwnAsks() async {
        let (gate, asker, _) = make(answers: [.limit])
        let first = await gate.admit(songs([500 * mb], prefix: "a"), in: manifest)
        XCTAssertEqual(first.count, 1)
        XCTAssertTrue(asker.questions.isEmpty)
        let second = await gate.admit(songs([gb, gb, gb], prefix: "b"), in: manifest)
        XCTAssertEqual(asker.questions.count, 1, "the songs that turned ready later are over the limit: asked")
        XCTAssertEqual(keys(second), ["b0", "b1"])
    }

    func testALaterWaveUnderTheLimitGoesWithoutAQuestion() async {
        let (gate, asker, _) = make()
        _ = await gate.admit(songs([gb], prefix: "a"), in: manifest)
        let second = await gate.admit(songs([gb], prefix: "b"), in: manifest)
        XCTAssertEqual(second.count, 1)
        XCTAssertTrue(asker.questions.isEmpty)
    }

    // MARK: closing from outside

    func testAClosedGateAdmitsNothingAndAsksNothing() async {
        let (gate, asker, declines) = make()
        gate.close()
        let admitted = await gate.admit(songs([gb, gb, gb]), in: manifest)
        XCTAssertTrue(admitted.isEmpty)
        XCTAssertTrue(asker.questions.isEmpty)
        XCTAssertTrue(gate.isClosed)
        XCTAssertFalse(declines.isDeclined("pl"), "closing from outside (the playlist is no longer the one that plays) is no answer")
    }

    // MARK: what is remembered

    func testAPlaylistIsDeclinedForAsLongAsTheMemoryLives() {
        let declines = SyncDeclines()
        XCTAssertFalse(declines.isDeclined("a"))
        declines.decline("a")
        XCTAssertTrue(declines.isDeclined("a"))
        XCTAssertFalse(declines.isDeclined("b"))
        XCTAssertFalse(SyncDeclines().isDeclined("a"), "a new memory (the app opened again) remembers nothing")
    }
}
