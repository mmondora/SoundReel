// ios/SoundReel/SettingsView.swift

import SwiftUI

struct SettingsView: View {
    @State private var backendUrl: String = Settings.shared.backendBaseUrl
    @State private var displayName: String = Settings.shared.targetDisplayName
    @State private var savedTick: Date = .now

    var body: some View {
        Form {
            Section(header: Text("Backend")) {
                TextField("URL", text: $backendUrl)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .onSubmit { save() }
                Button("Ripristina default") {
                    backendUrl = "https://soundreel.casamon.dev"
                    save()
                }
            }
            Section(header: Text("Nome visualizzato"),
                    footer: Text("Usato nella schermata principale e nel toast del Share.")) {
                TextField("Nome", text: $displayName)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit { save() }
            }
            Section {
                Button("Salva") { save() }
            }
        }
        .navigationTitle("Impostazioni")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func save() {
        Settings.shared.backendBaseUrl = backendUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        Settings.shared.targetDisplayName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        savedTick = .now
    }
}

#Preview {
    NavigationStack {
        SettingsView()
    }
}
