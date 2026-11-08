// HomeView.swift — the first thing Mondrop shows (spec 2026-11-08-mondrop-home-spotify-design.md, ADR-0020). Michele, 8 November:
// «No aspetta, non mi piace il "cerca musica" - fai una proposta alla spotify» / «A, si giallo».
//
// A greeting, the field to search (a tap opens Cerca with the keyboard), «Riprendi» (the phone's own queue, kept between launches) and the
// sections the SERVER decided: which exist, in what order, with what title and which songs (rule P — this view computes nothing and
// reads neither the network nor any store). A tap on a song plays it and queues the ones that follow in its row; a long press offers
// what Cerca offers. It is never a blank page: with nothing to show it still has the field and the way to browse.

import SwiftUI

struct HomeView: View {
    @StateObject private var model: HomeModel
    @StateObject private var actions = TrackActions()
    @ObservedObject private var engine = SyncEngine.shared
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var localKeys: Set<String> = []
    #if DEBUG
    @State private var demoPush = false
    #endif

    /// The Player, at full screen (from the «Riprendi» card).
    let onOpenPlayer: () -> Void

    init(onOpenPlayer: @escaping () -> Void) {
        self.onOpenPlayer = onOpenPlayer
        #if DEBUG
        let transport: HomeTransport = DemoData.isOn ? DemoData.Transport() : MondropAPI()
        #else
        let transport: HomeTransport = MondropAPI()
        #endif
        _model = StateObject(wrappedValue: HomeModel(transport: transport))
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
        .safeAreaInset(edge: .top, spacing: 0) { SyncStatusBar() }
        .refreshable { await model.load() }
        // Every time the tab comes into view: what was heard a minute ago is already in «Ascoltati di recente».
        .task {
            localKeys = engine.store.localSongKeys()
            await model.load()
        }
        .onChange(of: engine.revision) { _, _ in localKeys = engine.store.localSongKeys() }
        .trackActions(actions)
        #if DEBUG
        .navigationDestination(isPresented: $demoPush) { PlaylistOfflineView(playlist: DemoData.home.sections[0].playlists[0].playlist) }
        .onAppear { if DemoData.push == "playlist" { demoPush = true } }
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
    }

    @ViewBuilder
    private func sectionView(_ section: HomeSection) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(section.title)
                .font(.title3.bold())
                .foregroundStyle(Color(MondropPalette.text))
                .accessibilityAddTraits(.isHeader)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 14) {
                    switch section.kind {
                    case .playlists:
                        ForEach(section.playlists) { playlist in playlistCard(playlist) }
                    case .tracks:
                        ForEach(section.tracks) { track in trackCard(track, in: section) }
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

    private func playlistCard(_ playlist: HomePlaylist) -> some View {
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
    }

    private func trackCard(_ track: OfflineTrack, in section: HomeSection) -> some View {
        let status = TrackRowStatus.make(
            track: track,
            isLocal: localKeys.contains(track.songKey),
            progress: engine.progress[track.songKey],
            isSkipListed: engine.store.isSkipped(track.songKey)
        )
        return HomeTrackCard(
            track: track, status: status, side: cardSide,
            showsDownload: section.id == "fresh",
            isLocal: localKeys.contains(track.songKey), actions: actions,
            onPlay: { play(track, in: section) }
        )
    }

    /// «Suona e accoda i seguenti»: this song, then the ones that follow it in the row; the queue is called what the row is.
    private func play(_ track: OfflineTrack, in section: HomeSection) {
        guard let queue = SearchPlayback.queue(
            choice: .collection(section.title), tracks: section.tracks, tapped: track.songKey, isLocal: { localKeys.contains($0) }
        ) else {
            actions.show(QueueAppend.Outcome.notPlayable.message)
            return
        }
        LocalAudioPlayer.shared.setQueue(queue.items, startAt: queue.startIndex, playlistId: queue.playlistId, label: queue.label)
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

    /// On the phone (a check), on its way (a spinner), or — in «Nuovi dai tuoi reel» — the button to put it there.
    @ViewBuilder
    private var mark: some View {
        switch status.accessory {
        case .done:
            badge { Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(.green) }
                .accessibilityLabel("Scaricato")
        case .spinner:
            badge { ProgressView().controlSize(.mini).tint(Color(MondropPalette.text)) }
                .accessibilityLabel(status.rowText)
        default:
            if showsDownload && canDownload {
                Button { actions.download(track, status: status) } label: {
                    badge { Image(systemName: "arrow.down").font(.caption.weight(.bold)).foregroundStyle(Color(MondropPalette.accent)) }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Scarica sul telefono")
            }
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
