# Mondrop — meno schede, tre stati per brano, aggiungere e togliere dalle playlist, cancellare solo da Cerca (richiesta 2026-11-10)

- **Data:** 2026-11-10
- **Stato:** **Richiesta registrata; le tre domande hanno avuto risposta il 10 novembre (§8); da costruire in Mondrop 1.8.0**, dopo aver messo in ordine il lavoro sul like e la ripetizione (stessa cartella `ios/`, lo stesso albero: non si lavora in due). Solo interfaccia: nessuna ADR (le regole d'interfaccia stanno nella spec). **Sostituisce in parte** la regola dell'8 novembre «la cancellazione sta solo nelle Impostazioni» (D5)
- **Owner:** Michele
- **Correlati:** `2026-11-08-mondrop-deletion-in-settings-design.md` (D1 e D2 cambiano), `2026-11-08-mondrop-home-spotify-design.md` (la Home, il mini player), ADR-0018 (regola P: l'app non sceglie la sorgente), ADR-0020 (la Home la decide il server), ADR-0023 (l'elenco delle playlist che si cerca e si sfoglia), `docs/mondrop-sync.md`

## 1. Richiesta di Michele (testuale)

«Su Mondrop non vedo utilità nel tab playlist avendo le playlist in home page e al primo accesso viene fatto un sync automatico. Se la url non viene trovata o risolta e va in errore si presume di andare su internet. Dentro ogni playlist le canzoni devono avere uno stato ( online, errore, locale ). Il player in homepage non serve. Per aggiungere in play list lo devo poter fare dalla ricerca o da un link della canzone, il remo e in swipe sulla playlist. La canzone viene cancellata solo con uno swipe della canzone in ricerca, non nel browser di una playlist.»

## 2. Come la leggo (da confermare con Michele)

1. **La scheda «Playlist» sparisce.** Le playlist stanno già nella Home e l'app le aggiorna da sola; una scheda in più non serve.
2. **Un brano è in uno di tre stati, dentro ogni playlist:** **locale** (il file è sul telefono), **online** (non è sul telefono ma si suona da SoundReel) ed **errore** (non si riesce né a scaricare né a suonare).
3. **Un indirizzo che non si trova o non si risolve non è un errore: si va online.** Non si mostra «errore» perché un file non c'è o un nome non si risolve: **si presume di andare su internet**, cioè si chiede a SoundReel (che decide da dove). Solo se anche così non si riesce, è «errore».
4. **Il «player» in Home** lo leggo come la scheda **«Riprendi»** (la copertina con il tasto play, in cima): sparisce. Il mini player in basso, uno per tutta l'app, resta (è l'unico player).
5. **Aggiungere a una playlist:** da **Cerca**, e da **un tasto sul brano** (non solo con la pressione prolungata, che non si scopre). **Togliere:** con lo **scorrimento** della riga dentro la playlist.
6. **Cancellare un brano** (dal telefono) **solo con lo scorrimento della riga in Cerca**; **mai** dentro una playlist, dove lo scorrimento toglie dalla playlist e basta.

## 3. Com'è oggi (verificato nel codice dell'app, 10 novembre)

| Cosa | Stato |
|------|-------|
| Le schede | `RootTab`: Home, Cerca, **Playlist**, Posta, Share, Impostazioni (sei: su iPhone le prime quattro restano sulla barra e il resto va sotto «Altro») |
| La Home | Il saluto, il campo «Cosa vuoi ascoltare?» (apre Cerca), **«Riprendi»** (`ResumeSection`: la coda del telefono con copertina e tasto play), poi le sezioni del server: le playlist (una fila di schede che aprono `PlaylistOfflineView`) e i brani (`Ascoltati di recente`, `Nuovi dai reel`) |
| La scheda Playlist | `PlaylistsView`: l'elenco che si cerca, si ordina e si sfoglia (ADR-0023, build 12) e **«Aggiorna»**; si aggiorna da sola quando si apre (`refreshAll`). **Un sync automatico di brani non c'è oggi**: il «Sync» è il pulsante dentro la playlist (`PlaylistOfflineView`), con «Riprova errori», e per brano «Riscarica», «Riprova» e «Link» |
| Lo stato di un brano | `TrackRowStatus` ha **otto** segni (`StatusAccessoryView`): in corso (con la percentuale), scaricato, pronto da scaricare, in coda, da cercare, errore, rimossa dal telefono, da preparare |
| Aggiungere a una playlist | Da **Cerca**, con la **pressione prolungata**: «Aggiungi in coda», «Aggiungi a playlist…», «Scarica sul telefono» |
| Togliere da una playlist | Dalla pagina del sito; **nell'app non c'è** uno scorrimento sulla riga |
| Cancellare un brano dal telefono | **Solo** dalle Impostazioni (`SpaceView`, «Spazio e brani scaricati»), sempre con conferma; nessuna riga di brano lo offre (`DeletionInSettingsTests`) |

## 4. Decisioni (default proposti, da correggere se non vanno)

| # | Decisione | Default proposto |
|---|-----------|------------------|
| U1 | **Senza la scheda Playlist** | Le schede diventano **cinque**: Home, Cerca, Posta, Share, Impostazioni (tutte sulla barra dell'iPhone, niente «Altro»). L'elenco intero delle playlist (cerca, ordina, pagine) **resta**, ma **dentro la Home**: la fila delle playlist ha un «**Tutte**» che apre `PlaylistsView` nella pila della Home, non come scheda. Il segno «Posta» e il suo contatore non cambiano |
| U2 | **Il sync automatico** | **Confermato da Michele: «Deve fare il sync. Se sono molti gb deve avvisare oppure limitare, da internet in Wi-Fi deve solo avvisare dei gb con la possibilità di annullare o limitare - oppure i max gb possono essere una configurazione».** **Al primo accesso l'app fa il sync da sola**: aggiorna le playlist e **scarica i loro brani** (prepara e scarica, come il «Sync» dentro una playlist). **Prima di scaricare** somma i byte dei brani da scaricare (il manifest li dà) e **se superano il limite** chiede: «Da scaricare N GB (M brani)» con **Scarica tutto · Limita a X GB · Annulla**. **Il limite è una configurazione** (Impostazioni → Sync, «Avvisa sopra»: 1, 2, 5, 10, 20, 50 GB o mai; di partenza **2 GB**). **Limita** scarica fino al limite nell'ordine delle playlist e dei brani; **gli altri restano «online»** (si suonano da SoundReel). **Sotto il limite parte senza chiedere.** L'app **non distingue casa e internet** (regola P): l'avviso vale ovunque, anche dal Wi-Fi di fuori, dove **avvisa soltanto** (non blocca); la rete cellulare resta spenta per i download come oggi, finché non la accendi. **Dopo il primo accesso** il sync dei brani resta quello di oggi («Sync» dentro la playlist) e se ne aggiunge uno **«Sync»** sulla fila delle playlist nella Home (tutte le playlist, con lo stesso avviso). L'elenco delle playlist si aggiorna a ogni apertura (leggero) |
| U3 | **I tre stati** | Il segno accanto a ogni brano **in una playlist** è uno solo di tre: **locale** (spunta: il file è sul telefono), **online** (nuvola: si suona da SoundReel), **errore** (triangolo rosso: non si scarica né si suona). Mentre un brano **si scarica**, il segno «online» mostra la **percentuale**. Gli altri cinque segni di oggi (in coda, da cercare, rimossa dal telefono, da preparare, pronta da scaricare) **non si vedono più**: sono tutti «online». La scelta è una funzione pura sullo stato di oggi (`TrackRowStatus`), con la sua tabella di prova |
| U4 | **Un indirizzo che non si trova o non si risolve → online** | **Non è mai un errore a sé.** Un brano che il server non ha ancora (da preparare, da cercare) o un nome che non si risolve è **online**: si suona (o si scarica) chiedendolo a SoundReel, che decide da dove (**regola P: l'app non sceglie la sorgente e non guarda la rete**). **Errore** è solo un tentativo vero di scaricare o suonare che è fallito (il server dice «fallito» o la risposta non arriva a buon fine). «Riprova» resta sul brano in errore |
| U5 | **Il «player» in Home** | **Confermato da Michele: il mini player in basso.** **Nella Home (la pagina principale) non c'è la barra del mini player**; c'è su tutte le altre schede e **sulle pagine che si aprono dalla Home** (una playlist, l'elenco «Tutte»): lì serve vedere cosa suona. La scheda «**Riprendi**» **resta**: è il modo di arrivare al Player dalla Home. `HomeStructureTests` («il mini player su ogni pila») diventa «su ogni pila, tranne la pagina principale della Home» |
| U6 | **Aggiungere a una playlist** | **Confermato da Michele: «Aggiungere il tasto alla canzone ricercata per aggiungere alla playlist».** Un **tasto «+» visibile su ogni brano trovato in Cerca**, che apre la scelta della playlist (`PlaylistPickerView`, che c'è già); la pressione prolungata (che c'è già) resta. Dal Share Extension si può già scegliere la playlist. Niente incolla di indirizzi |
| U7 | **Togliere da una playlist** | **Scorrimento a sinistra** sulla riga di un brano **dentro la playlist** → «**Togli dalla playlist**» (non cancella niente, non chiede conferma: si rimette dalla ricerca). Vale per le playlist **statiche proprie**; nelle dinamiche, nelle automatiche (le fa la regola) e in quelle condivise con te non c'è |
| U8 | **Cancellare un brano** | Solo **scorrendo la riga in Cerca**: «**Cancella dal telefono**», con la **stessa conferma** e la **stessa riga nel registro delle azioni** di «Spazio e brani scaricati» (ADR-0009). **Mai** in una playlist (lì lo scorrimento è «Togli»), **mai** nelle fila della Home, **mai** dal Player. **«Spazio e brani scaricati» nelle Impostazioni resta com'è** (liberare tanto in una volta). **Questa regola sostituisce D1 e D2 della spec dell'8 novembre** (cancellare solo nelle Impostazioni) |

## 5. Cosa si costruisce

- **`RootTabView`:** cinque schede; `RootTab.playlists` sparisce; `PlaylistsView` si apre dalla Home (un «Tutte» sulla fila delle playlist); la modalità demo e le sue opzioni (`-MondropDemoTab playlists`) si adeguano.
- **`HomeView`:** niente mini player nella pagina principale (ma sì sulle pagine aperte da lì, U5); la fila delle playlist ha «Tutte» e «Sync» (U1, U2); «Riprendi» resta; l'elenco si aggiorna a ogni apertura.
- **Il sync del primo accesso** (U2): un controllo della dimensione prima di scaricare (funzione pura sui byte del manifest e sul limite), la domanda «Scarica tutto · Limita a X GB · Annulla», il limite in Impostazioni → Sync (`Avvisa sopra`), e «Limita» che sceglie i brani nell'ordine delle playlist fino al limite.
- **Gli stati:** una funzione pura `SongState` (locale, online, errore) calcolata da `TrackRowStatus` e usata da tutte le righe che stanno in una playlist (`PlaylistOfflineView`); il segno e le etichette per l'accessibilità («Sul telefono», «Online», «Errore»).
- **Le azioni sulle righe:** «+» e pressione prolungata (U6); scorrimento «Togli dalla playlist» (U7); scorrimento «Cancella dal telefono» solo in `SearchView` (U8), con la conferma e il registro che già esistono.
- **I test:** la tabella di U3 (ogni stato di `TrackRowStatus` → uno dei tre); le schede (nessuna «Playlist»); la Home non ha il mini player nella pagina principale ma lo ha nelle pagine aperte da lì; **dove sta la cancellazione**: `DeletionInSettingsTests` diventa «dove si cancella»: **solo** `SettingsView` (Spazio) e `SearchView` (scorrimento); nessuna riga di playlist, nessuna scheda della Home e nessun Player lo offre; lo scorrimento di una playlist offre solo «Togli dalla playlist»; `RulePTests` e `HomeStructureTests` invariati.

## 6. Rischi

- **Molte playlist e nessuna scheda:** l'elenco intero (cerca, ordina, pagine) è dietro «Tutte»: vale la scelta dei 100 elementi (spec look & feel §3.6).
- **Il sync automatico che scarica tutto** può essere pesante (decine di GB): per questo c'è l'avviso sopra un limite che si configura (U2), e «Limita».
- **Cancellare con uno scorrimento** è più facile da sbagliare che dalle Impostazioni: per questo resta la conferma e resta nel registro.
- **«Online» non vuol dire «disponibile»:** un brano che SoundReel non ha ancora si presume online (U4) e può diventare «errore» solo dopo un tentativo vero.

## 7. Domande che c'erano (risposte nel §8)

1. **U2:** al primo accesso, il sync automatico deve **solo aggiornare l'elenco** delle playlist e dei brani (leggero, nessun file) o **scaricare anche i brani** sul telefono?
2. **U5:** «il player in homepage» è la scheda **«Riprendi»** in cima alla Home (copertina e tasto play)? Oppure il **mini player** in basso quando sei nella Home?
3. **U6:** «da un link della canzone» è un **tasto «+» o un menu sul brano**, oppure **incollare l'indirizzo** di una canzone (YouTube o altro) per metterla in una playlist?

## 8. Risposte di Michele (10 novembre)

1. **Sync:** «Deve fare il sync. Se sono molti gb deve avvisare oppure limitare, da internet in Wi-Fi deve solo avvisare dei gb con la possibilità di annullare o limitare - oppure i max gb possono essere una configurazione» → U2: **sync al primo accesso che scarica**, con avviso sopra un limite configurabile (Impostazioni → Sync) e «Limita»; **la lettura «da internet in Wi-Fi solo avvisa» la rendo con un avviso uguale ovunque** (l'app non distingue casa e internet: regola P) e senza bloccare. Il limite di partenza (2 GB) è mio.
2. **Player:** «Il mini player in basso» → U5: niente mini player nella pagina principale della Home; «Riprendi» resta. **Che le pagine aperte dalla Home lo abbiano è una mia scelta** (se non va, si toglie anche da lì).
3. **Link:** «Aggiungere i tasto alla canzone ricercata per aggiungere alla playlist» → U6: un tasto «+» sul brano trovato in Cerca.
