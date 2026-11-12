// ReelDetailView.swift — the page of one reel (ADR-0033, spec 2026-11-12-mondrop-home-play-loop-reels-design.md M5): «la sua scomposizione e spiegazione».
//
// «Di cosa parla» (the explanation the analysis wrote), what the reel holds by category, the explanations the local model wrote about the things it mentions («Approfondimenti», said to be
// generated and possibly wrong), the verdict when the post claims something, a carousel slide by slide, and its keywords. The MUSIC is made of songs like every list of songs in the app: a tap plays
// this one and the ones after it, the three marks say where each file is, a long press offers what Cerca offers; everything else is text read from SoundReel and kept nowhere on the phone.
// There is no link to the reel here, and nothing opens an address.

import SwiftUI

struct ReelDetailView: View {
    /// What the list already knew of this reel: the explanation shows at once while the page is read.
    let card: ReelCard
    @StateObject private var model: ReelDetailModel
    @StateObject private var actions = TrackActions()
    @ObservedObject private var engine = SyncEngine.shared
    @ObservedObject private var player = LocalAudioPlayer.shared
    /// The files on the phone, read when the page appears and when a song arrives or goes (not at every tick of a download).
    @State private var localKeys: Set<String> = []

    init(card: ReelCard, transport: ReelsTransport) {
        self.card = card
        _model = StateObject(wrappedValue: ReelDetailModel(id: card.id, transport: transport))
    }

    var body: some View {
        List {
            headerSection
            switch model.phase {
            case .idle, .loading:
                if model.detail == nil {
                    HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear)
                }
            case .gone:
                Text(ReelDetailModel.goneText).font(.subheadline).foregroundStyle(.secondary).listRowBackground(Color.clear)
            case .failed(let text):
                VStack(alignment: .leading, spacing: 10) {
                    Text(text).font(.subheadline).foregroundStyle(Color(MondropPalette.error))
                    Button("Riprova") { Task { await model.load() } }
                        .buttonStyle(MondropPillStyle(prominent: true))
                }
                .listRowBackground(Color.clear)
            case .loaded:
                EmptyView()
            }
            if let detail = model.detail {
                verdictSection(detail)
                ForEach(detail.sections) { section in sectionView(section, in: detail) }
                insightsSection(detail)
                slidesSection(detail)
                tagsSection(detail)
            }
            if let failure = model.failure {
                Text("Non riesco ad aggiornare: \(failure)")
                    .font(.footnote)
                    .foregroundStyle(Color(MondropPalette.error))
                    .listRowBackground(Color.clear)
            }
        }
        .navigationTitle("Reel")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .withMiniPlayer()
        .trackActions(actions)
        .task { await model.load() }
        .refreshable { await model.load() }
        .onAppear { localKeys = engine.store.localSongKeys() }
        .onChange(of: engine.revision) { _, _ in localKeys = engine.store.localSongKeys() }
    }

    // MARK: the top: the picture, where and when, what it is about

    private var explanation: String? {
        if let detail = model.detail { return detail.explanation }
        guard let text = card.summary?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }

    private var headerSection: some View {
        Section {
            HStack(alignment: .top, spacing: 12) {
                ReelThumbnail(reelId: card.id, imagePath: model.detail?.imagePath ?? card.imagePath)
                    .frame(width: 88, height: 88)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityHidden(true)
                Text((model.detail?.dateLine() ?? card.dateLine()))
                    .font(.footnote)
                    .foregroundStyle(secondary)
                Spacer(minLength: 0)
            }
            .listRowBackground(Color.clear)
            VStack(alignment: .leading, spacing: 6) {
                Text("Di cosa parla")
                    .font(.caption.weight(.heavy))
                    .tracking(1.5)
                    .foregroundStyle(Color(MondropPalette.accent))
                    .accessibilityAddTraits(.isHeader)
                Text(explanation ?? "Questo reel non ha una spiegazione.")
                    .font(.body)
                    .foregroundStyle(explanation == nil ? secondary : Color(MondropPalette.text))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: the verdict, when the post claims something

    @ViewBuilder
    private func verdictSection(_ detail: ReelDetail) -> some View {
        if let verdict = detail.verdict {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Verdetto: \(verdict.label)", systemImage: "checkmark.seal")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color(MondropPalette.text))
                    if let why = verdict.explanation, !why.isEmpty {
                        Text(why).font(.footnote).foregroundStyle(secondary)
                    }
                    Text("Generato dall'IA: può sbagliare.").font(.caption2).foregroundStyle(secondary)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    // MARK: what it holds, by category

    @ViewBuilder
    private func sectionView(_ section: ReelSection, in detail: ReelDetail) -> some View {
        if section.kind == .music {
            if !section.tracks.isEmpty { musicSection(section) }
        } else if !section.items.isEmpty {
            Section {
                ForEach(Array(section.items.enumerated()), id: \.offset) { _, item in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title).font(.subheadline).foregroundStyle(Color(MondropPalette.text))
                        if let extra = item.detail, !extra.isEmpty {
                            Text(extra).font(.caption).foregroundStyle(secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Label(section.title, systemImage: section.kind.systemImage)
            }
        }
    }

    /// The songs of the reel: the ones on the phone are marked, a tap plays this one and the ones after it, and «Suona tutta» plays all of them.
    private func musicSection(_ section: ReelSection) -> some View {
        Section {
            Button {
                playAll(section)
            } label: {
                // an HStack, not a Label: in a row of a list the system may drop the title of a Label and leave the icon alone (seen on the simulator)
                HStack(spacing: 6) {
                    Image(systemName: "play.fill")
                    Text("Suona tutta")
                }
            }
            .buttonStyle(MondropPillStyle(prominent: true))
            .listRowBackground(Color.clear)
            ForEach(section.tracks) { track in
                musicRow(track, in: section)
            }
        } header: {
            Label(section.title, systemImage: section.kind.systemImage)
        }
    }

    private func musicRow(_ track: OfflineTrack, in section: ReelSection) -> some View {
        let status = status(of: track)
        return Button {
            play(track, in: section)
        } label: {
            SongRowView(track: track, status: status, isCurrent: player.currentSongKey == track.songKey, isPlaying: player.playing)
        }
        .buttonStyle(.plain)
        .contextMenu {
            LikeMenuButton(songKey: track.songKey) { actions.likeToggled(track, liked: $0) }
            Button { actions.addToQueue(track, isLocal: localKeys.contains(track.songKey)) } label: {
                Label("Aggiungi in coda", systemImage: "text.badge.plus")
            }
            Button { actions.askPlaylist(for: track) } label: {
                Label("Aggiungi a playlist…", systemImage: "music.note.list")
            }
            if status.canRedownload || status.kind == .readyOnServer {
                Button { actions.download(track, status: status) } label: {
                    Label("Scarica sul telefono", systemImage: "arrow.down.circle")
                }
            }
        }
    }

    private func status(of track: OfflineTrack) -> TrackRowStatus {
        TrackRowStatus.make(
            track: track,
            isLocal: localKeys.contains(track.songKey),
            progress: engine.progress[track.songKey],
            isSkipListed: engine.store.isSkipped(track.songKey)
        )
    }

    private var queueChoice: LibraryChoice {
        .collection("Reel · \(model.detail?.dateLine() ?? card.dateLine())")
    }

    /// «Suona e accoda i seguenti»: this song, then the ones that follow it in the reel.
    private func play(_ track: OfflineTrack, in section: ReelSection) {
        guard let queue = SearchPlayback.queue(
            choice: queueChoice, tracks: section.tracks, tapped: track.songKey, isLocal: { localKeys.contains($0) }
        ) else {
            actions.show(QueueAppend.Outcome.notPlayable.message)
            return
        }
        LocalAudioPlayer.shared.start(queue)
    }

    private func playAll(_ section: ReelSection) {
        guard let queue = SearchPlayback.queue(
            choice: queueChoice, tracks: section.tracks, shuffled: false, isLocal: { localKeys.contains($0) }
        ) else {
            actions.show(QueueAppend.Outcome.notPlayable.message)
            return
        }
        LocalAudioPlayer.shared.start(queue)
    }

    // MARK: the explanations of the model, the slides, the keywords

    /// What the local model wrote about the things the reel mentions. Said to be generated: it is not always exact.
    @ViewBuilder
    private func insightsSection(_ detail: ReelDetail) -> some View {
        if !detail.insights.isEmpty {
            Section {
                ForEach(Array(detail.insights.enumerated()), id: \.offset) { _, insight in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(insight.label).font(.subheadline.weight(.semibold)).foregroundStyle(Color(MondropPalette.text))
                        Text(insight.text).font(.footnote).foregroundStyle(secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Label("Approfondimenti", systemImage: "sparkles")
            } footer: {
                Text("Generato dall'IA: può sbagliare.")
            }
        }
    }

    @ViewBuilder
    private func slidesSection(_ detail: ReelDetail) -> some View {
        if !detail.slides.isEmpty {
            Section {
                ForEach(Array(detail.slides.enumerated()), id: \.offset) { _, slide in
                    HStack(alignment: .top, spacing: 10) {
                        Text("\(slide.index + 1)")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Color(MondropPalette.onAccent))
                            .frame(width: 22, height: 22)
                            .background(Color(MondropPalette.accent), in: Circle())
                            .accessibilityHidden(true)
                        Text(slide.summary).font(.footnote).foregroundStyle(Color(MondropPalette.text))
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Slide \(slide.index + 1): \(slide.summary)")
                }
            } header: {
                Label("Slide per slide", systemImage: "rectangle.on.rectangle")
            }
        }
    }

    @ViewBuilder
    private func tagsSection(_ detail: ReelDetail) -> some View {
        if !detail.tags.isEmpty {
            Section {
                Text(detail.tags.map { "#\($0)" }.joined(separator: "  "))
                    .font(.footnote)
                    .foregroundStyle(secondary)
            } header: {
                Label("Parole chiave", systemImage: "number")
            }
        }
    }

    private var secondary: Color { Color(MondropPalette.text).opacity(MondropPalette.secondaryTextOpacity) }
}
