// ShareComposeView.swift — the share sheet of Mondrop (iOS and macOS use this same view; spec SH1–SH3, SH7).
//
// Top to bottom: the link (host + short URL) → «Aggiungi a una playlist» (music/media links only, default «Nessuna»)
// → «Condividi con» → tags → who and from which device, small. «Invia a SoundReel» is a big filled button pinned at the
// bottom, always above the keyboard. After sending the sheet does NOT vanish: a big check and one line say what
// happened (haptic), then it closes; on an error it stays open with the reason and «Riprova».
//
// All the decisions are in `ShareComposeModel` (tested); this file only draws them.

import SwiftUI
#if os(iOS)
import UIKit
#endif
#if os(macOS)
import AppKit
#endif

public struct ShareComposeView: View {
    @StateObject private var model: ShareComposeModel
    @State private var finished = false
    private let onCancel: () -> Void
    private let onDone: () -> Void

    public init(initialURL: URL?, onCancel: @escaping () -> Void, onDone: @escaping () -> Void) {
        _model = StateObject(
            wrappedValue: ShareComposeModel(url: initialURL, context: ShareContext.current(), sender: BackendClient())
        )
        self.onCancel = onCancel
        self.onDone = onDone
    }

    /// For previews and the snapshot tests: any model.
    init(model: ShareComposeModel, onCancel: @escaping () -> Void = {}, onDone: @escaping () -> Void = {}) {
        _model = StateObject(wrappedValue: model)
        self.onCancel = onCancel
        self.onDone = onDone
    }

    public var body: some View {
        NavigationStack {
            Group {
                if case .succeeded(let outcome) = model.phase {
                    SuccessState(outcome: outcome)
                        .contentShape(Rectangle())
                        .onTapGesture { finish() }        // no need to wait if the user has read it
                } else {
                    content
                }
            }
            .navigationTitle(Settings.shared.targetDisplayName)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if isSucceeded {
                        // Sent: «Annulla» would lie. The sheet closes by itself; this closes it at once.
                        Button("Chiudi") { finish() }
                    } else {
                        Button("Annulla", action: onCancel)
                            .disabled(model.isBusy)
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !isSucceeded { sendBar }
            }
            .onChange(of: model.phase) { _, phase in
                switch phase {
                case .succeeded(let outcome):
                    haptic(success: true)
                    Task {
                        try? await Task.sleep(for: .seconds(outcome.closeDelay))
                        finish()
                    }
                case .failed:
                    haptic(success: false)
                default:
                    break
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 380, minHeight: 440)
        #endif
    }

    /// The extension is completed once, however many ways (tap, button, timer) ask for it.
    private func finish() {
        guard !finished else { return }
        finished = true
        onDone()
    }

    private var isSucceeded: Bool {
        if case .succeeded = model.phase { return true }
        return false
    }

    // MARK: the sheet

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                linkCard
                if model.showsPlaylistPicker {
                    playlistSection
                } else if let hint = model.playlistHint {
                    Text(hint).font(.footnote).foregroundStyle(.secondary)
                }
                if !model.recipients.isEmpty { shareWithSection }
                tagsSection
                whoFooter
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 16)
        }
        #if os(iOS)
        .scrollDismissesKeyboard(.interactively)
        #endif
    }

    private var linkCard: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "link")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 28)
            if let url = model.url {
                let preview = LinkPreview.make(url)
                VStack(alignment: .leading, spacing: 3) {
                    Text(preview.host).font(.headline).lineLimit(1)
                    Text(preview.shortURL)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.middle)
                }
            } else {
                Text("Nessun link trovato nello share.").font(.headline).foregroundStyle(.red)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var playlistSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle("Aggiungi a una playlist", systemImage: "music.note.list")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    Chip(title: "Nessuna", selected: model.selectedPlaylist == nil) { model.choosePlaylist(nil) }
                    ForEach(model.playlists) { playlist in
                        Chip(title: playlist.name, selected: model.selectedPlaylist == playlist.id) {
                            model.choosePlaylist(playlist.id)
                        }
                    }
                }
            }
        }
    }

    private var shareWithSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle("Condividi con", systemImage: "person.2")
            HStack(spacing: 8) {
                ForEach(model.recipients, id: \.self) { user in
                    Chip(
                        title: user,
                        systemImage: model.selectedRecipients.contains(user) ? "checkmark" : nil,
                        selected: model.selectedRecipients.contains(user)
                    ) { model.toggleRecipient(user) }
                }
            }
            Text("Sul server: la vedono nel loro SoundReel e nella loro app.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var tagsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle("Tag (opzionale)", systemImage: "number")
            TextField("#tesla vacanze…", text: $model.comment)
                .textFieldStyle(.roundedBorder)
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .autocorrectionDisabled()
            if !model.recentTags.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.recentTags, id: \.self) { tag in
                            Chip(title: tag, selected: false, small: true) { model.toggleTag(tag) }
                        }
                    }
                }
            }
        }
    }

    private var whoFooter: some View {
        let user = Settings.shared.autheliaUsername
        return Text(user.isEmpty ? "Imposta l’utente Authelia in Mondrop → Impostazioni" : "Come \(user) · \(Settings.deviceDisplayName())")
            .font(.caption)
            .foregroundStyle(user.isEmpty ? Color.orange : Color.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: the button

    private var buttonTitle: String {
        switch model.phase {
        case .sending: return "Invio…"
        case .failed: return "Riprova"
        default: return "Invia a SoundReel"
        }
    }

    private var sendBar: some View {
        VStack(spacing: 8) {
            if case .failed(let reason) = model.phase {
                Label(reason, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let why = model.disabledReason {
                Text(why)
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button {
                Task { await model.send() }
            } label: {
                HStack(spacing: 10) {
                    if model.isBusy { ProgressView().tint(.white) }
                    Text(buttonTitle).font(.headline)
                }
                .frame(maxWidth: .infinity, minHeight: 36)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!model.canSend)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func haptic(success: Bool) {
        #if os(iOS)
        UINotificationFeedbackGenerator().notificationOccurred(success ? .success : .error)
        #elseif os(macOS)
        NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .default)
        #endif
    }
}

// MARK: - Pieces

private struct SectionTitle: View {
    let text: String
    let systemImage: String

    init(_ text: String, systemImage: String) {
        self.text = text
        self.systemImage = systemImage
    }

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
    }
}

private struct Chip: View {
    let title: String
    var systemImage: String?
    let selected: Bool
    var small = false
    let action: () -> Void

    init(title: String, systemImage: String? = nil, selected: Bool, small: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = systemImage
        self.selected = selected
        self.small = small
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let systemImage { Image(systemName: systemImage).font(.caption.weight(.bold)) }
                Text(title).lineLimit(1)
            }
            .font((small ? Font.footnote : Font.subheadline).weight(.medium))
            .padding(.horizontal, small ? 11 : 15)
            .padding(.vertical, small ? 6 : 9)
            .background(selected ? Color.accentColor : Color.secondary.opacity(0.16), in: Capsule())
            .foregroundStyle(selected ? Color.white : Color.primary)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// The big check and the line that says what happened.
private struct SuccessState: View {
    let outcome: ShareOutcome

    var body: some View {
        VStack(spacing: 14) {
            Spacer(minLength: 0)
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 92))
                .foregroundStyle(.green)
            Text(outcome.headline)
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            ForEach(outcome.details, id: \.self) { line in
                Text(line).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            ForEach(outcome.warnings, id: \.self) { line in
                Label(line, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
            }
            Spacer(minLength: 0)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}
