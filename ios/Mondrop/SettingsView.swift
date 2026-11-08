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
    @State private var notifyShares: Bool = Settings.shared.inboxNotificationsEnabled
    @State private var shareWithByDefault: Set<String> = Set(Settings.shared.defaultShareWith)
    @State private var notificationPermission: NotificationPermission?
    @ObservedObject private var push = PushRegistrar.shared
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

            sharesSection

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

            // Last, apart from the everyday options: deletion is a special option.
            deletionSection
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
        } header: {
            Text("Sync")
        } footer: {
            Text("I download del Sync usano solo il Wi-Fi, salvo che attivi la rete cellulare. I brani arrivano sempre e solo da SoundReel, a casa e fuori casa. Quando un Sync finisce e l'app non è aperta ti arriva una notifica con quanti brani sono stati scaricati e quanti errori ci sono (iOS lo chiede la prima volta). Quanto pesano i brani e come toglierli: in «Cancellazione», qui sotto.")
        }
    }

    /// The ONE place where songs are removed from the phone (spec 2026-11-08-mondrop-deletion-in-settings-design.md): not in the
    /// player, not in the lists, not in the bar of the search. A section of its own, away from the everyday options.
    private var deletionSection: some View {
        Section {
            NavigationLink {
                SpaceView()
            } label: {
                Label("Spazio e brani scaricati", systemImage: "internaldrive")
            }
        } header: {
            Text("Cancellazione")
        } footer: {
            Text("È l'unico posto in cui Mondrop toglie brani dal telefono. Ogni cancellazione chiede conferma (più brani, due volte) e non si può annullare; i brani tolti restano su SoundReel e si possono riscaricare. Dal Player, da Cerca e dalle playlist non si cancella niente.")
        }
    }

    /// «Notifiche delle condivisioni» and «Condividi di default con…» (Mondrop 1.6, the Posta tab and the share sheet).
    @ViewBuilder
    private var sharesSection: some View {
        Section {
            Toggle("Notifiche delle condivisioni", isOn: $notifyShares)
                .onChange(of: notifyShares) { _, newValue in
                    Settings.shared.inboxNotificationsEnabled = newValue
                    // Asked when the switch is turned on, never behind the user's back; turning it off tells the server to stop.
                    Task {
                        if newValue { await InboxWiring.ensurePermissionIfNeeded() }
                        await InboxWiring.reconcilePush()
                        await refreshNotificationPermission()
                    }
                }
            if notifyShares && notificationPermission == .denied {
                Text("Le notifiche di Mondrop sono disattivate nelle Impostazioni di iOS: la Posta funziona lo stesso, ma non ti avviso quando arriva qualcosa.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            if let line = pushLine {
                Text(line).font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(ShareRecipients.available(for: username), id: \.self) { user in
                Toggle("Condividi di default con \(user)", isOn: Binding(
                    get: { shareWithByDefault.contains(user) },
                    set: { on in
                        if on { shareWithByDefault.insert(user) } else { shareWithByDefault.remove(user) }
                        Settings.shared.defaultShareWith = Array(shareWithByDefault)
                    }
                ))
            }
        } header: {
            Text("Condivisioni e Posta")
        } footer: {
            Text("Quando condividi un link da un'altra app, l'esito ti torna nella scheda Posta (e come notifica). «Condividi di default con…» pre-seleziona i destinatari nel foglio di condivisione, dove puoi sempre cambiarli; di base nessuno. Le notifiche spariscono dopo 3 giorni, gli errori restano.")
        }
    }

    /// Push is dormant until the signed app carries the push entitlement and the server holds the APNs key.
    private var pushLine: String? {
        switch push.state {
        case .registered: return "Push attivo su questo telefono."
        case .waiting: return "Push: in attesa di iOS…"
        case .unavailable(let reason): return "Push non attivo su questa installazione (\(reason)): gli avvisi arrivano quando apri Mondrop."
        case .off: return nil
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
