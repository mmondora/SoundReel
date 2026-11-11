import XCTest
@testable import Mondrop

/// «Inoltre su una playlist voglio anche il bottone 'scarica tutta'» (Michele, 11 November, after build 18; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md
/// §12, U20): what the button of the page of a playlist says, and whether it is there at all.
final class PlaylistDownloadStateTests: XCTestCase {
    private let mb = 1_000_000

    private func ready(_ key: String, _ megabytes: Int) -> OfflineTrack { TestSupport.track(key, state: "ready", bytes: megabytes * mb) }

    private func make(
        _ tracks: [OfflineTrack], local: Set<String> = [], skipped: Set<String> = [], progress: [String: TrackProgress] = [:], busy: Bool = false
    ) -> PlaylistDownloadState.Kind {
        PlaylistDownloadState.make(
            tracks: tracks, isLocal: { local.contains($0) }, isSkipped: { skipped.contains($0) }, progress: { progress[$0] }, busy: busy
        ).kind
    }

    private func size(_ bytes: Int) -> String { ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file) }

    // MARK: whether there is a button

    func testAPlaylistThatIsAllOnThePhoneHasNoButton() {
        XCTAssertEqual(make([ready("a", 10), ready("b", 10)], local: ["a", "b"]), .none)
    }

    func testAnEmptyPlaylistHasNoButton() {
        XCTAssertEqual(make([]), .none)
    }

    func testASongTwiceInTheListCountsOnce() {
        XCTAssertEqual(make([ready("a", 10), ready("a", 10)]), .available(songs: 1, bytes: 10 * mb))
    }

    func testWhatIsMissingCanBeBroughtAndItsSizeIsTheOneOfTheSongsSoundReelHasReady() {
        let tracks = [ready("a", 10), ready("b", 100), ready("c", 300), TestSupport.track("d", state: "preparing", bytes: nil)]
        XCTAssertEqual(make(tracks, local: ["a"]), .available(songs: 3, bytes: 400 * mb))
    }

    func testASongSoundReelHasNotPreparedYetStillCountsAndWeighsNothing() {
        XCTAssertEqual(make([TestSupport.track("a", state: "missing", bytes: nil)]), .available(songs: 1, bytes: 0))
    }

    func testASongTheServerCannotGiveIsNotCountedItHasItsOwnRetryOnTheRow() {
        let stuck = [TestSupport.track("b", state: "failed", bytes: nil), TestSupport.track("c", state: "no_source", bytes: nil)]
        XCTAssertEqual(make(stuck), .none)
        XCTAssertEqual(make([ready("a", 10)] + stuck), .available(songs: 1, bytes: 10 * mb))
    }

    func testWhatThePersonTookOffThePhoneOnPurposeIsNotCounted() {
        XCTAssertEqual(make([ready("a", 10), ready("b", 20)], skipped: ["b"]), .available(songs: 1, bytes: 10 * mb))
        XCTAssertEqual(make([ready("b", 20)], skipped: ["b"]), .none)
    }

    func testADownloadThatFailedOnThePhoneCanBeTriedAgain() {
        XCTAssertEqual(make([ready("a", 10)], progress: ["a": .failed("rete")]), .available(songs: 1, bytes: 10 * mb))
    }

    // MARK: at work

    func testWhileASyncIsAtWorkTheButtonSaysHowManyAreLeft() {
        XCTAssertEqual(make([ready("a", 10), ready("b", 10), ready("c", 10)], local: ["c"], busy: true), .working(left: 2))
    }

    func testSongsOnTheirWayCountAsWorkEvenWithNoSyncAtWork() {
        let tracks = [ready("a", 10), ready("b", 10), ready("c", 10)]
        XCTAssertEqual(make(tracks, local: ["c"], progress: ["a": .downloading(0.5), "b": .queued]), .working(left: 2))
    }

    func testNothingLeftIsNoButtonEvenWhileBusy() {
        XCTAssertEqual(make([ready("a", 10)], local: ["a"], busy: true), .none)
    }

    // MARK: the words

    func testTheButtonSaysWhatItWouldBring() {
        let state = PlaylistDownloadState(kind: .available(songs: 5, bytes: 420 * mb))
        XCTAssertEqual(state.title, "Scarica tutta")
        XCTAssertEqual(state.detail, "5 brani · \(size(420 * mb))")
        let one = PlaylistDownloadState(kind: .available(songs: 1, bytes: 0))
        XCTAssertEqual(one.title, "Scarica tutta")
        XCTAssertEqual(one.detail, "1 brano", "no size is invented when SoundReel said none")
    }

    func testWhileItWorksTheButtonSaysSoAndHowManyAreLeft() {
        XCTAssertEqual(PlaylistDownloadState(kind: .working(left: 3)).title, "Scarico…")
        XCTAssertEqual(PlaylistDownloadState(kind: .working(left: 3)).detail, "ancora 3 brani")
        XCTAssertEqual(PlaylistDownloadState(kind: .working(left: 1)).detail, "ancora 1 brano")
    }

    func testNoButtonHasNoWords() {
        XCTAssertNil(PlaylistDownloadState(kind: .none).detail)
    }
}
