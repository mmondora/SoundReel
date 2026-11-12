// ReelsView.swift — the tab «Reel» (ADR-0033, spec 2026-11-12-mondrop-home-play-loop-reels-design.md M5). Michele, 12 November: «Voglio avere anche un tab con le altre categorie sul reel
// ( dove però per ora l'unica cosa che viene portata sulla device è la musica ) ma non il link al reel ma la sua scomposizione e spiegazione.»
//
// The reels SoundReel has read for the user, newest first: of each, what it is about (the explanation) and what it holds by category — music, films, software, places, books… — with the
// categories to choose from on top. The SERVER composes it all (rule P): this draws it. There is no link to the reel and no way to open one; the only thing a reel puts on the phone is its
// music, and it is read from the network each time. The manual share form, which used to be a tab, opens from the «+» up here: it is where a new reel comes from.

import SwiftUI

struct ReelsView: View {
    @StateObject private var model: ReelsModel
    @State private var showShare = false
    private let transport: ReelsTransport
    #if DEBUG
    @State private var demoPush = false
    #endif

    init() {
        #if DEBUG
        let transport: ReelsTransport = DemoData.isOn ? DemoData.ReelsAPI() : MondropAPI()
        #else
        let transport: ReelsTransport = MondropAPI()
        #endif
        self.transport = transport
        _model = StateObject(wrappedValue: ReelsModel(transport: transport))
    }

    var body: some View {
        List {
            let kinds = model.kinds
            if !kinds.isEmpty {
                Section {
                    kindChips(kinds)
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
            content
        }
        .navigationTitle("Reel")
        .withMiniPlayer()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showShare = true } label: { Label("Condividi un link", systemImage: "plus") }
            }
        }
        .sheet(isPresented: $showShare) {
            NavigationStack {
                ContentView()
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Chiudi") { showShare = false } }
                    }
            }
        }
        .refreshable { await model.load() }
        .task { if model.phase == .idle { await model.load() } }
        #if DEBUG
        .navigationDestination(isPresented: $demoPush) { ReelDetailView(card: DemoData.reelCards[0], transport: transport) }
        .onAppear { if DemoData.push == "reel" { demoPush = true } }
        #endif
    }

    // MARK: the categories

    /// «Tutti» and one chip per category the server says has reels, with how many: the server decides which exist (a category it invents later appears here by itself).
    private func kindChips(_ kinds: [ReelKindCount]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("Tutti", systemImage: "square.grid.2x2", selected: model.selected == nil) { Task { await model.select(nil) } }
                ForEach(kinds) { count in
                    chip("\(count.label) \(count.count)", systemImage: count.kind.systemImage, selected: model.selected == count.kind) {
                        Task { await model.select(count.kind) }
                    }
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private func chip(_ title: String, systemImage: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
        }
        .buttonStyle(MondropPillStyle(prominent: selected))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: what the server sent

    @ViewBuilder
    private var content: some View {
        switch model.screen {
        case .loading:
            HStack { Spacer(); ProgressView(); Spacer() }
                .listRowBackground(Color.clear)
        case .empty:
            message(model.selected == nil
                ? "Qui compariranno i reel che condividi con Mondrop, spiegati e divisi per categoria."
                : "Nessun reel con questa categoria.")
        case .failed(let text):
            VStack(alignment: .leading, spacing: 10) {
                Text("Non riesco a leggere i reel.").font(.headline)
                Text(text).font(.footnote).foregroundStyle(.secondary)
                Button("Riprova") { Task { await model.load() } }
                    .buttonStyle(MondropPillStyle(prominent: true))
            }
            .listRowBackground(Color.clear)
        case .needsNewerServer:
            message("\(ReelsModel.needsNewerServerText): i reel ci sono dalla versione 2.27.0 del server. Il resto di Mondrop funziona come prima.")
        case .reels:
            ForEach(model.reels) { reel in
                NavigationLink {
                    ReelDetailView(card: reel, transport: transport)
                } label: {
                    ReelCardRow(card: reel)
                }
            }
            if model.hasMore {
                HStack {
                    Spacer()
                    if model.loadingMore { ProgressView() } else { Text("Carica altri").font(.footnote).foregroundStyle(.secondary) }
                    Spacer()
                }
                .listRowBackground(Color.clear)
                .onAppear { Task { await model.loadMore() } }
            }
            if let failure = model.failure {
                Text("Non riesco ad aggiornare: \(failure)")
                    .font(.footnote)
                    .foregroundStyle(Color(MondropPalette.error))
                    .listRowBackground(Color.clear)
            }
        }
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .listRowBackground(Color.clear)
    }
}

// MARK: - A reel in the list

/// A reel: the small picture, what it is about, where and when it was read, and what it holds by category (the first names of each).
struct ReelCardRow: View {
    let card: ReelCard

    private var summary: String? {
        guard let text = card.summary?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ReelThumbnail(reelId: card.id, imagePath: card.imagePath)
                .frame(width: 64, height: 64)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(summary ?? "Senza spiegazione")
                    .font(.subheadline)
                    .foregroundStyle(summary == nil ? secondary : Color(MondropPalette.text))
                    .lineLimit(3)
                Text(card.dateLine())
                    .font(.caption)
                    .foregroundStyle(secondary)
                ForEach(card.counts.prefix(4)) { count in
                    Label {
                        Text(count.chipText).lineLimit(1)
                    } icon: {
                        Image(systemName: count.kind.systemImage)
                    }
                    .font(.caption)
                    .foregroundStyle(secondary)
                }
                if card.counts.count > 4 {
                    Text("+\(card.counts.count - 4) altre categorie")
                        .font(.caption)
                        .foregroundStyle(secondary)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var secondary: Color { Color(MondropPalette.text).opacity(MondropPalette.secondaryTextOpacity) }
}

/// The small picture of a reel, asked of SoundReel when it comes into view. A drawn tile stays until it arrives, and when the server has none.
struct ReelThumbnail: View {
    let reelId: String
    let imagePath: String?
    @State private var data: Data?

    var body: some View {
        ZStack {
            GeneratedCover(title: "", artist: "", seed: reelId, showsText: false, symbol: "rectangle.stack")
            if let data, let image = CoverView.image(from: data) {
                image.resizable().scaledToFill()
            }
        }
        .task(id: reelId) {
            data = await ReelImageLoader.shared.data(reelId: reelId, imagePath: imagePath)
        }
    }
}
