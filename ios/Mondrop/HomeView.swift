// HomeView.swift — the first thing Mondrop shows (spec 2026-11-08-mondrop-home-spotify-design.md, ADR-0020). Michele, 8 November:
// «No aspetta, non mi piace il "cerca musica" - fai una proposta alla spotify» / «A, si giallo».
//
// A greeting, the field to search (a tap opens Cerca with the keyboard), «Riprendi» (the phone's own queue, kept between launches) and the
// sections the SERVER decided: which exist, which songs and which playlists, with what title (rule P — this view reads neither the network nor any store).
// The one thing it does with a row is to put what is on the phone first (`LocalFirst`; Michele, 11 November: «le playlist e i brani devono essere in ordine di
// scaricati in locale e poi online»): the phone knows what it holds, the server cannot. A tap on a song plays it and queues the ones that follow in its row; a long
// press offers what Cerca offers. It is never a blank page: with nothing to show it still has the field and the way to browse.
//
// 12 November (spec 2026-11-12-mondrop-home-play-loop-reels-design.md M1–M3; Michele: «in mondrop voglio avere il bottone play, in homepage, direttamente sulla play list, in un angolo - oppure
// con una gesture… gli Ascoltati di recente non mi interessano in homepage»): every card of a playlist has a round play button on its cover — a tap plays the playlist from the top, the phone's
// songs first — and a long press on the card offers «Suona», «Mescola» and «Suona in loop»; the row of the songs heard lately is gone (the server no longer sends it). There is no sync or check
// on this page: the Settings are the only place that names them.

import SwiftUI

struct HomeView: View {
    @StateObject private var model: HomeModel
    @StateObject private var actions = TrackActions()
    /// The play on the card of a playlist: the queue of that playlist, without opening its page.
    @StateObject private var quickPlay: PlaylistQuickPlay
    @ObservedObject private var engine = SyncEngine.shared
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var localKeys: Set<String> = []
    #if DEBUG
    @State private var demoPush = false
    @State private var demoPushAll = false
    #endif

    /// The Player, at full screen (from the «Riprendi» card).
    let onOpenPlayer: () -> Void
    /// Tells the tab whether THIS page (not a page pushed from it) is on screen: the mini player is not drawn here, and is on every page opened from here.
    let onRootVisible: (Bool) -> Void

    init(onOpenPlayer: @escaping () -> Void, onRootVisible: @escaping (Bool) -> Void = { _ in }) {
        self.onOpenPlayer = onOpenPlayer
        self.onRootVisible = onRootVisible
        #if DEBUG
        let transport: HomeTransport = DemoData.isOn ? DemoData.Transport() : MondropAPI()
        #else
        let transport: HomeTransport = MondropAPI()
        #endif
        _model = StateObject(wrappedValue: HomeModel(transport: transport))
        #if DEBUG
        let playlistAPI: MondropAPIProtocol = DemoData.isOn ? DemoData.PlaylistAPI() : MondropAPI()
        #else
        let playlistAPI: MondropAPIProtocol = MondropAPI()
        #endif
        _quickPlay = StateObject(wrappedValue: PlaylistQuickPlay.app(api: playlistAPI))
    }

    private var wide: Bool { sizeClass == .regular }
    private var cardSide: CGFloat { wide ? 176 : 148 }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                Text(HomeGreeting.make(name: model.displayName))
                    .font(.largeTitle.bold())
                    .foregroundStyle(Color(MondropPalette.text))
                    .accessibilityAddTraits(.isHeader)
                searchField
                ResumeSection(onOpen: onOpenPlayer)
                content
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
            .frame(maxWidth: 820, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .background {
            LinearGradient(
                colors: [Color(MondropPalette.backgroundTop), Color(MondropPalette.backgroundBottom)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            .ignoresSafeArea()
        }
        .navigationTitle("Home")
        #if os(iOS)
        .toolbar(.hidden, for: .navigationBar)       // the greeting is the title (the Mac has no navigation bar to hide)
        #endif
        .refreshable { await model.load() }
        // Every time the tab comes into view the server is asked again (what it composes for this user can change from one minute to the next).
        .task {
            localKeys = engine.store.localSongKeys()
            await model.load()
        }
        .onChange(of: engine.revision) { _, _ in localKeys = engine.store.localSongKeys() }
        .onAppear { onRootVisible(true) }
        .onDisappear { onRootVisible(false) }
        .trackActions(actions)
        #if DEBUG
        .navigationDestination(isPresented: $demoPush) { PlaylistOfflineView(playlist: DemoData.push == "long" ? DemoData.playlists[5] : DemoData.playlists[2]) }
        .navigationDestination(isPresented: $demoPushAll) { PlaylistsView() }
        .onAppear {
            if DemoData.push == "playlist" || DemoData.push == "long" { demoPush = true }
            if DemoData.opensAllPlaylists { demoPushAll = true }
        }
        #endif
    }

    // MARK: the field

    /// Not a real field: a tap takes the user to Cerca with the keyboard already up.
    private var searchField: some View {
        Button { RootRouter.shared.requestSearch() } label: {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                Text("Cosa vuoi ascoltare?")
                Spacer(minLength: 0)
            }
            .font(.body)
            .foregroundStyle(secondary)
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .background(card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Cerca")
        .accessibilityHint("Apre la ricerca")
    }

    // MARK: what the server sent

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            HStack { Spacer(); ProgressView().tint(Color(MondropPalette.text)); Spacer() }
                .padding(.vertical, 40)
        case .sections:
            ForEach(model.sections) { section in
                sectionView(section)
            }
            if let failure = model.failure {
                // A reload failed: what was on screen stays, with a line that says so.
                Label("Non riesco ad aggiornare: \(failure)", systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(Color(MondropPalette.error))
            }
        case .empty:
            message(
                "Qui compariranno le tue playlist, i brani che ascolti e quelli che trovi nei reel.",
                button: nil
            )
        case .failed(let failure):
            message("Non riesco a caricare la Home.", detail: failure, button: ("Riprova", { Task { await model.load() } }))
        }
    }

    /// The empty and the failed Home: a few words, the way to browse what is on the phone, and — when it failed — «Riprova».
    private func message(_ text: String, detail: String? = nil, button: (String, () -> Void)?) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(text).font(.headline).foregroundStyle(Color(MondropPalette.text))
            if let detail { Text(detail).font(.footnote).foregroundStyle(secondary) }
            // Side by side when they fit, one under the other when they do not (an iPhone): never a word broken in two.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { actionButtons(button) }
                VStack(alignment: .leading, spacing: 10) { actionButtons(button) }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    @ViewBuilder
    private func actionButtons(_ retry: (String, () -> Void)?) -> some View {
        if let retry {
            Button(retry.0, action: retry.1).buttonStyle(MondropPillStyle(prominent: true))
        }
        NavigationLink {
            LibraryView(initialDimension: .songs, onlyOnPhone: true)
        } label: {
            Label("Brani sul telefono", systemImage: "iphone")
        }
        .buttonStyle(MondropPillStyle(prominent: false))
        NavigationLink {
            LibraryView(initialDimension: .playlists)
        } label: {
            Label("Sfoglia", systemImage: "square.stack")
        }
        .buttonStyle(MondropPillStyle(prominent: false))
        // The whole list of the playlists is reached from here when the server sent no row of them.
        NavigationLink {
            PlaylistsView()
        } label: {
            Label("Tutte le playlist", systemImage: "music.note.list")
        }
        .buttonStyle(MondropPillStyle(prominent: false))
    }

    @ViewBuilder
    private func sectionView(_ section: HomeSection) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 10) {
                Text(section.title)
                    .font(.title3.bold())
                    .foregroundStyle(Color(MondropPalette.text))
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                // «Su Mondrop non vedo utilità nel tab playlist avendo le playlist in home page»: the whole list lives here. There is no «Sync» of all of them
                // («Il sync deve girare solo per playlist che sto suonando», 11 November): the playlist that plays syncs by itself.
                if section.kind == .playlists { allPlaylistsButton }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 14) {
                    switch section.kind {
                    case .playlists:
                        let marks = PlaylistMarks.current(store: engine.store, local: localKeys, progress: engine.progress)
                        // the playlists that are on the phone first, then the ones that are only online
                        ForEach(marks.ordered(section.playlists, id: \.id, songCount: \.songCount)) { playlist in
                            playlistCard(playlist, state: marks.state(id: playlist.id, songCount: playlist.songCount))
                        }
                    case .tracks:
                        ForEach(orderedTracks(of: section)) { track in trackCard(track, in: section) }
                    case .unknown:
                        EmptyView()
                    }
                }
                // Room for the shadow and for the first card to line up with the title.
                .padding(.vertical, 2)
            }
            // The rows run to the edge of the screen on an iPhone, as in Spotify.
            .padding(.horizontal, -16)
            .contentMargins(.horizontal, 16, for: .scrollContent)
        }
    }

    /// «Tutte»: the whole list of the playlists (search, sort, pages).
    private var allPlaylistsButton: some View {
        NavigationLink {
            PlaylistsView()
        } label: {
            Text("Tutte")
        }
        .buttonStyle(MondropPillStyle(prominent: false))
        .accessibilityLabel("Tutte le playlist")
    }

    private func playlistCard(_ playlist: HomePlaylist, state: PlaylistState?) -> some View {
        ZStack(alignment: .topLeading) {
            NavigationLink {
                PlaylistOfflineView(playlist: playlist.playlist)
            } label: {
                VStack(alignment: .leading, spacing: 6) {
                    PlaylistMosaic(seed: playlist.id, keys: playlist.coverKeys)
                        .frame(width: cardSide, height: cardSide)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    Text(playlist.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color(MondropPalette.text))
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        PlaylistStateMark(state: state, font: .caption)
                        Text(playlist.songCount == 1 ? "1 brano" : "\(playlist.songCount) brani")
                            .font(.caption)
                            .foregroundStyle(secondary)
                        if playlist.isDynamic { DynamicBadge() }
                    }
                }
                .frame(width: cardSide, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            // the play, in the corner of the cover (a button of its own: the card still opens the page)
            playButton(for: playlist)
                .offset(x: cardSide - Self.playSide - 8, y: cardSide - Self.playSide - 8)
        }
        .frame(width: cardSide, alignment: .leading)
        // the gesture: a long press on the card offers what the play can do
        .contextMenu {
            Button { play(playlist) } label: { Label("Suona", systemImage: "play.fill") }
            Button { play(playlist, shuffled: true) } label: { Label("Mescola", systemImage: "shuffle") }
            Button { play(playlist, loop: true) } label: { Label("Suona in loop", systemImage: "repeat") }
        }
    }

    private static let playSide: CGFloat = 40

    /// «il bottone play, in homepage, direttamente sulla play list, in un angolo»: yellow with a dark glyph, like the play of «Riprendi»; a spinner while the list is being read.
    private func playButton(for playlist: HomePlaylist) -> some View {
        Button {
            play(playlist)
        } label: {
            ZStack {
                Circle().fill(Color(MondropPalette.accent))
                if quickPlay.loadingId == playlist.id {
                    ProgressView().controlSize(.small).tint(Color(MondropPalette.onAccent))
                } else {
                    Image(systemName: "play.fill")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Color(MondropPalette.onAccent))
                }
            }
            .frame(width: Self.playSide, height: Self.playSide)
            .shadow(color: .black.opacity(0.35), radius: 4, y: 2)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Suona \(playlist.name)")
        .accessibilityHint("Tieni premuto sulla playlist per mescolare o ripetere")
    }

    /// Builds the queue of the playlist and starts it; when it cannot, one short line at the bottom says why.
    private func play(_ playlist: HomePlaylist, shuffled: Bool = false, loop: Bool = false) {
        Task {
            let outcome = await quickPlay.play(playlistId: playlist.id, name: playlist.name, shuffled: shuffled, loop: loop)
            if let message = outcome.message(playlistName: playlist.name) { actions.show(message) }
        }
    }

    /// What the phone knows of a song: on it, on its way, deleted from it, failed.
    private func songStatus(_ track: OfflineTrack) -> TrackRowStatus {
        TrackRowStatus.make(
            track: track,
            isLocal: localKeys.contains(track.songKey),
            progress: engine.progress[track.songKey],
            isSkipListed: engine.store.isSkipped(track.songKey)
        )
    }

    /// The songs of a row, the ones on the phone first and the server's order inside each group.
    private func orderedTracks(of section: HomeSection) -> [OfflineTrack] {
        LocalFirst.songs(section.tracks) { SongState(songStatus($0)) }
    }

    private func trackCard(_ track: OfflineTrack, in section: HomeSection) -> some View {
        let status = songStatus(track)
        return HomeTrackCard(
            track: track, status: status, side: cardSide,
            showsDownload: section.id == "fresh",
            isLocal: localKeys.contains(track.songKey), actions: actions,
            onPlay: { play(track, in: section) }
        )
    }

    /// «Suona e accoda i seguenti»: this song, then the ones that follow it in the row AS IT IS DRAWN (the phone's first); the queue is called what the row is.
    private func play(_ track: OfflineTrack, in section: HomeSection) {
        guard let queue = SearchPlayback.queue(
            choice: .collection(section.title), tracks: orderedTracks(of: section), tapped: track.songKey, isLocal: { localKeys.contains($0) }
        ) else {
            actions.show(QueueAppend.Outcome.notPlayable.message)
            return
        }
        LocalAudioPlayer.shared.start(queue)
    }

    private var secondary: Color { Color(MondropPalette.text).opacity(MondropPalette.secondaryTextOpacity) }
    private var card: Color { Color.white.opacity(MondropPalette.cardFillOpacity) }
}

// MARK: - «Riprendi»

/// Where the user was: the queue the phone kept, which comes back paused. Its own view, so that the progress of the song (twice a second)
/// redraws only this card and not the whole Home.
private struct ResumeSection: View {
    @ObservedObject private var player = LocalAudioPlayer.shared
    let onOpen: () -> Void

    var body: some View {
        if let card = ResumeCard.make(
            queue: player.queue, index: player.index, label: player.queueLabel,
            currentTime: player.currentTime, duration: player.duration, playing: player.playing
        ) {
            HStack(spacing: 14) {
                CoverView(coverData: player.coverData, title: card.title, artist: card.artist, seed: card.songKey, showsText: false)
                    .frame(width: 72, height: 72)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("RIPRENDI")
                        .font(.caption2.weight(.heavy))
                        .tracking(2)
                        .foregroundStyle(Color(MondropPalette.accent))
                    Text(card.title)
                        .font(.headline)
                        .foregroundStyle(Color(MondropPalette.text))
                        .lineLimit(1)
                    if !card.artist.isEmpty {
                        Text(card.artist)
                            .font(.subheadline)
                            .foregroundStyle(secondary)
                            .lineLimit(1)
                    }
                    Text(card.queueLine)
                        .font(.caption)
                        .foregroundStyle(secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Button { player.toggle() } label: {
                    Image(systemName: card.isPlaying ? "pause.fill" : "play.fill")
                        .font(.title2)
                        .foregroundStyle(Color(MondropPalette.onAccent))
                        .frame(width: 54, height: 54)
                        .background(Color(MondropPalette.accent), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(card.isPlaying ? "Pausa" : "Riprendi")
                // «sul play voglio anche il "loop" del singolo o della playlist»: a long press opens the loop, a small mark says when it is on
                .accessibilityHint("Tieni premuto per la ripetizione")
                .accessibilityAction(named: "Cambia la ripetizione") { player.cycleRepeatMode() }
                .overlay(alignment: .topTrailing) { RepeatIndicator(onYellow: true).offset(x: 2, y: -2) }
                .contextMenu { RepeatMenuItems() }
            }
            .padding(12)
            .background(Color.white.opacity(MondropPalette.cardFillOpacity), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(alignment: .bottom) {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Rectangle().fill(Color.white.opacity(0.14))
                        Rectangle().fill(Color(MondropPalette.accent)).frame(width: geo.size.width * card.progress)
                    }
                }
                .frame(height: 3)
                .accessibilityHidden(true)
            }
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .contentShape(Rectangle())
            .onTapGesture(perform: onOpen)
            .accessibilityElement(children: .contain)
        }
    }

    private var secondary: Color { Color(MondropPalette.text).opacity(MondropPalette.secondaryTextOpacity) }
}

// MARK: - A song of a row

/// A song in a row: the cover, the title and the artist; a tap plays it and queues what follows; a long press offers the actions of Cerca.
private struct HomeTrackCard: View {
    let track: OfflineTrack
    let status: TrackRowStatus
    let side: CGFloat
    /// «Nuovi dai tuoi reel»: the button to put the song on the phone, on the cover.
    let showsDownload: Bool
    let isLocal: Bool
    let actions: TrackActions
    let onPlay: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .bottomTrailing) {
                Button(action: onPlay) {
                    AsyncCover(songKey: track.songKey, coverPath: track.coverPath, title: track.title, artist: track.artist)
                        .frame(width: side, height: side)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                // The cover and the words below it are the SAME action: VoiceOver gets one button for them (this one).
                .accessibilityLabel(track.artist.isEmpty ? track.title : "\(track.title), \(track.artist)")
                mark.padding(6)
            }
            Button(action: onPlay) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(track.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color(MondropPalette.text))
                        .lineLimit(1)
                    Text(track.artist)
                        .font(.caption)
                        .foregroundStyle(Color(MondropPalette.text).opacity(MondropPalette.secondaryTextOpacity))
                        .lineLimit(1)
                }
                .frame(width: side, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityHidden(true)
        }
        .frame(width: side, alignment: .leading)
        .contextMenu {
            LikeMenuButton(songKey: track.songKey) { actions.likeToggled(track, liked: $0) }
            Button { actions.addToQueue(track, isLocal: isLocal) } label: {
                Label("Aggiungi in coda", systemImage: "text.badge.plus")
            }
            Button { actions.askPlaylist(for: track) } label: {
                Label("Aggiungi a playlist…", systemImage: "music.note.list")
            }
            if canDownload {
                Button { actions.download(track, status: status) } label: {
                    Label("Scarica sul telefono", systemImage: "arrow.down.circle")
                }
            }
        }
    }

    /// The mark of where the file is, on every card (the same three as everywhere): on the phone (a yellow check), online (a cloud), error (a triangle), and — in
    /// «Nuovi dai tuoi reel» — instead of the cloud the button to put the song on the phone. A spinner while it is on its way.
    @ViewBuilder
    private var mark: some View {
        let state = SongState(status)
        switch state {
        case .local:
            badge { Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(Color(MondropPalette.accent)) }
                .accessibilityLabel(state.accessibilityLabel)
        case .online(let percent):
            if percent != nil || status.isBusy {
                badge { ProgressView().controlSize(.mini).tint(Color(MondropPalette.text)) }
                    .accessibilityLabel(status.rowText)
            } else if showsDownload && canDownload {
                Button { actions.download(track, status: status) } label: {
                    badge { Image(systemName: "arrow.down").font(.caption.weight(.bold)).foregroundStyle(Color(MondropPalette.accent)) }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Scarica sul telefono")
            } else {
                badge { Image(systemName: "icloud").font(.caption).foregroundStyle(Color(MondropPalette.text).opacity(MondropPalette.secondaryTextOpacity)) }
                    .accessibilityLabel(state.accessibilityLabel)
            }
        case .error:
            badge { Image(systemName: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(Color(MondropPalette.error)) }
                .accessibilityLabel(state.accessibilityLabel)
        }
    }

    private func badge<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .frame(width: 28, height: 28)
            .background(Color.black.opacity(0.62), in: Circle())
    }

    /// Only a song the server has ready and the phone does not have (or no longer has).
    private var canDownload: Bool {
        switch status.kind {
        case .readyOnServer, .removedFromPhone: return true
        default: return false
        }
    }
}

// MARK: - The play on a card, wired to the app

extension PlaylistQuickPlay {
    /// The one of the Home: the lists the phone kept, the real player, and what the store and the engine say of each song (the same words as the page of a playlist).
    @MainActor
    static func app(api: MondropAPIProtocol) -> PlaylistQuickPlay {
        PlaylistQuickPlay(
            api: api,
            cache: FilePlaylistManifestCache.shared,
            player: LocalAudioPlayer.shared,
            isLocal: { SyncEngine.shared.store.fileURL(songKey: $0) != nil },
            state: { track in
                SongState(TrackRowStatus.make(
                    track: track,
                    isLocal: SyncEngine.shared.store.fileURL(songKey: track.songKey) != nil,
                    progress: SyncEngine.shared.progress[track.songKey],
                    isSkipListed: SyncEngine.shared.store.isSkipped(track.songKey)
                ))
            }
        )
    }
}
