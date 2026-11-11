# Mondrop su TestFlight — distribuzione alla famiglia (richiesta 2026-11-08)

- **Data:** 2026-11-08
- **Stato:** **In corso: build 9 su TestFlight (8 novembre, 18:49), i familiari aspettano la revisione beta di Apple** (§7). **Richiesta registrata, in corso.** La build (privacy manifest, conformità export, entitlements push per la Release, script di archivio e upload) è pronta nel repository. Michele ha creato la chiave API (Key ID `7A4NS73W6Y`, il `.p8` è al sicuro fuori dal repository) e, l'8 novembre, **il record app «Mondrop»**; Michele ha dato anche l'Issuer ID: con la chiave la **lettura** di App Store Connect funziona (il record `it.mikesoft.mondrop` c'è, nessuna build ancora), ma **il ruolo della chiave non basta per scrivere**: l'export con firma cloud dà «Cloud signing permission error: You haven't been given access to cloud-managed distribution certificates» e `POST /v1/betaGroups` risponde `403 FORBIDDEN_ERROR`. **Il caricamento della build passa dall'Apple ID di Xcode** (l'account del team `5NZADC9YQ2`, un team *Individual* di cui Michele è l'Account Holder, con un certificato di distribuzione gestito già esistente): `ios/scripts/testflight.sh` lanciato **senza** le variabili `ASC_*` nel Terminale di vulcano. Per gruppo, tester, informazioni di test e invio alla revisione via API serve una chiave con ruolo **Admin** (o App Manager con accesso ai certificati cloud), oppure Michele fa quei passi nell'interfaccia web. Distribuzione e segreti toccano l'infrastruttura e la sicurezza (**ADR-0016**).
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

## 7. Esiti dell'8 novembre (sera): perché la chiave Admin, e cosa aspetta Apple

- **Il login Apple ID di Xcode su vulcano non regge.** La build 8 è partita alle 16:34 dopo che Michele aveva rifatto il login; alle 18:35 la build 9 si è fermata all'export con «Failed to Use Accounts» («Invalid credentials in keychain»: le credenziali dell'account erano invalide). Controllato: vulcano non si è riavviato (su da 25 giorni), il portachiavi non si blocca (`no-timeout`), nessun errore nei log tra le 16:34 e le 18:29. La causa precisa non si è vista; non c'è un'impostazione per farle durare. Michele (8 novembre): «Ancora ? Ma che cazzo di credenziali. Come faccio a farle durare ?».
- **La chiave API della prima volta (`7A4NS73W6Y`) è «Sviluppatore»** (Michele: «Accesso Sviluppatore»): legge tutto ma la firma cloud e i gruppi rispondono 403, e Apple non cambia il livello a una chiave già creata. Michele ne ha creato una nuova, ruolo **Admin** (**`KXRWH399D2`**, «chiave con id KXRWH399D2 creata e messa in inbox, ruolo Admin»): il `.p8` è in `~/.config/soundreel/appstoreconnect/` (0600) su geekom e su vulcano (la copia nell'inbox del repository, che è ignorata da git, e quella in `Downloads` di vulcano sono state tolte), `config.env` punta a lei (la vecchia configurazione è in `config.env.developer-key`). **La build 9 è partita con la chiave Admin alle 18:48** (archivio e firma nel Terminale grafico di vulcano, export e upload con la chiave API, nessun account Xcode): «Upload succeeded» alle 18:49, elaborata e `VALID` pochi minuti dopo. La chiave vecchia si può **revocare** (Utenti e accessi → Integrazioni → Team Keys).
- **Il gruppo interno «Family»** (solo Michele, distribuzione automatica) ha la build 9 da subito. **Il gruppo esterno «FamilyPlus»** (creato da Michele con Archimede, più Sara aggiunta da me) aspetta la **revisione beta** di Apple: ne è in corso una sola alla volta per versione (la 1.7.0): la **build 8**, mandata da Michele alle 17:21, è «in attesa di revisione» e la build 9 non si può mandare finché non finisce (`ANOTHER_BUILD_IN_REVIEW`). Le build successive della stessa versione, una volta approvata la prima, non hanno bisogno di un'altra revisione. La build 9 è già nel gruppo.
- **Ordine per un gruppo esterno:** prima la build nel gruppo (`assign-build`), poi i tester (`setup-group`): un gruppo esterno senza build rifiuta i tester (409 «Tester(s) cannot be assigned»). Nessun invito parte finché una build del gruppo non passa la revisione.
- **`ios/scripts/asc.mjs`** ha due comandi in più, con i loro test (27): `assign-build <gruppo> [numero]` e `submit-review [numero] [--whats-new "testo"]` (idempotenti: due volte non cambia niente). Il rischio da dire: la revisione beta può rifiutare un'app che senza il server privato non fa niente (`demoAccountRequired` è `false`); se succede, la strada senza revisione è invitare Sara e Archimede come utenti di App Store Connect (ruolo Marketing) e metterli nel gruppo interno.

## 8. 10 novembre: Apple ha rifiutato la build 8, e cosa è stato fatto

- **Stato letto dall'API (10 novembre):** la revisione beta della **build 8** (mandata l'8 novembre) è `REJECTED`. Il motivo non passa dall'API: sta nella mail o nel Resolution Center di App Store Connect. I testi che Apple aveva in mano erano magri: descrizione beta «Gestione delle playlist sul telefono», «cosa provare» «versione di base - scarica sul telefono le canzoni», nessuna nota per chi rivede (`demoAccountRequired` `false`: un'app che senza il suo server privato non fa niente, il rischio detto al §7).
- **Parole di Michele (10 novembre), che riporta cosa dice Apple:** «Apple: "il motivo lo devi aggiungere tu, mettendo l'elenco delle macro funzionalità, i due o tre macro punti da attenzionare"», e poi «vai».
- **Letto così (lettura mia, da correggere):** chi manda la build deve scrivere **a cosa serve l'app, le macro funzionalità e due o tre punti da guardare**; una riga non basta.
- **Fatto:** i testi sono in `ios/testflight/` (nessun segreto, stanno nel repository): `whats-to-test.it.txt` («cosa provare» della build, in italiano, lo leggono anche i tester: 4 macro funzionalità e 3 cose da guardare con più attenzione), `beta-description.it.txt` (descrizione beta in italiano) e `review-notes.en.txt` (note **per chi rivede**, in inglese, che i tester non vedono: l'app è il compagno di un server privato di famiglia, senza chiave personale non ha una libreria da mostrare, le stesse 4 macro funzionalità e 3 punti da guardare, e su richiesta si manda una chiave temporanea). `asc.mjs` ha il comando nuovo **`set-test-info [--description "testo|@file"] [--notes "testo|@file"]`** (idempotente; Apple accetta 4000 caratteri al massimo per testo, e il comando lo controlla prima di mandare) e `--whats-new` legge anche `@file`. **Build 12 sottomessa il 10 novembre** (`WAITING_FOR_REVIEW`), con l'OK di Michele («vai»).
- **Un difetto trovato strada facendo:** `submit-review 9` senza `--whats-new` scartava il numero (l'indice del valore del flag valeva 0 quando il flag manca) e mandava in revisione **la build più recente**, non la 9. Ora è `submitArgs`, una funzione pura con il suo test.
- **Da sapere:** se Apple chiede di vedere l'app con i dati, la richiesta arriva alla mail di contatto di Michele e la chiave temporanea si fa dalla pagina «Ottieni chiave» (`/mondrop/connect`, dietro Authelia). Se anche questa strada fallisce resta quella dei tester interni (§7: Sara e Archimede come utenti di App Store Connect nel gruppo interno).
- **Test:** `node --test ios/scripts/asc.test.mjs` **35** (erano 27); i mutanti sul codice nuovo (confini del limite, lingua, confronto «già uguale», lettura dal file, indice del numero) sono tutti uccisi.

## 9. 11 novembre: i familiari non hanno e non vogliono un account developer; la 1.8.0 va in revisione per gli esterni

**Richiesta di Michele (testuale, 11 novembre):** «Perché archimede deve essere un developer per usare mondrop ? Lui non ha e non vuole account developer.»

- **Regola:** i familiari ricevono Mondrop **solo come tester esterni di TestFlight** (il gruppo «FamilyPlus»: basta un Apple ID normale, l'app TestFlight e l'invito). **Mai** il gruppo interno «Family» (vuole utenti del team in App Store Connect: è solo Michele) e **mai** una build di sviluppo (Xcode, cavo, UDID registrato, «Modalità sviluppatore» sul telefono). Se un familiare incontra una schermata che gli chiede un account developer, è la strada sbagliata.
- **Stato a metà mattina:** Archimede (`archi`) e Sara stavano nel gruppo esterno «FamilyPlus» con stato `NOT_INVITED`: l'invito parte quando Apple approva la build per gli esterni. La **1.7.0 build 12** era in coda dal 10 novembre alle 22:32 (`WAITING_FOR_REVIEW`); la build 8 era stata rifiutata per testi di prova troppo magri (§8).
- **Fatto (Michele: «Sì, manda anche la 1.8.0»):** testi di `ios/testflight/` riscritti per la **1.8.0 (build 16)** (ancora validi per chi guarda la build 12: le novità sono dette «dalla 1.8.0»), `set-test-info`, `assign-build FamilyPlus 16`, `submit-review 16 --whats-new @ios/testflight/whats-to-test.it.txt` → `WAITING_FOR_REVIEW`. Le due revisioni (1.7.0 build 12 e 1.8.0 build 16) sono versioni diverse e Apple le tratta una per una.
- **Da fare quando Apple approva:** controllare che Archimede e Sara risultino invitati (`node ios/scripts/asc.mjs groups FamilyPlus`); se restano `NOT_INVITED`, `invite-group FamilyPlus` **con l'OK di Michele** (parte una mail a ciascuno). Nessun account developer da creare.

