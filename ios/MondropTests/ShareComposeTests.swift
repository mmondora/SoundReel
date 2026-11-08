import XCTest
@testable import Mondrop

/// The state of the share sheet: what it offers, what it sends, and the phases «Invia a SoundReel» → success | «Riprova».
@MainActor
final class ShareComposeModelTests: XCTestCase {
    private let spotify = URL(string: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc")!
    private let article = URL(string: "https://www.repubblica.it/articolo")!

    private struct Rig {
        let model: ShareComposeModel
        let sender: FakeShareSender
        let cache: PlaylistsCache
        let log: ShareLog
        let remembered: Remembered
    }

    private final class Remembered {
        var tags: [[String]] = []
    }

    private func rig(
        url: URL?, user: String = "mike", defaults: [String] = [], recent: [String] = [],
        playlists: [MondropPlaylist]? = [
            MondropPlaylist(id: "p1", name: "Road trip", songCount: 5, canEdit: true),
            MondropPlaylist(id: "p2", name: "Anni 80", songCount: 9, canEdit: true),
            MondropPlaylist(id: "p3", name: "Di sara", songCount: 3, canEdit: false),
        ],
        results: [Result<ShareResponse, Error>] = [.success(ShareResponse(success: true, status: "queued", kind: "generic"))]
    ) throws -> Rig {
        let cache = PlaylistsCache(url: try TestSupport.tempFile("playlists-cache.json"))
        if let playlists { cache.store(playlists, user: user) }
        let log = ShareLog(url: try TestSupport.tempFile("share-log.json"))
        let sender = FakeShareSender(results)
        let remembered = Remembered()
        let model = ShareComposeModel(
            url: url,
            context: ShareContext(user: user, defaultShareWith: defaults, recentTags: recent),
            sender: sender, cache: cache, log: log,
            rememberTags: { tags in remembered.tags.append(tags); return tags },
            now: { Date(timeIntervalSince1970: 1_794_000_000) }
        )
        return Rig(model: model, sender: sender, cache: cache, log: log, remembered: remembered)
    }

    // MARK: what the sheet offers (SH4, SH6)

    func testAMusicLinkOffersTheEditablePlaylistsAndTheDefaultIsNone() throws {
        let r = try rig(url: spotify)
        XCTAssertTrue(r.model.showsPlaylistPicker)
        XCTAssertEqual(r.model.playlists.map(\.name), ["Road trip", "Anni 80"], "only the ones the user may edit")
        XCTAssertNil(r.model.selectedPlaylist, "default «Nessuna»")
        XCTAssertNil(r.model.options.playlistId)
    }

    func testAnOrdinaryLinkHasNoPlaylistPicker() throws {
        let r = try rig(url: article)
        XCTAssertFalse(r.model.showsPlaylistPicker)
        XCTAssertNil(r.model.playlistHint)
        XCTAssertTrue(r.model.playlists.isEmpty)
    }

    func testEveryKindOfMusicLinkShowsIt() throws {
        for link in ["https://music.apple.com/it/album/x/1", "https://www.youtube.com/watch?v=1", "https://soundcloud.com/a/b",
                     "https://www.instagram.com/reel/abc/", "https://www.tiktok.com/@u/video/1", "https://www.shazam.com/track/1/x"] {
            XCTAssertTrue(try rig(url: URL(string: link)).model.showsPlaylistPicker, link)
        }
    }

    func testWithNoCacheYetItSaysHowToGetThePlaylists() throws {
        let r = try rig(url: spotify, playlists: nil)
        XCTAssertFalse(r.model.showsPlaylistPicker)
        XCTAssertEqual(r.model.playlistHint, "Apri Mondrop una volta per poter scegliere una playlist.")
    }

    func testAUserWithNoPlaylistToOfferSeesNoPickerAndNoHint() throws {
        let r = try rig(url: spotify, playlists: [MondropPlaylist(id: "d", name: "Dinamica", songCount: 0, kind: "dynamic", canEdit: false)])
        XCTAssertFalse(r.model.showsPlaylistPicker)
        XCTAssertNil(r.model.playlistHint)
    }

    func testTheRecipientsAreTheFamilyWithoutTheSender() throws {
        XCTAssertEqual(try rig(url: spotify, user: "mike").model.recipients, ["archi", "sara"])
        XCTAssertEqual(try rig(url: spotify, user: "sara").model.recipients, ["mike", "archi"])
    }

    func testTheSettingsDefaultPreselectsTheChipsAndStaysEditable() throws {
        let r = try rig(url: spotify, defaults: ["sara", "mike", "ghost"])
        XCTAssertEqual(r.model.selectedRecipients, ["sara"], "never the sender, never a stranger")
        r.model.toggleRecipient("sara")
        r.model.toggleRecipient("archi")
        XCTAssertEqual(r.model.options.shareWith, ["archi"])
    }

    func testNobodyIsTheDefault() throws {
        XCTAssertEqual(try rig(url: spotify).model.options.shareWith, [])
    }

    func testBothRecipientsAtOnce() throws {
        let r = try rig(url: spotify)
        r.model.toggleRecipient("sara")
        r.model.toggleRecipient("archi")
        XCTAssertEqual(r.model.options.shareWith, ["archi", "sara"], "family order, whatever the tapping order")
    }

    func testTheSenderCanNeverBeToggledOn() throws {
        let r = try rig(url: spotify, user: "mike")
        r.model.toggleRecipient("mike")
        XCTAssertTrue(r.model.selectedRecipients.isEmpty)
        XCTAssertEqual(r.model.options.shareWith, [])
    }

    func testAStalePlaylistSelectionIsNeverSent() throws {
        let r = try rig(url: spotify)
        r.model.choosePlaylist("deleted-on-the-server")
        XCTAssertNil(r.model.options.playlistId)
        r.model.choosePlaylist("p2")
        XCTAssertEqual(r.model.options.playlistId, "p2")
    }

    // MARK: the button (SH1)

    func testTheButtonIsDisabledOnlyWhenTheLinkIsMissingAndSaysWhy() throws {
        let missing = try rig(url: nil)
        XCTAssertFalse(missing.model.canSend)
        XCTAssertEqual(missing.model.disabledReason, "Nessun link da inviare: condividi una pagina che abbia un indirizzo web.")
        let ready = try rig(url: spotify)
        XCTAssertTrue(ready.model.canSend)
        XCTAssertNil(ready.model.disabledReason)
    }

    func testNothingIsSentWithoutALink() async throws {
        let r = try rig(url: nil)
        await r.model.send()
        XCTAssertTrue(r.sender.calls.isEmpty)
        XCTAssertEqual(r.model.phase, .editing)
    }

    // MARK: sending

    func testWhatIsSentCarriesOnlyWhatWasChosen() async throws {
        let plain = try rig(url: article)
        await plain.model.send()
        XCTAssertEqual(plain.sender.calls, [.init(url: article.absoluteString, comment: nil, tags: nil, options: .none)])

        let full = try rig(url: spotify)
        full.model.comment = "  #tesla  "
        full.model.choosePlaylist("p1")
        full.model.toggleRecipient("archi")
        await full.model.send()
        XCTAssertEqual(
            full.sender.calls,
            [.init(url: spotify.absoluteString, comment: "#tesla", tags: nil, options: ShareOptions(playlistId: "p1", shareWith: ["archi"]))]
        )
    }

    func testAPlaylistChosenForAnOrdinaryLinkIsNotSent() async throws {
        let r = try rig(url: article)
        r.model.choosePlaylist("p1")
        await r.model.send()
        XCTAssertNil(r.sender.calls.first?.options.playlistId)
    }

    func testSuccessShowsTheLineBuiltFromTheResponse() async throws {
        let response = ShareResponse(success: true, status: "queued", kind: "spotify", title: "T", artist: "A",
                                     playlist: .added(id: "p1", name: "Road trip", count: 1), sharedWith: ["archi"])
        let r = try rig(url: spotify, results: [.success(response)])
        r.model.choosePlaylist("p1")
        await r.model.send()
        guard case .succeeded(let outcome) = r.model.phase else { return XCTFail("\(r.model.phase)") }
        XCTAssertEqual(outcome.headline, "Brano aggiunto a Road trip")
        XCTAssertEqual(outcome.details, ["T — A", "Condiviso con archi"])
    }

    func testTheSheetIsBusyWhileSending() async throws {
        let r = try rig(url: spotify)
        XCTAssertFalse(r.model.isBusy)
        let task = Task { await r.model.send() }
        await Task.yield()
        await task.value
        XCTAssertFalse(r.model.isBusy)
    }

    func testAServerRefusalKeepsTheSheetOpenWithTheReason() async throws {
        let r = try rig(url: spotify, results: [.success(ShareResponse(success: false, error: "Shazam: Shazam ha risposto HTTP 503"))])
        await r.model.send()
        XCTAssertEqual(r.model.phase, .failed("Shazam: Shazam ha risposto HTTP 503"))
        XCTAssertTrue(r.model.canSend, "«Riprova» is the same button, enabled again")
    }

    func testAFailedCallKeepsTheSheetOpenWithTheReason() async throws {
        let r = try rig(url: spotify, results: [.failure(BackendError.http(401, nil))])
        await r.model.send()
        XCTAssertEqual(r.model.phase, .failed("API key non valida: rinnovala in Mondrop → Impostazioni"))
    }

    func testRiprovaSendsExactlyTheSameThingAgain() async throws {
        let r = try rig(url: spotify, results: [.failure(BackendError.transport(URLError(.notConnectedToInternet))), .success(ShareResponse(success: true, kind: "spotify"))])
        r.model.comment = "#tesla"
        r.model.choosePlaylist("p2")
        r.model.toggleRecipient("sara")

        await r.model.send()
        guard case .failed = r.model.phase else { return XCTFail("\(r.model.phase)") }
        await r.model.send()                                   // «Riprova»

        XCTAssertEqual(r.sender.calls.count, 2)
        XCTAssertEqual(r.sender.calls[0], r.sender.calls[1], "same url, same comment, same playlist, same recipients")
        XCTAssertEqual(r.sender.calls[1].options, ShareOptions(playlistId: "p2", shareWith: ["sara"]))
        guard case .succeeded = r.model.phase else { return XCTFail("\(r.model.phase)") }
    }

    // MARK: what is remembered

    func testEverySendLeavesALineForTheInboxRiprova() async throws {
        let r = try rig(url: spotify, results: [.failure(BackendError.transport(URLError(.timedOut)))])
        r.model.choosePlaylist("p1")
        r.model.toggleRecipient("archi")
        await r.model.send()
        let entry = try XCTUnwrap(r.log.lastEntry(forURL: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", now: Date(timeIntervalSince1970: 1_794_000_100)))
        XCTAssertEqual(entry.options, ShareOptions(playlistId: "p1", shareWith: ["archi"]), "even when the call itself failed")
    }

    func testTagsAreRememberedForTheChips() async throws {
        let withServerTags = try rig(url: article, results: [.success(ShareResponse(success: true, tags: ["#tesla", "vacanze"]))])
        withServerTags.model.comment = "#tesla vacanze"
        await withServerTags.model.send()
        XCTAssertEqual(withServerTags.remembered.tags, [["#tesla", "vacanze"]])

        let fromComment = try rig(url: article)
        fromComment.model.comment = "#a #b"
        await fromComment.model.send()
        XCTAssertEqual(fromComment.remembered.tags, [["#a", "#b"]])

        let none = try rig(url: article)
        await none.model.send()
        XCTAssertTrue(none.remembered.tags.isEmpty)
    }

    func testTagChipsToggleWordsInTheComment() throws {
        let r = try rig(url: article, recent: ["#tesla", "vacanze"])
        XCTAssertEqual(r.model.recentTags, ["#tesla", "vacanze"])
        r.model.toggleTag("#tesla")
        XCTAssertEqual(r.model.comment, "#tesla")
        r.model.toggleTag("vacanze")
        XCTAssertEqual(r.model.comment, "#tesla vacanze")
        r.model.toggleTag("#TESLA")
        XCTAssertEqual(r.model.comment, "vacanze")
    }

    func testTheContextComesFromTheSettings() {
        let context = ShareContext.current()
        XCTAssertEqual(context.user, Settings.shared.autheliaUsername)
        XCTAssertEqual(context.recentTags, Settings.shared.recentTags)
    }
}
