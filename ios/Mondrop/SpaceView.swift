import SwiftUI

/// "Spazio": what the downloaded songs weigh, the least-listened first, and a safe way to delete them.
/// One song = one confirmation; ANY block (several ticked rows, "meno ascoltate", "Libera X MB", "non più in
/// nessuna playlist") = two. Every deletion is logged on the server (see SpaceManager.swift).
struct SpaceView: View {
    @StateObject private var model = SpaceModel(store: .shared, queue: .shared, uploader: .shared, api: MondropAPI())
    /// A download finishing while this screen is open adds a row.
    @ObservedObject private var engine = SyncEngine.shared
    /// The second dialog is shown a beat after the first one has gone, so iOS never drops it.
    @State private var presentSecond = false

    var body: some View {
        List {
            summarySection
            shortcutsSection
            songsSection
        }
        .navigationTitle("Spazio")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Picker("Ordina", selection: $model.sort) {
                        ForEach(SpaceSort.allCases) { sort in Text(sort.label).tag(sort) }
                    }
                    Button("Aggiorna ascolti") { Task { await model.refreshFromServer() } }
                } label: {
                    Label("Ordina", systemImage: "arrow.up.arrow.down")
                }
            }
        }
        .safeAreaInset(edge: .bottom) { selectionBar }
        .onAppear { model.reload() }
        .onChange(of: engine.revision) { _, _ in model.reload() }
        .task { await model.refreshFromServer() }
        .refreshable { await model.refreshFromServer() }
        .confirmationDialog(
            firstText.title,
            isPresented: Binding(
                get: { model.confirmation.isAskingFirst },
                set: { shown in if !shown && model.confirmation.isAskingFirst { model.cancel() } }
            ),
            titleVisibility: .visible
        ) {
            Button(firstText.confirmTitle, role: .destructive) { model.accept() }
            Button(DeletionDialogs.cancelTitle, role: .cancel) { model.cancel() }
        } message: {
            Text(firstText.message)
        }
        .onChange(of: model.confirmation.isAskingSecond) { _, asking in
            if asking {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    if model.confirmation.isAskingSecond { presentSecond = true }
                }
            } else {
                presentSecond = false
            }
        }
        .alert(secondText.title, isPresented: $presentSecond) {
            Button(secondText.confirmTitle, role: .destructive) { model.accept() }
            Button(DeletionDialogs.cancelTitle, role: .cancel) { model.cancel() }
        } message: {
            Text(secondText.message)
        }
    }

    // MARK: sections

    private var summarySection: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text(DeletionDialogs.megabytes(model.usedBytes)).font(.title2.bold())
                Text("\(model.songCount) brani scaricati su questo telefono")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if model.refreshing {
                HStack(spacing: 8) { ProgressView(); Text("Aggiorno gli ascolti…").font(.footnote) }
            }
            if let note = model.refreshNote {
                Text(note).font(.footnote).foregroundStyle(.orange)
            }
            if let message = model.message {
                Text(message).font(.footnote).foregroundStyle(.green)
            }
        }
    }

    private var shortcutsSection: some View {
        Section {
            Stepper(value: $model.leastPlayedCount, in: 1...max(1, model.songCount)) {
                Text("Elimina le \(model.leastPlayedCount) meno ascoltate")
            }
            Button("Elimina le \(model.leastPlayedCount) meno ascoltate…", role: .destructive) {
                model.requestDeleteLeastPlayed()
            }
            .disabled(model.songCount == 0)
            Menu("Libera spazio…") {
                ForEach([100, 250, 500, 1000], id: \.self) { mb in
                    Button(mb >= 1000 ? "\(mb / 1000) GB" : "\(mb) MB") { model.requestFree(mb: mb) }
                }
            }
            .disabled(model.songCount == 0)
            Button("Elimina i brani non più in nessuna playlist…", role: .destructive) {
                Task { await model.requestDeleteOrphans() }
            }
            .disabled(model.songCount == 0 || model.refreshing)
        } header: {
            Text("Scorciatoie")
        } footer: {
            Text("«Meno ascoltate» = meno ascolti contati (su tutti i tuoi dispositivi), poi ascolto più vecchio; i mai ascoltati per primi. Più di un brano = doppia conferma. I brani eliminati restano su SoundReel e il Sync non li riscarica finché non tocchi «Riscarica».")
        }
    }

    private var songsSection: some View {
        Section {
            if model.rows.isEmpty {
                Text("Nessun brano scaricato. Suona una playlist: i brani che mancano si scaricano da soli.").foregroundStyle(.secondary)
            }
            ForEach(model.rows) { row in
                rowView(row)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            model.requestDelete(songKey: row.songKey)
                        } label: {
                            Label("Elimina", systemImage: "trash")
                        }
                    }
            }
        } header: {
            Text("Brani · \(model.sort.label.lowercased())")
        }
    }

    private func rowView(_ row: SpaceRow) -> some View {
        let selected = model.selection.contains(row.songKey)
        return HStack(spacing: 12) {
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(selected ? Color.accentColor : Color.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                Text(row.artist.isEmpty ? detail(row) : "\(row.artist) · \(detail(row))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(DeletionDialogs.megabytes(row.bytes))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .onTapGesture { model.toggle(row.songKey) }
    }

    @ViewBuilder
    private var selectionBar: some View {
        if !model.selection.isEmpty {
            HStack {
                Text("\(model.selection.count) selezionati · \(DeletionDialogs.megabytes(model.selectedBytes))")
                    .font(.footnote)
                Spacer()
                Button("Deseleziona") { model.clearSelection() }
                Button("Elimina…", role: .destructive) { model.requestDeleteSelection() }
                    .buttonStyle(.borderedProminent)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial)
        }
    }

    // MARK: text

    private func detail(_ row: SpaceRow) -> String {
        let plays = row.plays == 1 ? "1 ascolto" : "\(row.plays) ascolti"
        guard row.plays > 0 || row.lastPlayedAt != nil else { return "mai ascoltata" }
        guard let last = row.lastPlayedAt else { return plays }
        return "\(plays) · ultimo \(Self.relative.localizedString(for: last, relativeTo: Date()))"
    }

    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "it_IT")
        formatter.unitsStyle = .full
        return formatter
    }()

    private var openPlan: DeletionPlan? {
        switch model.confirmation.stage {
        case .first(let plan), .second(let plan): return plan
        default: return nil
        }
    }

    private var firstText: DialogText {
        openPlan.map { DeletionDialogs.first($0) } ?? DialogText(title: "Eliminare?", message: "", confirmTitle: "Continua")
    }

    private var secondText: DialogText {
        openPlan.map { DeletionDialogs.second($0) } ?? DialogText(title: "Sei sicuro?", message: "Non si può annullare.", confirmTitle: "Elimina")
    }
}
