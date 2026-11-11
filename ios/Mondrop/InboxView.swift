// InboxView.swift — «Posta»: the notifications of my shares and the shares others made with me (spec IN1–IN4).
// Everything that decides (what is shown, unread counts, what a swipe or «Riprova» sends) is tested in MondropKit
// (`InboxModel`); this file draws it.

import SwiftUI

struct InboxView: View {
    enum Part: String, CaseIterable, Identifiable {
        case notifications, received
        var id: String { rawValue }
    }

    @ObservedObject private var inbox = InboxModel.shared
    @State private var part: Part
    @State private var onScreen = false
    /// The answer to the last «Riprova» of each error, shown under its buttons.
    @State private var notes: [String: RowNote] = [:]
    @Environment(\.openURL) private var openURL

    init(initialPart: Part = .notifications) {
        _part = State(initialValue: initialPart)
    }

    struct RowNote: Equatable {
        let text: String
        let isError: Bool
    }

    private struct ReadTrigger: Equatable {
        let part: Part
        let onScreen: Bool
        let refreshedAt: Date?
    }

    var body: some View {
        List {
            Section {
                Picker("Posta", selection: $part) {
                    Text(title(for: .notifications)).tag(Part.notifications)
                    Text(title(for: .received)).tag(Part.received)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            .listRowBackground(Color.clear)

            if let message = inbox.error {
                Section {
                    Label("Non riesco ad aggiornare la posta: \(message)", systemImage: "wifi.exclamationmark")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }

            switch part {
            case .notifications: notificationsSection
            case .received: receivedSection
            }
        }
        .navigationTitle("Posta")
        .withMiniPlayer()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Segna tutto come letto", systemImage: "envelope.open") { Task { await inbox.markAllRead() } }
                        .disabled(inbox.unread == 0)
                    Button("Aggiorna", systemImage: "arrow.clockwise") { Task { await inbox.refresh(.pull, postaVisible: true) } }
                } label: {
                    Label("Altro", systemImage: "ellipsis.circle")
                }
            }
        }
        .refreshable { await inbox.refresh(.pull, postaVisible: true) }
        .task {
            // The first time this screen is needed is the first time iOS is asked for notifications. Not waited for:
            // the list loads while the system alert is up.
            Task {
                await InboxWiring.ensurePermissionIfNeeded()
                await InboxWiring.reconcilePush()
            }
            await inbox.refresh(.open, postaVisible: true)
        }
        // What is on screen counts as read — after a moment, so the user sees what is new first.
        .task(id: ReadTrigger(part: part, onScreen: onScreen, refreshedAt: inbox.lastRefreshAt)) {
            guard part == .notifications, onScreen else { return }
            try? await Task.sleep(for: .seconds(1.5))
            if Task.isCancelled { return }
            await inbox.markVisibleRead()
        }
        .onAppear {
            onScreen = true
            inbox.postaOnScreen = true
        }
        .onDisappear {
            onScreen = false
            inbox.postaOnScreen = false
        }
    }

    private func title(for part: Part) -> String {
        switch part {
        case .notifications:
            let n = inbox.visibleNotifications.filter { !$0.isRead }.count
            return n > 0 ? "Notifiche (\(n))" : "Notifiche"
        case .received:
            let n = inbox.unseenReceived
            return n > 0 ? "Ricevute (\(n))" : "Ricevute"
        }
    }

    // MARK: notifications

    @ViewBuilder
    private var notificationsSection: some View {
        let items = inbox.visibleNotifications
        if items.isEmpty {
            Section {
                Text("Nessuna notifica. Qui arrivano gli esiti dei link che condividi e gli avvisi di chi condivide con te: spariscono dopo 3 giorni, gli errori restano.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } else {
            Section {
                ForEach(items) { item in
                    NotificationRow(
                        item: item,
                        resentAt: inbox.resent[item.id],
                        note: notes[item.id],
                        onOpen: { open(item) },
                        onRetry: { retry(item) },
                        onDelete: { Task { await inbox.delete(item.id) } }
                    )
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button(role: .destructive) {
                            Task { await inbox.delete(item.id) }
                        } label: {
                            Label("Elimina", systemImage: "trash")
                        }
                    }
                    .swipeActions(edge: .leading) {
                        if !item.isRead {
                            Button { Task { await inbox.markRead(item.id) } } label: {
                                Label("Letta", systemImage: "envelope.open")
                            }
                            .tint(.blue)
                        }
                    }
                }
            }
        }
    }

    private func open(_ item: InboxNotification) {
        Task { await inbox.markRead(item.id) }
        if let text = item.url, let url = URL(string: text) { openURL(url) }
    }

    private func retry(_ item: InboxNotification) {
        notes[item.id] = RowNote(text: "Invio…", isError: false)
        Task {
            switch await inbox.retry(item) {
            case .sent(let outcome):
                notes[item.id] = RowNote(text: item.retryAction?.sentNote(outcome.headline) ?? "Rimandato: \(outcome.headline)", isError: false)
            case .failed(let reason):
                notes[item.id] = RowNote(text: reason, isError: true)
            case .noLink:
                notes[item.id] = RowNote(text: "Questa notifica non ha un link da rimandare.", isError: true)
            }
        }
    }

    // MARK: received shares

    @ViewBuilder
    private var receivedSection: some View {
        if inbox.received.isEmpty {
            Section {
                Text("Nessuna condivisione ricevuta. Qui compaiono le voci che archi, sara o mike condividono con te.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } else {
            Section {
                ForEach(inbox.received) { share in
                    Button {
                        Task { await inbox.markSeen(share.entryId) }
                        if let text = share.url, let url = URL(string: text) { openURL(url) }
                    } label: {
                        ReceivedRow(share: share)
                    }
                    .buttonStyle(.plain)
                }
            } footer: {
                Text("Le condivisioni ricevute non scadono: restano finché chi le ha fatte non le ritira.")
            }
        }
    }
}

// MARK: - Rows

private let relativeFormatter: RelativeDateTimeFormatter = {
    let f = RelativeDateTimeFormatter()
    f.locale = Locale(identifier: "it_IT")
    f.unitsStyle = .short
    return f
}()

private func relative(_ date: Date?) -> String {
    guard let date else { return "" }
    return relativeFormatter.localizedString(for: date, relativeTo: Date())
}

private struct NotificationRow: View {
    let item: InboxNotification
    let resentAt: Date?
    let note: InboxView.RowNote?
    let onOpen: () -> Void
    let onRetry: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(item.isRead ? Color.clear : Color.accentColor)
                .frame(width: 9, height: 9)
                .padding(.top, 7)
                .accessibilityLabel(item.isRead ? "Letta" : "Da leggere")
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: icon)
                        .foregroundStyle(item.isError ? Color.red : Color.green)
                    Text(item.title)
                        .font(.headline)
                        .foregroundStyle(item.isError ? Color.red : Color.primary)
                }
                if !item.body.isEmpty {
                    Text(item.body)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(footer)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                if item.isError {
                    // «Riprova senza playlist» when the playlist was the problem; a second choice (and quieter) while
                    // the server keeps trying by itself.
                    let retry = item.retryAction
                    HStack(spacing: 18) {
                        if let retry, retry.isPrimary { Button(retry.label, action: onRetry) }
                        if item.url != nil { Button("Apri", action: onOpen) }
                        Button("Elimina", role: .destructive, action: onDelete)
                        if let retry, !retry.isPrimary {
                            Button(retry.label, action: onRetry)
                                .fontWeight(.regular)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.borderless)
                    .font(.subheadline.weight(.semibold))
                    .padding(.top, 2)
                    if let note {
                        Text(note.text)
                            .font(.footnote)
                            .foregroundStyle(note.isError ? Color.red : Color.secondary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .onTapGesture { if !item.isError { onOpen() } }
    }

    private var icon: String {
        if item.isError { return "exclamationmark.triangle.fill" }
        switch item.kind {
        case "share_received": return "person.crop.circle.badge.plus"
        case "auto_playlist": return "music.note.list"        // a playlist the server made from a post (ADR-0023)
        default: return "checkmark.circle.fill"
        }
    }

    private var footer: String {
        var parts: [String] = []
        let when = relative(item.createdAt)
        if !when.isEmpty { parts.append(when) }
        if item.isError, let resentAt { parts.append("rimandato \(relative(resentAt))") }
        if item.isError { parts.append(item.errorFootnote) }
        return parts.joined(separator: " · ")
    }
}

private struct ReceivedRow: View {
    let share: ReceivedShare

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(share.seen ? Color.clear : Color.accentColor)
                .frame(width: 9, height: 9)
                .padding(.top, 7)
                .accessibilityLabel(share.seen ? "Vista" : "Nuova")
            VStack(alignment: .leading, spacing: 4) {
                Text(share.title.isEmpty ? "Voce condivisa" : share.title)
                    .font(.headline)
                    .lineLimit(2)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right.square").foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }

    private var subtitle: String {
        var parts = ["da \(share.from)"]
        let counts = share.counts.summary
        if !counts.isEmpty { parts.append(counts) }
        let when = relative(share.sharedAt)
        if !when.isEmpty { parts.append(when) }
        return parts.joined(separator: " · ")
    }
}
