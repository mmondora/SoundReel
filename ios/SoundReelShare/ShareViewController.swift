// ios/SoundReelShare/ShareViewController.swift

import UIKit

final class ShareViewController: UIViewController {

    private let label = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        setUpUI()
        Task { await processInput() }
    }

    private func setUpUI() {
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = "Invio a \(Settings.shared.targetDisplayName)…"
        label.textAlignment = .center
        label.numberOfLines = 0
        view.addSubview(label)

        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimating()
        view.addSubview(spinner)

        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -24),
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 16),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
        ])
    }

    private func processInput() async {
        let providers = (extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? [])
            .flatMap { $0.attachments ?? [] }

        guard let url = await URLExtractor.firstURL(from: providers) else {
            await present(message: "Nessun URL trovato", success: false)
            return
        }

        do {
            let resp = try await BackendClient().analyze(url: url.absoluteString)
            if resp.success {
                await present(message: "Inviato ✓", success: true)
            } else {
                await present(message: resp.error ?? "Errore", success: false)
            }
        } catch let e as BackendError {
            await present(message: e.description, success: false)
        } catch {
            await present(message: "Errore", success: false)
        }
    }

    @MainActor
    private func present(message: String, success: Bool) async {
        spinner.stopAnimating()
        spinner.isHidden = true
        label.text = message
        label.textColor = success ? .systemGreen : .systemRed
        try? await Task.sleep(nanoseconds: 700_000_000) // 0.7s
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
