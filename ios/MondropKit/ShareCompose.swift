// ShareCompose.swift — the state of the share sheet (spec SH1–SH7). The SwiftUI view only draws it; everything that
// decides lives here, so it is tested without a screen: what is offered (playlist picker only for music/media links,
// never the sender among the recipients), what is sent (playlistId / shareWith only when chosen), and the phases
// editing → sending → success | failure («Riprova» sends the SAME thing again).

import Foundation

/// What the sheet reads from `Settings` — a value, so tests never touch the shared defaults.
public struct ShareContext: Sendable {
    /// The Authelia user of this phone: never offered as a recipient.
    public var user: String
    /// Settings → «Condividi di default con…»: pre-selects the chips, still editable in the sheet.
    public var defaultShareWith: [String]
    public var recentTags: [String]

    public init(user: String, defaultShareWith: [String] = [], recentTags: [String] = []) {
        self.user = user
        self.defaultShareWith = defaultShareWith
        self.recentTags = recentTags
    }

    public static func current() -> ShareContext {
        let settings = Settings.shared
        return ShareContext(
            user: settings.autheliaUsername,
            defaultShareWith: settings.defaultShareWith,
            recentTags: settings.recentTags
        )
    }
}

@MainActor
public final class ShareComposeModel: ObservableObject {
    public enum Phase: Equatable {
        case editing
        case sending
        case succeeded(ShareOutcome)
        /// The reason, ready to show; the sheet stays open with «Riprova».
        case failed(String)
    }

    public let url: URL?
    /// The family without the sender.
    public let recipients: [String]
    /// The playlists the user may add songs to, from the cache (never the network).
    public let playlists: [CachedPlaylist]
    /// The link is music/media AND there is something to choose from.
    public let showsPlaylistPicker: Bool
    /// A music/media link but the app has never cached the playlists: say how to get them.
    public let playlistHint: String?

    @Published public var comment: String = ""
    /// nil = «Nessuna» (the default).
    @Published public var selectedPlaylist: String? = nil
    @Published public var selectedRecipients: Set<String>
    @Published public private(set) var phase: Phase = .editing
    @Published public private(set) var recentTags: [String]

    private let user: String
    private let sender: ShareSending
    private let log: ShareLog
    private let rememberTags: ([String]) -> [String]
    private let now: () -> Date

    public init(
        url: URL?,
        context: ShareContext,
        sender: ShareSending,
        cache: PlaylistsCache = .shared,
        log: ShareLog = .shared,
        /// Remembers the tags for the chips next time and returns the new list of recent ones.
        rememberTags: @escaping ([String]) -> [String] = { tags in
            Settings.shared.rememberTags(tags)
            return Settings.shared.recentTags
        },
        now: @escaping () -> Date = { Date() }
    ) {
        self.url = url
        self.user = context.user
        self.sender = sender
        self.log = log
        self.rememberTags = rememberTags
        self.now = now
        self.recentTags = context.recentTags
        self.recipients = ShareRecipients.available(for: context.user)
        self.selectedRecipients = Set(ShareRecipients.sanitize(context.defaultShareWith, for: context.user))

        let isMedia = url.map { MediaLinkClassifier.isMusicOrMedia($0) } ?? false
        let cached = isMedia ? cache.load(forUser: context.user) : nil
        self.playlists = cached?.playlists ?? []
        self.showsPlaylistPicker = isMedia && !(cached?.playlists.isEmpty ?? true)
        self.playlistHint = (isMedia && cached == nil)
            ? "Apri Mondrop una volta per poter scegliere una playlist."
            : nil
    }

    // MARK: what can be done

    /// Disabled only when there is no link — and then the reason is written next to the button.
    public var disabledReason: String? {
        url == nil ? "Nessun link da inviare: condividi una pagina che abbia un indirizzo web." : nil
    }

    public var canSend: Bool { url != nil && phase != .sending }

    public var isBusy: Bool { phase == .sending }

    /// What goes in the request: `playlistId` and `shareWith` only if chosen — and only if still valid.
    public var options: ShareOptions {
        let playlist = showsPlaylistPicker ? selectedPlaylist.flatMap { id in playlists.contains { $0.id == id } ? id : nil } : nil
        return ShareOptions(playlistId: playlist, shareWith: ShareRecipients.sanitize(Array(selectedRecipients), for: user))
    }

    public func toggleRecipient(_ recipient: String) {
        guard recipients.contains(recipient) else { return }
        if selectedRecipients.contains(recipient) { selectedRecipients.remove(recipient) } else { selectedRecipients.insert(recipient) }
    }

    public func choosePlaylist(_ id: String?) {
        selectedPlaylist = id
    }

    public func toggleTag(_ tag: String) {
        let parts = comment.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        if parts.contains(where: { $0.caseInsensitiveCompare(tag) == .orderedSame }) {
            comment = parts.filter { $0.caseInsensitiveCompare(tag) != .orderedSame }.joined(separator: " ")
        } else {
            comment = (comment.trimmingCharacters(in: .whitespaces) + " " + tag).trimmingCharacters(in: .whitespaces)
        }
    }

    // MARK: sending

    private var commentToSend: String? {
        let trimmed = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// «Invia a SoundReel» and «Riprova» are the same action: the server is idempotent per link.
    public func send() async {
        guard let url, phase != .sending else { return }
        phase = .sending
        let options = self.options
        let comment = commentToSend
        // Written BEFORE the call: if this attempt dies, the inbox's «Riprova» still finds how it was sent.
        log.record(url: url.absoluteString, comment: comment, options: options, at: now())
        do {
            let response = try await sender.share(url: url.absoluteString, comment: comment, tags: nil, options: options)
            if response.success {
                remember(response.tags, comment: comment)
                phase = .succeeded(ShareOutcomeText.success(response))
            } else {
                phase = .failed(ShareOutcomeText.failure(for: response))
            }
        } catch {
            phase = .failed(ShareOutcomeText.failure(for: error))
        }
    }

    private func remember(_ serverTags: [String]?, comment: String?) {
        if let serverTags, !serverTags.isEmpty {
            recentTags = rememberTags(serverTags)
        } else if let comment {
            recentTags = rememberTags(comment.split(whereSeparator: { $0.isWhitespace }).map(String.init))
        }
    }
}
