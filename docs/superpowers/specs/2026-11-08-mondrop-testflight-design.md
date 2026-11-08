# Mondrop su TestFlight — distribuzione alla famiglia (richiesta 2026-11-08)

- **Data:** 2026-11-08
- **Stato:** **Richiesta registrata, in corso.** La build (privacy manifest, conformità export, entitlements push per la Release, script di archivio e upload) è pronta nel repository. Michele ha creato la chiave API (Key ID `7A4NS73W6Y`, il `.p8` è al sicuro fuori dal repository) e, l'8 novembre, **il record app «Mondrop»**; Michele ha dato anche l'Issuer ID: con la chiave la **lettura** di App Store Connect funziona (il record `it.mikesoft.mondrop` c'è, nessuna build ancora), ma **il ruolo della chiave non basta per scrivere**: l'export con firma cloud dà «Cloud signing permission error: You haven't been given access to cloud-managed distribution certificates» e `POST /v1/betaGroups` risponde `403 FORBIDDEN_ERROR`. **Il caricamento della build passa dall'Apple ID di Xcode** (l'account del team `5NZADC9YQ2`, un team *Individual* di cui Michele è l'Account Holder, con un certificato di distribuzione gestito già esistente): `ios/scripts/testflight.sh` lanciato **senza** le variabili `ASC_*` nel Terminale di vulcano. Per gruppo, tester, informazioni di test e invio alla revisione via API serve una chiave con ruolo **Admin** (o App Manager con accesso ai certificati cloud), oppure Michele fa quei passi nell'interfaccia web. Distribuzione e segreti toccano l'infrastruttura e la sicurezza (**ADR-0016**).
- **Owner:** Michele
- **Correlati:** `adr/0016-mondrop-testflight-distribution-with-an-app-store-connect-api-key.md`, `ios/README.md`, `ios/scripts/testflight.sh`, `ios/scripts/install-iphone.sh` (build di sviluppo, resta com'è), `2026-11-08-mondrop-share-inbox-design.md` (il push APNs usa lo stesso account sviluppatore)

## 1. Richiesta di Michele (testuale)

> «Pubblica mondrop su testflight e metti il gruppo family come tester»

Risposte alle domande che servivano per procedere (testuali):
- Come caricare la build: **«Chiave API App Store Connect (Recommended)»**.
- Esiste già il record app «Mondrop» (bundle `it.mikesoft.mondrop`) in App Store Connect: **«Non lo so»**.
- Tester: **«Esiste già il gruppo Family»** (scritto «geuppo Family»).

**Come la leggo (da confermare):** «il gruppo family» è un gruppo TestFlight che Michele ha già in App Store Connect con i familiari (`archi`, `sara`) dentro. I gruppi TestFlight appartengono a un'app, ma i **tester** sono persone del team e si possono mettere in più app: quindi su Mondrop si crea (se manca) un gruppo «Family» e ci si mettono **gli stessi tester** del gruppo esistente, letti dall'API, senza che Michele debba ridare le email.

## 2. Decisioni prese con valori di default (da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| T1 | **Canale** | TestFlight, gruppo **esterno** «Family» (i familiari non diventano utenti dell'account sviluppatore). Invito per email, installazione da TestFlight. La prima build di una versione passa dalla **revisione beta di Apple** (di solito ore o uno-due giorni) |
| T2 | **Chi fa cosa** | Io: build, upload, gruppo, tester, informazioni di test e invio alla revisione, tutto con la **chiave API di App Store Connect**. Michele: crea la chiave (una volta) e, se manca, il **record app** (l'API non può crearlo) |
| T3 | **La build** | Configurazione Release, versione e numero di build da `project.yml` (il numero deve crescere a ogni upload della stessa versione: `BUILD=` lo forza). **Pronta per il push**: gli entitlements con `aps-environment` valgono solo per la Release (`Mondrop/MondropPush.entitlements`), così la build di sviluppo installata sul telefono non dipende dalle capability dell'App ID; il server inizia a suonare quando ha la chiave APNs, senza una build nuova |
| T4 | **Requisiti di App Store Connect già messi a posto** | Privacy manifest (`PrivacyInfo.xcprivacy`, app ed estensione: UserDefaults dell'App Group `CA92.1`/`1C8F.1`, timestamp dei file nel container `C617.1`, tempo trascorso `35F9.1`; nessun tracciamento), `ITSAppUsesNonExemptEncryption = NO` (solo HTTPS standard: niente domanda di conformità a ogni build), icona 1024 px senza alpha (già a posto), orientamenti iPad (ITMS-90474) |
| T5 | **Firma e upload** | `ios/scripts/testflight.sh`: archivio Release → export `app-store-connect` con destinazione `upload`, firma automatica; con la chiave API (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_PATH`) la firma di distribuzione è **gestita dal cloud** (nessun certificato di distribuzione sul Mac) **a patto che la chiave abbia il ruolo Admin**; con un ruolo più basso (visto l'8 novembre) l'export fallisce con «Cloud signing permission error» e si lancia lo script **senza** variabili `ASC_*`: firma e upload con l'Apple ID con cui Xcode è collegato (Account Holder del team), che ha funzionato. Sul Mac di build gira nella **sessione grafica** di Michele (portachiavi), lanciato da qui con `open -a Terminal` |
| T6 | **Segreti** | Il file `.p8` sta solo in `~/.config/soundreel/appstoreconnect/` (0600) su geekom e su vulcano: **mai** nel repository, in `.env`, in chat, nei log o in un commit. Key ID e Issuer ID non sono segreti ma stanno in un file di configurazione fuori dal repository pubblico |
| T7 | **Cosa non cambia** | `install-iphone.sh` resta per le build di sviluppo sul telefono di Michele; il backend non cambia (le build TestFlight usano l'ambiente APNs di produzione, e il server sceglie l'host in base al token registrato) |

## 3. Passi

1. Michele crea la chiave API (App Store Connect → Utenti e accessi → Integrazioni → API App Store Connect, ruolo App Manager; se la firma cloud lo richiede, Admin a tempo) e mette il `.p8` su geekom; mi dà Key ID e Issuer ID.
2. Controllo l'app per bundle id; se il record non c'è, Michele lo crea (Apps → + → Nuova app, nome «Mondrop» o alternativo se già preso, lingua italiano).
3. Copio il `.p8` su vulcano, sincronizzo l'albero `ios/`, verifico la build Release senza firma (privacy manifest, Info.plist, entitlements), poi `testflight.sh` nella sessione grafica.
4. Quando Apple ha elaborato la build: gruppo «Family» (creato se manca) con i tester del gruppo esistente, informazioni di test (descrizione, email di feedback, nota per il revisore: Mondrop è un client di un server privato), build assegnata e inviata alla revisione beta.
5. Dopo l'approvazione i familiari ricevono l'invito. Poi: l'installazione richiede per ognuno la chiave personale (`/mondrop/connect`, login Authelia).

## 4. Test e controlli

- Il progetto Release si compila senza firma e porta i due `PrivacyInfo.xcprivacy`, la chiave di conformità e gli orientamenti iPad (controllo sul Mac di build, prima dell'upload).
- Nessun segreto nel repository (`secret_scan.py` / `history_scan.py` prima di ogni commit).
- Dopo l'upload: la build compare in App Store Connect con stato di elaborazione `VALID`; nessun errore `ITMS-`.

## 5. Domande aperte per Michele

1. ~~Il record app «Mondrop» esiste già?~~ **Creato da Michele l'8 novembre** (il nome era libero); da verificare via API appena c'è l'Issuer ID che il bundle id sia `it.mikesoft.mondrop`.
2. Il gruppo «Family» esistente è di un'altra app (probabile)? Va bene copiarne i tester su Mondrop?
3. Per la revisione beta Apple può chiedere un **URL dell'informativa privacy**: se serve, ne metto una pagina statica pubblica (nessun dato raccolto oltre al tuo server).
4. Test interni al posto degli esterni (nessuna revisione, ma i familiari diventano utenti dell'account)? Default: esterni.
