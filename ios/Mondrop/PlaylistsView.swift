import SwiftUI

struct PlaylistsView: View {
    // The list is asked to the server a page at a time, with search, filter and sort by date (ADR-0023, rule P).
    @StateObject private var model: PlaylistListModel
    /// What each playlist shows as its mark comes from what the phone has read of it and holds (U9): read again when a download ends or fails.
    @ObservedObject private var engine = SyncEngine.shared
    /// The files on the phone, read when the page appears and when a song arrives or goes (not at every tick of a download).
    @State private var localKeys: Set<String> = []

    init() {
        #if DEBUG
        let transport: PlaylistListTransport = DemoData.isOn ? DemoData.PlaylistListAPI() : MondropAPI()
        #else
        let transport: PlaylistListTransport = MondropAPI()
        #endif
        // the sort the person chose last is kept (`SortPreferences`); the list opens on «Stato», the ones on the phone first
        _model = StateObject(wrappedValue: PlaylistListModel(transport: transport, preferences: SortPreferences(defaults: Settings.shared.storage)))
    }

    var body: some View {
        List {
            if let failure = model.failure {
                Text(failure).foregroundStyle(.red)
            }
            let marks = PlaylistMarks.current(store: engine.store, local: localKeys, progress: engine.progress)
            // «Stato»: the playlists that are on the phone first, then the ones that are only online (or the other way round), the date of creation inside each group; every other
            // sort (date, name, size) is the server's and nothing goes in front of it (spec …-simplify-playlists-and-song-states-design.md §12, U17)
            ForEach(marks.arranged(model.items, by: model.sort, order: model.order, id: \.id, songCount: \.songCount)) { p in
                NavigationLink {
                    PlaylistOfflineView(playlist: p)
                } label: {
                    PlaylistRow(playlist: p, state: marks.state(id: p.id, songCount: p.songCount))
                }
            }
            if model.items.isEmpty && !model.loading && model.failure == nil {
                Text(model.narrowed ? "Nessuna playlist corrisponde" : "Nessuna playlist: creane una")
                    .foregroundStyle(.secondary)
            }
            if model.hasMore {
                Button {
                    Task { await model.loadMore() }
                } label: {
                    HStack {
                        Text("Carica altre")
                        Spacer()
                        Text("\(model.items.count) di \(model.total)").foregroundStyle(.secondary)
                    }
                }
                .disabled(model.loadingMore)
                .onAppear { Task { await model.loadMore() } }
            }
        }
        .navigationTitle("Playlist")
        .withMiniPlayer()
        .searchable(text: Binding(get: { model.text }, set: { model.setText($0) }), prompt: "Cerca nelle playlist")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Picker("Mostra", selection: Binding(get: { model.filter }, set: { model.setFilter($0) })) {
                        ForEach(PlaylistFilter.allCases) { Text($0.title).tag($0) }
                    }
                    Picker("Ordina per", selection: Binding(get: { model.sort }, set: { model.setSort($0) })) {
                        ForEach(PlaylistSort.allCases) { Text($0.title).tag($0) }
                    }
                    Button {
                        model.toggleOrder()
                    } label: {
                        Label(model.sort.orderTitle(model.order), systemImage: model.order == .desc ? "arrow.down" : "arrow.up")
                    }
                    Divider()
                    Button("Aggiorna") { Task { await refreshAll() } }
                } label: {
                    Label("Elenco", systemImage: "line.3.horizontal.decrease.circle")
                }
            }
        }
        .overlay {
            if model.loading && model.items.isEmpty { ProgressView() }
        }
        .safeAreaInset(edge: .bottom) {
            if model.total > 0 {
                Text(model.hasMore ? "\(model.items.count) di \(model.total) playlist" : "\(model.total) playlist")
                    .font(.footnote)
                    .padding(8)
                    .frame(maxWidth: .infinity)
                    .background(.ultraThinMaterial)
            }
        }
        .onAppear { localKeys = engine.store.localSongKeys() }
        .onChange(of: engine.revision) { _, _ in localKeys = engine.store.localSongKeys() }
        .task { await refreshAll() }
    }

    private func refreshAll() async {
        await model.reload()
        // A playlist deleted on the server no longer protects its songs from "Libera spazio": that needs EVERY playlist, not a page.
        if let all = try? await MondropAPI().listPlaylists() {
            OfflineStore.shared.pruneMemberships(keeping: Set(all.map(\.id)))
            FilePlaylistManifestCache.shared.prune(keeping: Set(all.map(\.id)))      // and the lists kept for their pages
            // The names Siri can be asked for by voice («metti la playlist X su Mondrop»): every playlist the screen knows, not a page.
            PlaylistCatalog.shared.remember(all, user: Settings.shared.autheliaUsername)
        }
    }
}

/// One row of the list: the name, the labels (dynamic, automatic), the DATE OF CREATION beside the name, and how many songs.
private struct PlaylistRow: View {
    let playlist: MondropPlaylist
    /// The mark of the playlist: on the phone, online, error (nothing for an empty one).
    let state: PlaylistState?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                PlaylistStateMark(state: state)
                Text(playlist.name).font(.headline)
                if playlist.isDynamic { DynamicBadge() }
                if playlist.isAuto { AutoBadge() }
                Spacer(minLength: 8)
                let created = PlaylistDateText.text(playlist.createdAt)
                if !created.isEmpty {
                    Text(created)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .accessibilityLabel("Creata \(created)")
                }
            }
            if playlist.isDynamic, let summary = playlist.ruleSummary, !summary.isEmpty {
                Text(summary).font(.footnote).foregroundStyle(.secondary)
            }
            Text(playlist.isDynamic && playlist.songCount == 0 ? "si calcola quando la apri" : "\(playlist.songCount) brani")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

/// The page of a playlist: the list and «Suona» (Michele, 11 November: «quando da homepage clicco sulla playlist devo vedere la lista e poter mettere in play. Nessun sync
/// evidente, tutto automatico»; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U11, U12). The list is there in the first frame when the phone has read the
/// playlist before (`PlaylistManifestCache`) and SoundReel is asked again behind it; there is no «Sync», no counters and no line about the network on the page — the playlist
/// that plays downloads by itself, and the mark of each song says where its file is. What is on the phone is listed first, then what is online (`SongSort.state`, the default), unless the
/// person chose another order from the menu (Michele, 11 November, after build 18: «Voglio in tutte le playlist anche degli ordinamenti tipo : data di creazione, nome, stato ( locali o
/// online )»); and «Scarica tutta» (`PlaylistDownloadAll`) is the button the person presses to have the whole playlist on the phone («Inoltre su una playlist voglio anche il bottone
/// 'scarica tutta'»; spec …-simplify-playlists-and-song-states-design.md §12, U18 and U20).
struct PlaylistOfflineView: View {
    let playlist: MondropPlaylist
    @StateObject private var model: PlaylistSyncCoordinator
    /// The sync that the person asks for with «Scarica tutta», and the question over the limit that it may ask.
    @StateObject private var download: PlaylistDownloadAll
    @StateObject private var questions: SizeQuestionPresenter
    @ObservedObject private var engine = SyncEngine.shared
    @ObservedObject private var player = LocalAudioPlayer.shared
    /// The files on the phone, read when the page appears and when a song arrives or goes (not at every tick of a download).
    @State private var localKeys: Set<String> = []
    @State private var youtubeTarget: OfflineTrack?
    @State private var youtubeText = ""
    /// The order of the songs the person chose (kept between launches: `SortPreferences`).
    @State private var songSort: SongSort
    @State private var songOrder: PlaylistOrder
    /// The line at the bottom after «Togli dalla playlist» («Tolto da «Road trip»», or why it did not work).
    @StateObject private var actions = TrackActions()

    init(playlist: MondropPlaylist) {
        self.playlist = playlist
        #if DEBUG
        let api: MondropAPIProtocol = DemoData.isOn ? DemoData.PlaylistAPI() : MondropAPI()
        #else
        let api: MondropAPIProtocol = MondropAPI()
        #endif
        let saved = SortPreferences(defaults: Settings.shared.storage).songs
        _songSort = State(initialValue: saved.sort)
        _songOrder = State(initialValue: saved.order)
        let presenter = SizeQuestionPresenter()
        _questions = StateObject(wrappedValue: presenter)
        _download = StateObject(
            wrappedValue: PlaylistDownloadAll(
                playlist: playlist,
                api: api,
                engine: .shared,
                limit: { Settings.shared.syncWarnLimit },
                questions: presenter,
                activity: .shared,
                // the right moment to ask iOS for notifications, once: the person has just asked for a sync of their own
                onSyncStarted: {
                    Task { await SyncNotifier.shared.ensurePermission() }
                    Task { await InboxWiring.refreshPlaylistsCache() }
                },
                cache: FilePlaylistManifestCache.shared
            )
        )
        _model = StateObject(
            wrappedValue: PlaylistSyncCoordinator(
                playlist: playlist,
                api: api,
                engine: .shared,
                activity: .shared,
                // The right moment to ask iOS for notifications, once: the user has just asked for a sync (a «Riprova» on a song). And to refresh the
                // playlists the share sheet offers.
                onSyncStarted: {
                    Task { await SyncNotifier.shared.ensurePermission() }
                    Task { await InboxWiring.refreshPlaylistsCache() }
                },
                cache: FilePlaylistManifestCache.shared
            )
        )
    }

    var body: some View {
        #if DEBUG && os(iOS)
        // simulator screenshots only (`-MondropDemoMetrics`): the numbers of the scrolling view, to check the room left for the mini player
        content.demoMetrics()
        #else
        content
        #endif
    }

    private var content: some View {
        List {
            if let manifest = model.manifest {
                if playlist.isDynamic || manifest.dynamic { dynamicSection(manifest) }
                playRow(manifest)
                Section {
                    ForEach(arranged(manifest)) { track in
                        row(track, in: manifest)
                    }
                } header: {
                    stateHeader(manifest)
                }
                if let error = model.errorText {
                    Text("Non riesco ad aggiornare: \(error)")
                        .font(.footnote)
                        .foregroundStyle(Color(MondropPalette.error))
                }
            } else if model.phase == .loading {
                HStack { Spacer(); ProgressView(); Spacer() }
                    .listRowBackground(Color.clear)
            } else if let error = model.errorText {
                VStack(alignment: .leading, spacing: 10) {
                    Text(error).foregroundStyle(Color(MondropPalette.error))
                    Button("Riprova") { Task { await model.load() } }
                        .buttonStyle(MondropPillStyle(prominent: true))
                }
                .listRowBackground(Color.clear)
            }
        }
        .navigationTitle(playlist.name)
        .withMiniPlayer()
        .trackActions(actions)
        .toolbar {
            // the order of the songs: «Stato» (the phone first) is where it starts, the person chooses the rest (a list of one song has nothing to order)
            if let manifest = model.manifest, manifest.tracks.count > 1 {
                ToolbarItem(placement: .primaryAction) { sortMenu(manifest) }
            }
        }
        .task { await model.load() }
        .refreshable { await model.load() }
        .onAppear { localKeys = engine.store.localSongKeys() }
        .onChange(of: engine.revision) { _, _ in localKeys = engine.store.localSongKeys() }
        // «Scarica tutta» ended: the list is read again (what the server prepared meanwhile shows with its new state)
        .onChange(of: download.working) { _, working in
            if !working { Task { await model.load() } }
        }
        // the question over the limit comes over this page; if the page is left with it open the question goes away (a sync that was asking ends, downloading nothing)
        .syncSizeDialog(questions)
        .onDisappear { questions.withdraw() }
        .alert("Link YouTube", isPresented: Binding(
            get: { youtubeTarget != nil },
            set: { if !$0 { youtubeTarget = nil } }
        )) {
            TextField("https://www.youtube.com/watch?v=…", text: $youtubeText)
            Button("Usa questo link") {
                if let target = youtubeTarget {
                    let text = youtubeText
                    Task { await model.setYouTubeSource(songKey: target.songKey, urlText: text) }
                }
                youtubeTarget = nil
                youtubeText = ""
            }
            Button("Annulla", role: .cancel) {
                youtubeTarget = nil
                youtubeText = ""
            }
        } message: {
            Text("Per «\(youtubeTarget?.title ?? "")»: il server lo scarica da quel video.")
        }
    }

    // MARK: the top of the page

    /// «Suona», «Mescola» and «Scarica tutta», right under the title, on ONE line and with icons only (Michele, 11 November, seeing build 19: «I bottoni devono stare sulla strada riga.
    /// Piuttosto metti solo icona.»): the first thing on the page. Each keeps its words for VoiceOver.
    private func playRow(_ manifest: OfflineManifest) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                Button { play(nil, shuffled: false, in: manifest) } label: { Label("Suona", systemImage: "play.fill").labelStyle(.iconOnly) }
                    .buttonStyle(MondropIconPillStyle(prominent: true))
                    // «sul play voglio anche il "loop" del singolo o della playlist» (Michele, 12 November): a long press on the play offers the loop here too
                    .contextMenu {
                        Button { play(nil, shuffled: false, loop: true, in: manifest) } label: { Label("Suona in loop", systemImage: "repeat") }
                    }
                Button { play(nil, shuffled: true, in: manifest) } label: { Label("Mescola", systemImage: "shuffle").labelStyle(.iconOnly) }
                    .buttonStyle(MondropIconPillStyle(prominent: false))
                downloadButton(manifest)
                Spacer(minLength: 0)
            }
            .disabled(manifest.tracks.isEmpty)
            .opacity(manifest.tracks.isEmpty ? 0.4 : 1)
            if let error = download.errorText {
                Text("Non riesco a scaricare: \(error)")
                    .font(.footnote)
                    .foregroundStyle(Color(MondropPalette.error))
            }
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    /// «Scarica tutta»: the person's own way to have the whole playlist on the phone (the automatic sync is for the playlist that plays). An icon like the other two; VoiceOver hears what it
    /// would bring («Scarica tutta: 5 brani · 420 MB»); a spinner while it works (the server may be preparing what it had not prepared); not there when nothing could come.
    @ViewBuilder
    private func downloadButton(_ manifest: OfflineManifest) -> some View {
        let state = PlaylistDownloadState.make(
            tracks: manifest.tracks,
            isLocal: { localKeys.contains($0) },
            isSkipped: { engine.store.isSkipped($0) },
            progress: { engine.progress[$0] },
            busy: download.working
        )
        if state.kind != .none {
            let atWork: Bool = { if case .working = state.kind { return true } else { return false } }()
            Button { download.start() } label: {
                Label {
                    Text(state.title)
                } icon: {
                    if atWork { ProgressView() } else { Image(systemName: "arrow.down.circle") }
                }
                .labelStyle(.iconOnly)
            }
            .buttonStyle(MondropIconPillStyle(prominent: false))
            .disabled(atWork)
            .accessibilityLabel([state.title, state.detail].compactMap { $0 }.joined(separator: ": "))
        }
    }

    // MARK: the order of the songs

    /// What the menu and the list use: the choice of the person, unless it is «Data di aggiunta» and this playlist has no dates (SoundReel older than 2.26.0, or a dynamic playlist),
    /// when it is the first sort.
    private func effectiveSort(_ manifest: OfflineManifest) -> (sort: SongSort, order: PlaylistOrder) {
        SongSort.available(for: manifest.tracks).contains(songSort) ? (songSort, songOrder) : (.state, SongSort.state.naturalOrder)
    }

    private func sortMenu(_ manifest: OfflineManifest) -> some View {
        let current = effectiveSort(manifest)
        return Menu {
            Picker("Ordina per", selection: Binding(get: { current.sort }, set: { chooseSort($0) })) {
                ForEach(SongSort.available(for: manifest.tracks)) { Text($0.title).tag($0) }
            }
            Button {
                songSort = current.sort
                songOrder = current.order == .desc ? .asc : .desc
                SortPreferences(defaults: Settings.shared.storage).songs = (songSort, songOrder)
            } label: {
                Label(current.sort.orderTitle(current.order), systemImage: current.order == .desc ? "arrow.down" : "arrow.up")
            }
        } label: {
            Label("Ordina", systemImage: "arrow.up.arrow.down")
        }
    }

    /// Choosing a sort puts its natural direction; the arrow then flips it. The choice is kept.
    private func chooseSort(_ sort: SongSort) {
        songSort = sort
        songOrder = sort.naturalOrder
        SortPreferences(defaults: Settings.shared.storage).songs = (songSort, songOrder)
    }

    /// A playlist made by a rule says so, and says that the rule decides (there is nothing to sync by hand: it is recalculated by itself).
    private func dynamicSection(_ manifest: OfflineManifest) -> some View {
        Section {
            HStack(spacing: 8) {
                DynamicBadge()
                Text(playlist.ruleSummary ?? "Playlist dinamica").font(.subheadline)
            }
            if let generated = manifest.generatedDate {
                Text("Calcolata \(generated.formatted(date: .abbreviated, time: .shortened)). Si ricalcola da sola; i brani li decide la regola (qui è in sola lettura).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Text("I brani li decide la regola e si ricalcolano da soli (qui è in sola lettura).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// The mark of the whole playlist and «12 di 20 sul telefono» (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U9), over the songs.
    @ViewBuilder
    private func stateHeader(_ manifest: OfflineManifest) -> some View {
        let summary = PlaylistStateSummary(songs: manifest.tracks.map { SongState(status(of: $0)) })
        if let words = summary.headerText {
            HStack(spacing: 8) {
                PlaylistStateMark(state: summary.state, font: .subheadline)
                Text(words).font(.subheadline)
            }
            .textCase(nil)
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: the songs

    private func status(of track: OfflineTrack) -> TrackRowStatus {
        TrackRowStatus.make(
            track: track,
            isLocal: localKeys.contains(track.songKey),
            progress: engine.progress[track.songKey],
            isSkipListed: engine.store.isSkipped(track.songKey)
        )
    }

    /// The songs as they are listed: by default the ones on the phone first, then the online ones, then the errors, the playlist's own order inside each group; otherwise the order
    /// the person chose from the menu (`SongSort`).
    private func arranged(_ manifest: OfflineManifest) -> [OfflineTrack] {
        let chosen = effectiveSort(manifest)
        return SongSort.sorted(manifest.tracks, by: chosen.sort, order: chosen.order) { SongState(status(of: $0)) }
    }

    /// Only the user's own static playlists take songs out by hand (`PlaylistRowActions`).
    private var canRemoveSongs: Bool {
        PlaylistRowActions.canRemoveSongs(from: playlist, dynamicManifest: model.manifest?.dynamic ?? false)
    }

    private func remove(_ track: OfflineTrack) {
        Task {
            let outcome = await model.removeSong(songKey: track.songKey, using: MondropAPI())
            actions.show(outcome.message)
        }
    }

    private func row(_ track: OfflineTrack, in manifest: OfflineManifest) -> some View {
        let status = status(of: track)
        return HStack {
            Button {
                play(track.songKey, shuffled: false, in: manifest)
            } label: {
                SongRowView(
                    track: track, status: status,
                    isCurrent: player.currentSongKey == track.songKey, isPlaying: player.playing
                )
            }
            .buttonStyle(.plain)
            if status.canRedownload {
                Button("Riscarica") { Task { await model.redownload(songKey: track.songKey) } }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
            if status.canRetry {
                Button("Riprova") { Task { await model.retry(songKey: track.songKey) } }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
            if status.canSetSource {
                Button("Link") {
                    youtubeText = ""
                    youtubeTarget = track
                }
                .buttonStyle(.borderless)
                .font(.caption)
            }
        }
        // «il remove è in swipe sulla playlist»: the swipe takes the song out of THIS playlist and deletes nothing from the phone.
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if canRemoveSongs {
                Button { remove(track) } label: {
                    Label("Togli dalla playlist", systemImage: "minus.circle")
                }
                .tint(Color(MondropPalette.error))
            }
        }
    }

    /// The playlist as the queue («In coda: Playlist · Road trip»), from the tapped song — or from the top / shuffled. A tap plays this song and the ones that follow ON THE SCREEN, in
    /// the order the person sees (by default the phone's songs first: «Vanno privilegiati i file già scaricati»); «Mescola» mixes them, each group on its own and the phone's first
    /// (`localFirst`). A song the server found no source for is left out unless it is already on the phone.
    private func play(_ songKey: String?, shuffled: Bool, loop: Bool = false, in manifest: OfflineManifest) {
        guard let queue = LibraryQueueBuilder.make(
            choice: .playlist(id: playlist.id, name: playlist.name),
            tracks: arranged(manifest),
            startAt: songKey,
            shuffled: shuffled,
            localFirst: shuffled,
            isLocal: { engine.store.fileURL(songKey: $0) != nil }
        ) else { return }
        if loop { player.setRepeatMode(.all) }           // «Suona in loop»: the whole playlist goes round, from the first song
        player.start(queue)
    }
}

/// "DINAMICA": the songs come from a rule, not from a hand-made list.
struct DynamicBadge: View {
    var body: some View {
        Text("DINAMICA")
            .font(.system(size: 9, weight: .heavy, design: .monospaced))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.accentColor.opacity(0.18), in: Capsule())
            .foregroundStyle(Color.accentColor)
            .accessibilityLabel("Playlist dinamica")
    }
}

/// A playlist the server made from a post that talks about music (ADR-0023).
struct AutoBadge: View {
    var body: some View {
        Text("AUTOMATICA")
            .font(.system(size: 9, weight: .heavy, design: .monospaced))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.accentColor.opacity(0.18), in: Capsule())
            .foregroundStyle(Color.accentColor)
            .accessibilityLabel("Playlist automatica")
    }
}
