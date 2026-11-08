// ios/Mondrop/ContentView.swift

import SwiftUI

struct ContentView: View {
    @State private var displayName: String = Settings.shared.targetDisplayName
    @State private var backendUrl: String = Settings.shared.backendBaseUrl
    @State private var hasKey: Bool = !Settings.shared.apiKey.isEmpty
    @State private var provaBusy = false
    @State private var provaStatus = ""
    @State private var provaFailed = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Text("Mondrop")
                .font(.largeTitle).bold()

            Text("Da qualsiasi app: Condividi → \(displayName) → (tag opzionale) → Invia.")
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            Text("I link finiscono nel journal SoundReel di casa.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            if !hasKey {
                Text("Manca l’API key: creala ora con il tuo login Authelia.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
                ConnectKeyButton(title: "Ottieni API key")
                    .buttonStyle(.borderedProminent)
            }

            if let openUrl = URL(string: backendUrl) {
                Link("Apri \(host(of: backendUrl))", destination: openUrl)
                    .buttonStyle(.borderedProminent)
            }

            #if DEBUG
            Button(provaBusy ? "Invio…" : "Prova share") {
                Task { await runProvaShare() }
            }
            .buttonStyle(.bordered)
            .disabled(provaBusy || !hasKey)
            if !provaStatus.isEmpty {
                Text(provaStatus)
                    .font(.footnote)
                    .foregroundStyle(provaFailed ? .red : .green)
            }
            #endif

            Spacer()

            NavigationLink("Impostazioni") {
                SettingsView()
            }
            .padding(.bottom)
        }
        .padding()
        .navigationTitle("Mondrop")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onAppear { refresh() }
        .onReceive(NotificationCenter.default.publisher(for: KeyConnect.didChange)) { _ in refresh() }
    }

    private func refresh() {
        displayName = Settings.shared.targetDisplayName
        backendUrl = Settings.shared.backendBaseUrl
        hasKey = !Settings.shared.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func host(of urlString: String) -> String {
        URL(string: urlString)?.host ?? urlString
    }

    #if DEBUG
    private func runProvaShare() async {
        provaBusy = true
        provaFailed = false
        provaStatus = "Invio…"
        let stamp = Int(Date().timeIntervalSince1970)
        let url = "https://www.youtube.com/watch?v=mondropUi\(stamp)"
        do {
            let resp = try await BackendClient().share(
                url: url,
                comment: "#mondrop prova-ui",
                tags: nil
            )
            if resp.success {
                provaStatus = "In coda ✓ \(resp.entryId?.prefix(8) ?? "")"
                provaFailed = false
            } else {
                provaStatus = resp.error ?? "Errore"
                provaFailed = true
            }
        } catch let e as BackendError {
            provaStatus = e.description
            provaFailed = true
        } catch {
            provaStatus = "Errore"
            provaFailed = true
        }
        provaBusy = false
        refresh()
    }
    #endif
}

#Preview {
    NavigationStack {
        ContentView()
    }
}
