// ios/MondropShare/ShareViewController.swift
// The share extension's view controllers: they find the link in what was shared and host the SwiftUI sheet.
// iOS: UIViewController · macOS: NSViewController — the same `ShareComposeView` (MondropKit/ShareComposeView.swift):
// big «Invia a SoundReel» button, playlist for music links, «Condividi con», tags, and a result that stays on screen.

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
        view = NSView(frame: NSRect(x: 0, y: 0, width: 380, height: 480))
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        preferredContentSize = NSSize(width: 380, height: 480)
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
