// ios/Mondrop/ConnectKeyButton.swift

import SwiftUI
import AuthenticationServices

/// "Ottieni / Rinnova API key": opens the SoundReel connect page in a system web-auth
/// sheet (Authelia login happens there), then stores the key handed back via
/// `mondrop://auth?…` (see `KeyConnect`). Other screens refresh via `KeyConnect.didChange`.
struct ConnectKeyButton: View {
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession

    let title: String

    @State private var busy = false
    @State private var message = ""
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                Task { await connect() }
            } label: {
                if busy {
                    ProgressView()
                } else {
                    Text(title)
                }
            }
            .disabled(busy)

            if !message.isEmpty {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(failed ? Color.red : Color.green)
            }
        }
    }

    @MainActor
    private func connect() async {
        busy = true
        failed = false
        message = ""
        defer { busy = false }

        guard let url = KeyConnect.connectURL(
            base: Settings.shared.backendBaseUrl,
            device: Settings.deviceDisplayName()
        ) else {
            failed = true
            message = "URL backend non valido (serve https)"
            return
        }

        do {
            let callback = try await webAuthenticationSession.authenticate(
                using: url,
                callbackURLScheme: KeyConnect.callbackScheme
            )
            guard let issued = KeyConnect.parseCallback(callback) else {
                failed = true
                message = "Risposta non valida dal server"
                return
            }
            KeyConnect.apply(issued)
            message = "Collegato come \(issued.user) ✓"
        } catch {
            if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                message = "Annullato"
            } else {
                failed = true
                message = "Errore: \(error.localizedDescription)"
            }
        }
    }
}
