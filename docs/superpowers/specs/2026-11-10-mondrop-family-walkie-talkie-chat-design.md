# Mondrop — walkie-talkie e chat della famiglia, da telefono a telefono (roadmap)

- **Data:** 2026-11-10
- **Stato:** **Richiesta registrata, in roadmap.** Niente è implementato né deciso: questa spec raccoglie la richiesta, i fatti tecnici verificati e le decisioni da prendere, con il default che propongo. Nessun codice, nessuna rotta, nessuna migrazione
- **Owner:** Michele
- **Correlati:** `adr/0027-family-messages-voice-and-files-travel-device-to-device.md` (proposto), `adr/0015-mondrop-inbox-server-side-push-as-doorbell.md` (la posta sta sul server, il push è solo il campanello), ADR-0018 (regola P), `docs/share.md` (key per utente e dispositivo), `docs/mondrop-inbox.md`, `docs/mcp.md`

## 1. Richiesta di Michele (testuale)

«roadmap: mondrop diventa un walkie talkie fra la famiglia, e una chat. integrata con gli strumenti di ai fa scambio files, usando protocolli fuo ed evitando server centrali sfruttando protocolli e reti diprossimira»

(Riportata com'è, refusi compresi: «diprossimira» è «di prossimità»; **«fuo» non so leggerlo**, vedi D2.)

## 2. Come la leggo (da confermare con Michele)

- **A. Tre cose in Mondrop, per la famiglia:** un **walkie-talkie** (voce «premi e parla», dal vivo, a una persona o a tutti), una **chat** (testo e vocali) e lo **scambio di file** fra i telefoni.
- **B. «Integrata con gli strumenti di AI»:** la conversazione e i file toccano ciò che SoundReel già sa fare (trascrivere, riassumere, tradurre, leggere ad alta voce, analizzare un link o un file e metterlo nel diario). La lettura più semplice: **SoundReel è anche un «membro» della conversazione** che risponde quando lo chiami. Che cosa intendi davvero lo chiedo in D6.
- **C. «Protocolli fuo…»:** parola che non so leggere. Non la interpreto (D2): sotto c'è il default «protocolli aperti e documentati», ma può essere altro.
- **D. «Evitando server centrali, sfruttando protocolli e reti di prossimità»:** messaggi, voce e file viaggiano **da telefono a telefono**, senza un servizio in mezzo, usando ciò che collega dispositivi vicini: la rete di casa, il Wi-Fi diretto fra telefoni, il Bluetooth. «Server centrali» lo leggo come **servizi di terzi, o obbligatori** (WhatsApp, Telegram, un cloud). **Se il SoundReel di casa (tuo, ma pur sempre un server) conta come «centrale» è la domanda più importante (D1)**: da lì dipende se funziona anche quando siamo lontani.
- **E. Cosa la richiesta non dice e conta:** (1) come ci si **riconosce** senza un server (chi è «Sara»?); (2) **fuori casa**, fra telefoni che non si vedono; (3) il telefono **in tasca**, con l'app chiusa: iOS la sospende, e a un messaggio che arriva «da telefono a telefono» non può dire «svegliati» (§4).

## 3. Cosa c'è già nel progetto (verificato nel repository)

| Cosa | Stato |
|------|-------|
| Mondrop | App nativa iOS 17 e macOS 14 (SwiftUI, XcodeGen), bundle `it.mikesoft.mondrop`, App Group, Share Extension, distribuita da TestFlight (gruppo «Family»). `UIBackgroundModes` ha solo `audio` (il player). `NSLocalNetworkUsageDescription` c'è già, ma dice «Mondrop parla con il server SoundReel sulla rete locale» |
| Identità | Una **key per utente Authelia (`Remote-User`) e nome del dispositivo** (`GET/POST /mondrop/connect`, `docs/share.md`): il server sa già quali dispositivi sono di quale persona. È il posto naturale per un **elenco di chiavi pubbliche**, senza che veda un solo messaggio |
| Campanello | ADR-0015: la posta sta sul server, **APNs è solo il campanello**; il codice c'è ma è **spento finché non c'è la chiave** (`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_FILE`) |
| AI locale | Whisper e TTS dietro il gpu-router (`/whisper`, `/api/tts/render`), Ollama (`glm-4.7-flash`, `qwen3.5:122b`), server MCP (`docs/mcp.md`); **mai Claude per la pipeline**. Tutto in casa: da fuori dipende dal server raggiungibile |
| Pipeline dei link | `POST /api/share` (stub, coda, esito di ritorno nella Posta): un link o un file mandato a SoundReel **ha già la strada**, la chat non ha bisogno di rotte nuove per questo |
| Regola P (ADR-0018) | «I client parlano sempre e solo con SoundReel»: vale per **libreria, negozi e fonti** (`RulePTests` vieta `192.168.`, DLNA, `mediaUrl`, la scelta della sorgente in base alla rete). Letta alla lettera **contrasta** con due telefoni che si parlano: va delimitata (D7) |

## 4. Fatti tecnici verificati (10 novembre 2026)

| Fatto | Conseguenza per la richiesta |
|-------|------------------------------|
| **PushToTalk** (framework Apple, iOS 16 e successivi) è il modo di fare un walkie-talkie che funziona con l'app chiusa (interfaccia di sistema, canale, audio in background). **Usa APNs**: il token effimero del canale va mandato a un server, che spedisce notifiche di tipo `pushtotalk`; arrivano finché l'utente resta nel canale, anche con l'app terminata | Un walkie-talkie **col telefono in tasca non può essere solo P2P**: serve **almeno il campanello** (Apple, per forza, più un mittente: SoundReel, che ha già il codice dormiente) |
| **Multipeer Connectivity** chiude le sessioni quando l'app va in background e non ha esecuzione in background; Apple consiglia Network.framework (una voce di forum, non verificata, parla di dismissione in Xcode 27 beta) | Non è una base: meglio **Network.framework** (Bonjour e connessioni dirette, con l'opzione peer-to-peer per telefoni vicini senza access point: da provare nello spike) |
| **Wi-Fi Aware** è in iOS 26 (iPhone 12 e successivi, WWDC25): connessioni dirette senza internet né access point, standard aperto, su Android dalla 8; l'interoperabilità vera è segnalata immatura nei forum | Mondrop ha come minimo iOS 17: sarebbe **una via in più** dietro `#available`, non la base. Serve davvero solo se un giorno entra Android |
| **Fuori dalla stessa rete o dalla portata radio** due telefoni dietro NAT non si trovano da soli | «Nessun server» vale **solo da vicino**: da lontano serve un **punto d'incontro** (indirizzi, non contenuti) e, quando la connessione diretta fallisce, un **relay** |
| Una rete **ospiti** o una Wi-Fi con isolamento dei client blocca Bonjour; il permesso «Rete locale» di iOS va concesso (ci sono segnalazioni di problemi su iOS 18) | La prossimità in casa funziona **di norma, non sempre**: serve un messaggio chiaro e una via di ripiego |

Fonti: [PushToTalk, creare un'app](https://developer.apple.com/documentation/pushtotalk/creating-a-push-to-talk-app), [`PTChannelManager`](https://developer.apple.com/documentation/pushtotalk/ptchannelmanager), WWDC22 sessione 10117 (il tipo di notifica `pushtotalk` e il topic `.voip-ptt` li ho letti in post dei forum Apple, **da verificare nello spike**); [Multipeer Connectivity](https://developer.apple.com/documentation/multipeerconnectivity) e il [thread sul funzionamento in background](https://developer.apple.com/forums/thread/836124); [MacRumors su Wi-Fi Aware in iOS 26](https://www.macrumors.com/2025/06/21/ios-26-adding-two-new-wi-fi-features/) e il [thread su iOS 26 e Android](https://developer.apple.com/forums/thread/790195); [thread sul permesso Rete locale su iOS 18](https://developer.apple.com/forums/thread/774244).

## 5. Decisioni da prendere (default proposti, da correggere se non vanno)

| # | Decisione | Default proposto |
|---|-----------|------------------|
| D1 | **Quanto è stretto «senza server centrali»** | **Il contenuto (testo, voce, file) non passa e non resta mai su nessun server**: va da telefono a telefono, cifrato da un capo all'altro. SoundReel può fare **solo tre cose**: tenere l'**elenco delle chiavi** dei dispositivi (chi è chi), suonare il **campanello** (APNs, senza contenuto: «Sara ti sta chiamando») e, **solo se lo accetti in F4**, fare da **punto d'incontro** per i telefoni lontani (indirizzi, non contenuti; relay cieco quando la connessione diretta non riesce). Niente servizi di terzi, tranne APNs di Apple, inevitabile su iPhone. *Alternative:* **(a) strettissimo**: solo vicinanza, niente campanello né relay, funziona solo con le app aperte e i telefoni nello stesso posto; **(c) casella cifrata sul server** (come la Posta ma cifrata): affidabile anche da lontano, ma è un server che tiene messaggi |
| D2 | **«Protocolli fuo…»** | **Non letta, da chiedere.** Default: **protocolli aperti e documentati**, non un servizio chiuso: formato dei messaggi scritto in `docs/` (come `docs/mondrop-sync.md`), cifratura con primitive standard (Curve25519 e ChaCha20-Poly1305 di CryptoKit, handshake di tipo Noise, **nessun cifrario inventato**), così un altro cliente (il Mac, un nodo Linux a casa, un giorno Android) può parlarlo. Sotto, i trasporti di Apple (Network.framework). Da valutare nello spike: libp2p e altri stack aperti (supporto Swift, limiti in background) |
| D3 | **Chi e cosa** | **La famiglia** (chi ha una key Mondrop = gli utenti Authelia che già ci sono), **solo dispositivi Apple** (iPhone, iPad, Mac), conversazioni **uno-a-uno** e **un solo gruppo «Famiglia»**; niente gruppi liberi, niente Android, niente app TV |
| D4 | **Walkie-talkie** | **Premi e parla** (si parla a turno), voce a bassa latenza (codec da scegliere nello spike), a una persona o a tutta la famiglia; se il destinatario non è raggiungibile **la voce diventa un messaggio vocale** consegnato dopo. **Col telefono in tasca solo con PushToTalk e campanello (F3b)**; prima, app aperta |
| D5 | **Storia dei messaggi** | **Solo sui dispositivi**, cifrata a riposo, **nessuna copia sul server**; un telefono nuovo non ha la storia (a meno che un altro telefono vicino gliela passi); ognuno cancella solo i propri |
| D6 | **AI** | Tre usi, tutti **opzionali e locali**, mai servizi esterni, e **la chat non viene mai letta dal server in silenzio** (il contenuto va a SoundReel solo se chi lo manda lo chiede: una menzione o un pulsante): (a) **sul telefono**, trascrizione di un vocale e traduzione con gli strumenti del sistema, i dati non escono; (b) **«@SoundReel»**, un membro che risponde quando il server di casa è raggiungibile (riassume, traduce, trascrive con Whisper, legge ad alta voce con il TTS che c'è); (c) **link e file** mandati a SoundReel entrano nella pipeline che esiste (diario, canzoni, film, raccolte) e l'esito torna nella Posta |
| D7 | **Regola P** | **Resta com'è per libreria e fonti** (dove stanno i file, da dove si leggono, quali negozi). I **messaggi fra persone sono un altro dominio** (ADR-0027) e vivono in un modulo a sé (`MondropPeer`): `RulePTests` si adegua (il modulo non è soggetto al divieto di indirizzi locali) e un test nuovo impedisce che il modulo tocchi la libreria o i negozi, e che la libreria usi il modulo |

## 6. Architettura proposta (mia)

- **Due piani.** *Contenuti*: messaggi, voce, file, **da telefono a telefono, cifrati da un capo all'altro**; SoundReel non li vede. *Controllo*, il minimo, in SoundReel: **elenco delle chiavi** (si estende la registrazione del dispositivo di `GET/POST /mondrop/connect`: il telefono manda la sua chiave pubblica, il server la lega a `Remote-User`), **campanello** (APNs, come la Posta, ADR-0015) e, se D1 lo ammette, **punto d'incontro**.
- **Trasporti in ordine** (si usa il migliore disponibile): (1) stessa rete di casa: Bonjour e connessione diretta autenticata con le chiavi dei dispositivi; (2) telefoni vicini senza rete: Wi-Fi diretto fra iPhone (peer-to-peer di Network.framework; Wi-Fi Aware dove c'è iOS 26); (3) Bluetooth LE solo per **trovarsi** e per messaggi cortissimi; (4) lontano: punto d'incontro (F4).
- **Chi sei, senza fidarsi del server.** Ogni dispositivo genera la sua coppia di chiavi (Secure Enclave dove si può); il server ne tiene l'elenco, ma **la fiducia vera è di persona**: due telefoni vicini si scambiano un **codice QR** («numero di sicurezza», come Signal). Così un server manomesso non può infilarsi in una conversazione senza che i telefoni se ne accorgano.
- **Messaggio:** id, conversazione, mittente (dispositivo), tipo (testo, voce, file, risposta di SoundReel), contenuto, ora, stato (inviato, consegnato, letto). Archivio **locale** nell'App Group; mai nel diario di SoundReel.
- **Walkie-talkie:** audio dal microfono a pezzi corti, in diretta sul canale aperto; chi riceve lo riproduce subito (con il player che c'è, la musica si abbassa). Voce persa o destinatario assente: messaggio vocale.
- **File:** a blocchi con hash, riprendibili (come i download degli MP3), con un limite di dimensione; dal Share Extension un comando «Invia a un familiare».
- **AI:** vedi D6. **Nessuna rotta nuova** per link e file (c'è `POST /api/share`); «@SoundReel» è **un altro dispositivo** con la sua chiave (un nodo senza schermo a casa, con l'AI locale), non una porta nel server.

## 7. Fasi proposte

- **F0 (questa):** spec + ADR-0027 proposto.
- **F1 — Spike usa e getta** (due iPhone e un Mac; niente test, niente cifratura seria): scoperta sul Wi-Fi di casa e fra telefoni senza rete; un messaggio, un file da 20 MB, 5 secondi di voce; misura della latenza e di cosa succede quando l'app va in background; permessi (Rete locale, servizi Bonjour, microfono); prova di PushToTalk con un campanello da SoundReel (**serve la chiave APNs**). Esce una tabella di misure e le risposte a D1 e D2 **con i numeri**.
- **F2 — Chat e file da vicino** (app aperta): elenco delle chiavi, codice QR, cifratura, archivio locale, scheda «Famiglia», «Invia a…» dal Share.
- **F3 — Walkie-talkie:** (a) dal vivo con l'app aperta; (b) PushToTalk e campanello.
- **F4 — Fuori casa**, solo se D1 lo ammette: punto d'incontro e relay cieco su SoundReel.
- **F5 — AI:** trascrizione sul telefono, «@SoundReel», link e file verso la pipeline.

**Ordine rispetto al resto:** dopo il «look nuovo» del sito e con le build di Mondrop stabili. Lo spike (F1) si può fare quando vuoi, in un giorno.

## 8. Test (alto livello)

- Protocollo, cifratura e archivio con **vettori di prova e un trasporto finto in memoria** (nessuna rete vera nei test automatici): perdita, doppioni, riordino, ripresa, chiave sbagliata rifiutata, messaggio alterato rifiutato.
- **Il server non vede il contenuto:** le rotte nuove (elenco chiavi, campanello) non hanno campi di testo; un test lo controlla.
- **Regola P:** `RulePTests` adeguato (D7) e il test di separazione fra `MondropPeer` e la libreria.
- **Prova reale** con due telefoni (e un Mac) della famiglia: non nei test automatici.

## 9. Rischi

- **iOS in background** e PushToTalk: capability, chiave APNs (oggi non c'è), revisione beta (la build 8 è già stata rifiutata una volta per testi di prova magri: per una chat i testi per chi rivede devono spiegare come provarla).
- **App Review:** una chat fra utenti può richiedere funzioni di segnalazione e di blocco (linea guida sui contenuti generati dagli utenti): da verificare con la revisione beta, anche se è solo per la famiglia.
- **Privacy:** microfono, messaggi di minori (la famiglia può averne), conservazione; tutto resta sui telefoni.
- **Rete di casa:** Bonjour bloccato da reti ospiti o da isolamento dei client; permesso «Rete locale» negato; batteria con scansioni continue.
- **Crittografia e chiavi:** telefono perso (revoca), telefono nuovo (storia), chiave cambiata: da progettare con primitive standard e una revisione prima di fidarsi.
- **Dimensione:** è un progetto grosso quanto il sito: si procede a fasi, con lo spike prima di tutto.
- **«Senza server» contro «fuori casa»:** vedi D1.

## 10. Domande aperte per Michele

1. **D1 (la più importante):** il SoundReel di casa può fare da elenco delle chiavi, campanello e, da lontano, punto d'incontro? Oppure «senza server» vuol dire **proprio senza**, e allora funziona solo da vicino e con le app aperte?
2. **D2:** cosa volevi scrivere con «protocolli fuo…»?
3. **D6:** cosa ti immagini dell'AI nella chat: un «@SoundReel» che risponde, la trascrizione dei vocali, l'analisi dei link e dei file, o altro?
4. **D3:** solo iPhone, iPad e Mac, o prima o poi Android (o l'app TV)?
5. **Quando:** dopo il «look nuovo»? (lo spike si può fare prima.)
