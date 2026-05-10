// ios/SoundReel/ContentView.swift

import SwiftUI

struct ContentView: View {
    @State private var displayName: String = Settings.shared.targetDisplayName
    @State private var backendUrl: String = Settings.shared.backendBaseUrl

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Text("SoundReel")
                .font(.largeTitle).bold()

            Text("Usa il tasto Condividi su Safari, Instagram, TikTok ecc. e seleziona \(displayName).")
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            if let openUrl = URL(string: backendUrl) {
                Link("Apri \(host(of: backendUrl))", destination: openUrl)
                    .buttonStyle(.borderedProminent)
            }

            Spacer()

            NavigationLink("Impostazioni", destination: SettingsView())
                .padding(.bottom)
        }
        .padding()
        .navigationTitle("SoundReel")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            displayName = Settings.shared.targetDisplayName
            backendUrl = Settings.shared.backendBaseUrl
        }
    }

    private func host(of urlString: String) -> String {
        URL(string: urlString)?.host ?? urlString
    }
}

#Preview {
    NavigationStack {
        ContentView()
    }
}
