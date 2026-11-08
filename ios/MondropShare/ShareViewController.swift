// ios/SoundReelShare/ShareViewController.swift
// Share Sheet UI: URL + optional tags (recent chips + free text) → POST /api/share
// iOS: UIViewController · macOS: NSViewController — same SwiftUI compose sheet.

import SwiftUI

#if os(iOS)
import UIKit

final class ShareViewController: UIViewController {

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        Task { await bootstrap() }
    }

    private func bootstrap() async {
        let providers = (extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? [])
            .flatMap { $0.attachments ?? [] }

        let url = await URLExtractor.firstURL(from: providers)
        await MainActor.run {
            let root = ShareComposeView(
                initialURL: url,
                onCancel: { [weak self] in
                    self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
                },
                onDone: { [weak self] in
                    self?.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
                }
            )
            let host = UIHostingController(rootView: root)
            addChild(host)
            host.view.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(host.view)
            NSLayoutConstraint.activate([
                host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                host.view.topAnchor.constraint(equalTo: view.topAnchor),
                host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            ])
            host.didMove(toParent: self)
        }
    }
}

#elseif os(macOS)
import AppKit

final class ShareViewController: NSViewController {

    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 380, height: 320))
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        preferredContentSize = NSSize(width: 380, height: 320)
        Task { await bootstrap() }
    }

    private func bootstrap() async {
        let providers = (extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? [])
            .flatMap { $0.attachments ?? [] }

        let url = await URLExtractor.firstURL(from: providers)
        await MainActor.run {
            let root = ShareComposeView(
                initialURL: url,
                onCancel: { [weak self] in
                    self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
                },
                onDone: { [weak self] in
                    self?.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
                }
            )
            let host = NSHostingController(rootView: root)
            addChild(host)
            host.view.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(host.view)
            NSLayoutConstraint.activate([
                host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                host.view.topAnchor.constraint(equalTo: view.topAnchor),
                host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            ])
        }
    }
}
#endif

struct ShareComposeView: View {
    let initialURL: URL?
    let onCancel: () -> Void
    let onDone: () -> Void

    @State private var comment: String = ""
    @State private var recent: [String] = Settings.shared.recentTags
    @State private var status: String = ""
    @State private var busy = false
    @State private var failed = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Link") {
                    if let initialURL {
                        Text(initialURL.absoluteString)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    } else {
                        Text("Nessun URL trovato nello share.")
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Text(Settings.shared.autheliaUsername.isEmpty
                         ? "Imposta l’utente Authelia in Mondrop → Impostazioni"
                         : "Come \(Settings.shared.autheliaUsername) · \(Settings.deviceDisplayName())")
                        .font(.footnote)
                        .foregroundStyle(Settings.shared.autheliaUsername.isEmpty ? .orange : .secondary)
                } header: {
                    Text("Utente")
                }

                Section("Tag (opzionale)") {
                    TextField("#tesla vacanze…", text: $comment)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .autocorrectionDisabled()
                    if !recent.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack {
                                ForEach(recent, id: \.self) { tag in
                                    Button(tag) { toggleChip(tag) }
                                        .buttonStyle(.bordered)
                                        .controlSize(.small)
                                }
                            }
                        }
                    }
                }

                if !status.isEmpty {
                    Section {
                        Text(status)
                            .foregroundStyle(failed ? .red : .green)
                    }
                }
            }
            .navigationTitle(Settings.shared.targetDisplayName)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annulla", action: onCancel)
                        .disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "…" : "Invia") {
                        Task { await send() }
                    }
                    .disabled(busy || initialURL == nil)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 360, minHeight: 280)
        #endif
    }

    private func toggleChip(_ tag: String) {
        let parts = comment.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        if parts.contains(where: { $0.caseInsensitiveCompare(tag) == .orderedSame }) {
            comment = parts.filter { $0.caseInsensitiveCompare(tag) != .orderedSame }.joined(separator: " ")
        } else {
            comment = (comment.trimmingCharacters(in: .whitespaces) + " " + tag)
                .trimmingCharacters(in: .whitespaces)
        }
    }

    private func send() async {
        guard let url = initialURL else { return }
        busy = true
        failed = false
        status = "Invio…"
        do {
            let resp = try await BackendClient().share(
                url: url.absoluteString,
                comment: comment.isEmpty ? nil : comment,
                tags: nil
            )
            if resp.success {
                if let tags = resp.tags, !tags.isEmpty {
                    Settings.shared.rememberTags(tags)
                    recent = Settings.shared.recentTags
                } else if !comment.isEmpty {
                    let rough = comment.split(whereSeparator: { $0.isWhitespace }).map(String.init)
                    Settings.shared.rememberTags(rough)
                    recent = Settings.shared.recentTags
                }
                status = "In coda ✓"
                failed = false
                try? await Task.sleep(nanoseconds: 450_000_000)
                onDone()
            } else {
                status = resp.error ?? "Errore"
                failed = true
                busy = false
            }
        } catch let e as BackendError {
            status = e.description
            failed = true
            busy = false
        } catch {
            status = "Errore"
            failed = true
            busy = false
        }
    }
}
