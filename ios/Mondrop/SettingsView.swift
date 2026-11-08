// ios/Mondrop/SettingsView.swift

import SwiftUI
#if os(iOS)
import UIKit
#endif

struct SettingsView: View {
    @State private var backendUrl: String = Settings.shared.backendBaseUrl
    @State private var displayName: String = Settings.shared.targetDisplayName
    @State private var apiKey: String = Settings.shared.apiKey
    @State private var username: String = Settings.shared.autheliaUsername
    @State private var savedMessage: String = ""
    @State private var allowCellular: Bool = Settings.shared.allowCellularDownloads
    @State private var notifyWhenDone: Bool = Settings.shared.syncNotificationsEnabled
    @State private var notificationPermission: NotificationPermission?
    @ObservedObject private var net = NetStatus.shared
    @ObservedObject private var uploader = EventUploader.shared

    private let users = Settings.autheliaUsers

    var body: some View {
        Form {
            Section {
                Picker("Utente Authelia", selection: $username) {
                    ForEach(users, id: \.id) { u in
                        Text(u.label).tag(u.id)
                    }
                }
                Text("Suggerito da questo device: \(Settings.suggestAutheliaUsername()) · \(Settings.deviceDisplayName())")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Usa suggerimento device") {
                    username = Settings.suggestAutheliaUsername()
                }
            } header: {
                Text("Chi share")
            } footer: {
                Text("Con una key personale (Ottieni/Rinnova API key) il server usa l’utente del tuo login Authelia e ignora questa scelta: serve solo per key vecchie incollate a mano. Ogni share invia anche data/ora locale del device.")
            }

            Section {
                TextField("URL", text: $backendUrl)
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    #endif
                    .autocorrectionDisabled()
                    .onSubmit { save() }
                Button("Ripristina default") {
                    backendUrl = "https://soundreel.casamon.dev"
                    save()
                }
            } header: {
                Text("Backend")
            }

            Section {
                ConnectKeyButton(
                    title: apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? "Ottieni API key"
                        : "Rinnova API key"
                )
                if apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("Nessuna key su questo dispositivo: accedi con Authelia per crearla.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                DisclosureGroup("Incolla a mano") {
                    SecureField("sr_…", text: $apiKey)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .autocorrectionDisabled()
                        .onSubmit { save() }
                }
            } header: {
                Text("API key")
            } footer: {
                Text("Ogni utente crea la propria key dal proprio dispositivo (login Authelia). «Rinnova» sostituisce quella di questo dispositivo: la vecchia smette di funzionare. Salvata nell’App Group per la Share Extension.")
            }

            syncSection

            statsSection

            Section {
                TextField("Nome", text: $displayName)
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .autocorrectionDisabled()
                    .onSubmit { save() }
            } header: {
                Text("Nome nello share sheet")
            }

            Section {
                Button("Salva") { save() }
                if !savedMessage.isEmpty {
                    Text(savedMessage)
                        .font(.footnote)
                        .foregroundStyle(.green)
                }
            }
        }
        .navigationTitle("Impostazioni")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onAppear {
            if username.isEmpty {
                username = Settings.suggestAutheliaUsername()
            }
            uploader.refreshCounts()
        }
        .task {
            if net.info == nil { await net.refresh(api: MondropAPI()) }
        }
        .task { await refreshNotificationPermission() }
        .onReceive(NotificationCenter.default.publisher(for: KeyConnect.didChange)) { _ in
            // A key was just issued (in-app sheet or deep link): refresh @State so "Salva" can't overwrite it.
            apiKey = Settings.shared.apiKey
            username = Settings.shared.autheliaUsername
            uploader.clearAuthPause()
        }
    }

    @ViewBuilder
    private var syncSection: some View {
        Section {
            Toggle("Scarica anche con rete cellulare", isOn: $allowCellular)
                .onChange(of: allowCellular) { _, newValue in
                    Settings.shared.allowCellularDownloads = newValue
                }
            Toggle("Avvisami a sync finito", isOn: $notifyWhenDone)
                .onChange(of: notifyWhenDone) { _, newValue in
                    Settings.shared.syncNotificationsEnabled = newValue
                    // Asked when the switch is turned on (or at the first Sync), never behind the user's back.
                    if newValue { Task { await SyncNotifier.shared.ensurePermission(); await refreshNotificationPermission() } }
                }
            if notifyWhenDone && notificationPermission == .denied {
                Text("Le notifiche di Mondrop sono disattivate nelle Impostazioni di iOS: il Sync funziona lo stesso, ma non ti avviso quando finisce.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                #if os(iOS)
                Button("Apri le impostazioni di iOS") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                #endif
            }
            HStack {
                Text("Rete: \(net.checking ? "controllo…" : net.label)")
                Spacer()
                Button("Controlla") { Task { await net.refresh(api: MondropAPI()) } }
                    .disabled(net.checking)
            }
            if let error = net.lastError {
                Text(error).font(.footnote).foregroundStyle(.secondary)
            }
            NavigationLink {
                SpaceView()
            } label: {
                Label("Spazio e brani scaricati", systemImage: "internaldrive")
            }
        } header: {
            Text("Sync")
        } footer: {
            Text("I download del Sync usano solo il Wi-Fi, salvo che attivi la rete cellulare. A casa i brani arrivano direttamente dal media server (il file non passa da internet); fuori casa dal server SoundReel. Quando un Sync finisce e l'app non è aperta ti arriva una notifica con quanti brani sono stati scaricati e quanti errori ci sono (iOS lo chiede la prima volta). In «Spazio» vedi quanto pesano i brani, elimini i meno ascoltati (doppia conferma per più brani) e riscarichi ciò che serve.")
        }
    }

    @ViewBuilder
    private var statsSection: some View {
        Section {
            HStack {
                Text("In attesa di invio")
                Spacer()
                Text("\(uploader.pendingCount) eventi").foregroundStyle(.secondary)
            }
            if uploader.droppedCount > 0 {
                Text("\(uploader.droppedCount) eventi scartati: la coda locale è piena (limite \(EventQueue.defaultCapacity)), via i più vecchi.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            HStack {
                Text("Ultimo invio riuscito")
                Spacer()
                Text(lastUploadText).foregroundStyle(.secondary)
            }
            uploadStatusLine
            Button("Invia ora") { Task { await uploader.flush(.manual) } }
                .disabled(uploader.pendingCount == 0 || uploader.status == .uploading)
        } header: {
            Text("Statistiche di ascolto")
        } footer: {
            Text("Mondrop registra quanto ascolti davvero (pause e salti non contano) e le cancellazioni di brani, e li invia a SoundReel di tanto in tanto: a gruppi di 20, quando l'app va in background, all'avvio e ogni 15 minuti. Offline restano in coda sul telefono.")
        }
    }

    @ViewBuilder
    private var uploadStatusLine: some View {
        switch uploader.status {
        case .needsKey:
            Text("API key non valida: rinnovala in «API key». Gli eventi restano in coda e partiranno con la nuova.")
                .font(.footnote)
                .foregroundStyle(.red)
        case .backoff(let retryAt, let message):
            Text("Invio non riuscito (\(message)): riprovo alle \(retryAt.formatted(date: .omitted, time: .shortened)).")
                .font(.footnote)
                .foregroundStyle(.orange)
        case .uploading:
            HStack(spacing: 8) { ProgressView(); Text("Invio in corso…").font(.footnote) }
        case .idle:
            EmptyView()
        }
    }

    private var lastUploadText: String {
        guard let last = uploader.lastUploadAt else { return "mai" }
        return last.formatted(date: .abbreviated, time: .shortened)
    }

    private func refreshNotificationPermission() async {
        notificationPermission = await SyncNotifier.shared.center?.permission()
    }

    private func save() {
        Settings.shared.backendBaseUrl = backendUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        Settings.shared.targetDisplayName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        Settings.shared.apiKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        Settings.shared.autheliaUsername = username
        savedMessage = "Salvato"
    }
}

#Preview {
    NavigationStack {
        SettingsView()
    }
}
