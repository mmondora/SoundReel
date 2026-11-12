import XCTest
@testable import Mondrop

/// «Voglio avere anche un tab con le altre categorie sul reel … ma non il link al reel ma la sua scomposizione e spiegazione.» (Michele, 12 November; spec
/// 2026-11-12-mondrop-home-play-loop-reels-design.md M5, ADR-0033; contract docs/mondrop-reels.md): what the app reads of a reel. Lenient like the Home: a category or a field this
/// app does not know is kept and never drawn, a bad element is dropped, a missing field is a default — never a failed list. And nothing here is an address.
final class ReelModelsTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private let pageJSON = """
    {"total": 2, "limit": 20, "offset": 0,
     "kinds": [{"kind":"music","label":"Musica","count":733},{"kind":"software","label":"Software","count":701}],
     "reels": [
       {"id":"r1","createdAt":"2026-11-12T08:01:00.000Z","platform":"instagram","summary":"Il post promuove una guida gratuita.","imagePath":"/api/mondrop/reels/r1/image",
        "counts":[{"kind":"music","label":"Musica","count":1,"names":["Garden of Eden"]},
                  {"kind":"software","label":"Software","count":3,"names":["Notion","Gmail","Slack"]}]},
       {"id":"r2","createdAt":"2026-11-11T20:00:00Z","platform":"tiktok","summary":null,"imagePath":null,"counts":[]}
     ]}
    """

    // MARK: the list

    func testAPageOfReelsDecodesWithItsCategories() throws {
        let page = try decode(ReelPage.self, pageJSON)
        XCTAssertEqual(page.total, 2)
        XCTAssertEqual(page.limit, 20)
        XCTAssertEqual(page.offset, 0)
        XCTAssertEqual(page.kinds.map(\.kind), [.music, .software])
        XCTAssertEqual(page.kinds.map(\.count), [733, 701])
        XCTAssertEqual(page.kinds.map(\.label), ["Musica", "Software"])
        XCTAssertEqual(page.reels.map(\.id), ["r1", "r2"])
        XCTAssertEqual(page.reels[0].summary, "Il post promuove una guida gratuita.")
        XCTAssertEqual(page.reels[0].imagePath, "/api/mondrop/reels/r1/image")
        XCTAssertEqual(page.reels[0].counts.map(\.kind), [.music, .software])
        XCTAssertEqual(page.reels[0].counts[1].names, ["Notion", "Gmail", "Slack"])
        XCTAssertNil(page.reels[1].summary)
        XCTAssertNil(page.reels[1].imagePath)
        XCTAssertTrue(page.reels[1].counts.isEmpty)
    }

    func testAPageWithoutFacetsHasNoCategoriesToChooseFrom() throws {
        let page = try decode(ReelPage.self, #"{"total":1,"limit":20,"offset":20,"reels":[{"id":"r9","createdAt":"2026-11-12T08:01:00Z","platform":"instagram"}]}"#)
        XCTAssertTrue(page.kinds.isEmpty)
        XCTAssertEqual(page.reels.map(\.id), ["r9"])
        XCTAssertEqual(page.offset, 20)
    }

    func testAReelWithoutAnIdIsLeftOutAndTheRestOfThePageStays() throws {
        let page = try decode(ReelPage.self, #"{"total":3,"limit":20,"offset":0,"reels":[{"id":"a"},{"summary":"no id"},{"id":"c"}]}"#)
        XCTAssertEqual(page.reels.map(\.id), ["a", "c"])
    }

    func testAnAnswerThatIsNotAPageIsNotACrash() throws {
        let page = try decode(ReelPage.self, "{}")
        XCTAssertEqual(page.total, 0)
        XCTAssertTrue(page.reels.isEmpty)
        XCTAssertTrue(page.kinds.isEmpty)
    }

    // MARK: the categories

    func testTheKnownCategoriesAreInTheOrderTheServerGivesThem() {
        let raws = ["music", "film", "software", "place", "book", "product", "brand", "person", "event", "quote"]
        let kinds = raws.map { ReelKind($0) }
        XCTAssertEqual(kinds, [.music, .film, .software, .place, .book, .product, .brand, .person, .event, .quote])
        XCTAssertEqual(kinds.map(\.raw), raws, "the word the server sends is the word the app sends back in `kind=`")
        XCTAssertTrue(kinds.allSatisfy(\.isKnown))
    }

    func testANewCategoryIsKeptAndNotDrawnAsOneOfOurs() throws {
        let page = try decode(ReelPage.self, #"{"total":1,"limit":20,"offset":0,"kinds":[{"kind":"recipe","label":"Ricette","count":4}],"reels":[]}"#)
        XCTAssertEqual(page.kinds.first?.kind, .unknown("recipe"))
        XCTAssertEqual(page.kinds.first?.kind.raw, "recipe")
        XCTAssertEqual(page.kinds.first?.kind.isKnown, false)
        XCTAssertEqual(page.kinds.first?.label, "Ricette", "the words are the server's")
    }

    func testTheChipSaysTheCategoryTheCountAndTheFirstNames() {
        let three = ReelKindCount(kind: .software, label: "Software", count: 3, names: ["Notion", "Gmail", "Slack"])
        XCTAssertEqual(three.chipText, "Software 3: Notion, Gmail, Slack")
        let more = ReelKindCount(kind: .software, label: "Software", count: 5, names: ["Notion", "Gmail", "Slack"])
        XCTAssertEqual(more.chipText, "Software 5: Notion, Gmail, Slack +2")
        let none = ReelKindCount(kind: .film, label: "Film", count: 2, names: [])
        XCTAssertEqual(none.chipText, "Film 2")
        let one = ReelKindCount(kind: .music, label: "Musica", count: 1, names: ["Garden of Eden"])
        XCTAssertEqual(one.chipText, "Musica 1: Garden of Eden")
    }

    // MARK: where and when

    func testThePlatformsAreNamedTheWayTheyAreWritten() {
        XCTAssertEqual(ReelPlatform.name("instagram"), "Instagram")
        XCTAssertEqual(ReelPlatform.name("tiktok"), "TikTok")
        XCTAssertEqual(ReelPlatform.name("youtube"), "YouTube")
        XCTAssertEqual(ReelPlatform.name("twitter"), "X")
        XCTAssertEqual(ReelPlatform.name("other"), "Web")
        XCTAssertEqual(ReelPlatform.name(""), "Web")
        XCTAssertEqual(ReelPlatform.name("mastodon"), "Mastodon")
    }

    func testTheDateLineIsThePlatformAndTheDayLikeTheListOfPlaylists() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = ISO.parse("2026-11-12T10:00:00Z")!
        let page = try decode(ReelPage.self, pageJSON)
        XCTAssertEqual(page.reels[0].dateLine(now: now, calendar: calendar), "Instagram · oggi")
        XCTAssertEqual(page.reels[1].dateLine(now: now, calendar: calendar), "TikTok · ieri")
        let old = try decode(ReelCard.self, #"{"id":"x","createdAt":"2026-10-03T08:00:00Z","platform":"youtube"}"#)
        XCTAssertEqual(old.dateLine(now: now, calendar: calendar), "YouTube · 3 ott")
        let undated = try decode(ReelCard.self, #"{"id":"y","platform":"instagram"}"#)
        XCTAssertEqual(undated.dateLine(now: now, calendar: calendar), "Instagram", "an unreadable date is no date")
    }

    // MARK: the page of a reel

    private let detailJSON = """
    {"id":"r1","createdAt":"2026-11-12T08:01:00.000Z","platform":"instagram",
     "summary":"Il post promuove una guida gratuita per costruire agenti.","imagePath":"/api/mondrop/reels/r1/image",
     "tags":["claude","agentiai"],
     "sections":[
       {"kind":"music","title":"Musica","tracks":[
          {"songKey":"yom::garden of eden","title":"Garden of Eden","artist":"Yom","state":"ready","status":"ready","source":"ytdlp",
           "downloadPath":"/api/mondrop/songs/yom%3A%3Agarden%20of%20eden/file","version":"100-1","bytes":100}]},
       {"kind":"film","title":"Film","items":[{"title":"Garden of Eden","detail":"2025 · regia di Qualcuno"}]},
       {"kind":"software","title":"Software","items":[{"title":"Notion","detail":"prodotto"},{"title":"Gmail","detail":null}]},
       {"kind":"recipe","title":"Ricette","items":[{"title":"Carbonara"}]},
       {"title":"senza categoria"}
     ],
     "insights":[{"label":"Brand: AGENTI","text":"Il brand si occupa di agenti."}],
     "verdict":{"label":"dubbio","explanation":"Non verificabile."},
     "slides":[{"index":0,"summary":"La prima slide presenta la guida."},{"index":1,"summary":"La seconda elenca i sette tipi."}]}
    """

    func testTheDetailOfAReelDecodesWithItsSectionsAndExplanations() throws {
        let reel = try decode(ReelDetail.self, detailJSON)
        XCTAssertEqual(reel.id, "r1")
        XCTAssertEqual(reel.summary, "Il post promuove una guida gratuita per costruire agenti.")
        XCTAssertEqual(reel.tags, ["claude", "agentiai"])
        XCTAssertEqual(reel.sections.map(\.kind), [.music, .film, .software, .unknown("recipe")], "a section without a category is dropped, the new category is kept")
        XCTAssertEqual(reel.sections[0].tracks.map(\.songKey), ["yom::garden of eden"], "the music is made of the ordinary Mondrop tracks")
        XCTAssertTrue(reel.sections[0].items.isEmpty)
        XCTAssertEqual(reel.sections[1].items.map(\.title), ["Garden of Eden"])
        XCTAssertEqual(reel.sections[1].items.first?.detail, "2025 · regia di Qualcuno")
        XCTAssertEqual(reel.sections[2].items.map(\.title), ["Notion", "Gmail"])
        XCTAssertNil(reel.sections[2].items[1].detail)
        XCTAssertEqual(reel.insights.map(\.label), ["Brand: AGENTI"])
        XCTAssertEqual(reel.verdict?.label, "dubbio")
        XCTAssertEqual(reel.verdict?.explanation, "Non verificabile.")
        XCTAssertEqual(reel.slides.map(\.index), [0, 1])
        XCTAssertEqual(reel.slides[1].summary, "La seconda elenca i sette tipi.")
    }

    func testADetailWithOnlyAnIdIsAnEmptyButValidReel() throws {
        let reel = try decode(ReelDetail.self, #"{"id":"r2"}"#)
        XCTAssertEqual(reel.id, "r2")
        XCTAssertNil(reel.summary)
        XCTAssertNil(reel.verdict)
        XCTAssertTrue(reel.sections.isEmpty)
        XCTAssertTrue(reel.insights.isEmpty)
        XCTAssertTrue(reel.slides.isEmpty)
        XCTAssertTrue(reel.tags.isEmpty)
    }

    func testABadSectionOrInsightDoesNotSpoilTheReel() throws {
        let reel = try decode(ReelDetail.self, #"{"id":"r3","sections":[{"kind":"film","title":"Film","items":[{"title":"A"},{"detail":"no title"},{"title":"B"}]},7],"insights":[{"label":"x"},{"label":"y","text":"ok"}]}"#)
        XCTAssertEqual(reel.sections.count, 1)
        XCTAssertEqual(reel.sections[0].items.map(\.title), ["A", "B"])
        XCTAssertEqual(reel.insights.map(\.label), ["y"], "an insight with no text says nothing")
    }

    func testTheMusicOfAReelIsTheOnlyThingThatCanGoToThePhone() throws {
        let reel = try decode(ReelDetail.self, detailJSON)
        let withTracks = reel.sections.filter { !$0.tracks.isEmpty }
        XCTAssertEqual(withTracks.map(\.kind), [.music], "only the music carries songs: the rest is text read from SoundReel")
        XCTAssertEqual(reel.musicTracks.map(\.songKey), ["yom::garden of eden"])
    }

    func testAReelExplainsItselfWhenItHasAnythingToSay() throws {
        XCTAssertTrue(try decode(ReelDetail.self, detailJSON).hasExplanation)
        XCTAssertFalse(try decode(ReelDetail.self, #"{"id":"r2"}"#).hasExplanation)
        XCTAssertFalse(try decode(ReelDetail.self, #"{"id":"r2","summary":"   "}"#).hasExplanation, "blanks are no explanation")
    }

    // MARK: «Apri» on the sheet of a film («Q3 si apri sulla scheda», Michele, 12 November; ADR-0033 amended)

    private func item(_ json: String) throws -> ReelItem { try decode(ReelItem.self, json) }

    func testAFilmWithASheetCarriesItsAddressAndTheHostForTheLabel() throws {
        let film = try item(#"{"title":"Dune","detail":"2021","openUrl":"https://www.imdb.com/title/tt1160419/"}"#)
        XCTAssertEqual(film.openUrl?.absoluteString, "https://www.imdb.com/title/tt1160419/")
        XCTAssertEqual(film.openHost, "imdb.com", "the button says where it goes, without the «www.»")
        XCTAssertEqual(try item(#"{"title":"Dune","openUrl":"https://m.imdb.com/title/tt1160419/"}"#).openHost, "m.imdb.com")
    }

    func testAnItemWithoutASheetHasNoAddressAndNoHost() throws {
        let plain = try item(#"{"title":"Notion","detail":"prodotto"}"#)
        XCTAssertNil(plain.openUrl)
        XCTAssertNil(plain.openHost)
        XCTAssertNil(try item(#"{"title":"Notion","openUrl":null}"#).openUrl)
        XCTAssertNil(ReelItem(title: "Notion").openUrl)
    }

    func testAnItemBuiltInCodeFollowsTheSameRuleAsOneReadFromTheServer() {
        XCTAssertEqual(ReelItem(title: "Dune", openUrl: URL(string: "https://www.imdb.com/title/tt1160419/")).openUrl?.absoluteString, "https://www.imdb.com/title/tt1160419/")
        XCTAssertNil(ReelItem(title: "Dune", openUrl: URL(string: "http://www.imdb.com/title/tt1160419/")).openUrl, "http is not opened, whoever built the item")
        XCTAssertNil(ReelItem(title: "Dune", openUrl: URL(string: "javascript:alert(1)")).openUrl)
    }

    func testOnlyAWebPageOnHttpsIsEverOpenedAndABadAddressLeavesTheItemWithoutIt() throws {
        let bad = [
            "http://www.imdb.com/title/tt1160419/", "javascript:alert(1)", "file:///etc/passwd", "tel:+390000000", "mailto:a@b.it", "mondrop://x",
            "https://user:pass@www.imdb.com/title/tt1160419/", "https://user@www.imdb.com/title/tt1160419/", "https://", "", "  ", "not a url", "/title/tt1160419/", "7",
        ]
        for address in bad {
            let film = try item(#"{"title":"Dune","openUrl":"\#(address)"}"#)
            XCTAssertEqual(film.title, "Dune", "the film stays whatever its address: \(address)")
            XCTAssertNil(film.openUrl, "«\(address)» is not opened")
            XCTAssertNil(film.openHost)
        }
        let notText = try item(#"{"title":"Dune","openUrl":42}"#)
        XCTAssertEqual(notText.title, "Dune", "an address that is not even text does not spoil the item")
        XCTAssertNil(notText.openUrl)
    }

    func testTheSheetComesBackOnTheItemItWasSentOn() throws {
        let reel = try decode(ReelDetail.self, #"{"id":"r1","sections":[{"kind":"film","title":"Film","items":[{"title":"Dune","openUrl":"https://www.imdb.com/title/tt1160419/"},{"title":"Arrival"}]},{"kind":"software","title":"Software","items":[{"title":"Notion"}]}]}"#)
        XCTAssertEqual(reel.sections[0].items.map { $0.openUrl != nil }, [true, false])
        XCTAssertEqual(reel.sections[1].items.map { $0.openUrl != nil }, [false])
    }
}
