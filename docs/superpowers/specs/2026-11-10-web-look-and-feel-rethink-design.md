# Il look & feel del sito: ripensarlo, con meno spazio vuoto ai lati (richiesta 2026-11-10)

Stato: **progettata (tre tornate di mockup, §3.1–3.3), decisa da Michele e in costruzione per fasi.** **P1 (valori di stile e telaio) e P2 (configurazione per utente sul server) costruite e provate (2.21.0)**, aspettano il suo OK per il deploy; P3 (viste) e P4 («Personalizza», Player spostabile) da fare (piano `docs/superpowers/plans/2026-11-10-web-look-and-feel.md`). ADR-0025 (valori di stile) e ADR-0026 (configurazione).

## 1. Richiesta di Michele (testuale)

10 novembre, mentre guardava la pagina Canzoni con l'elenco delle playlist:

> «non mi piace il l&f generico, con molto spazio libero ai fianchi della pagina principale. dovremmo ripensarlo. ma ora finisci le attività»

Letta così (lettura mia, da correggere): **(1)** l'aspetto del sito oggi gli sembra **generico**; **(2)** il difetto che nomina è lo **spazio vuoto ai lati** del contenuto, che sta in una colonna stretta in mezzo allo schermo; **(3)** vuole **ripensarlo** (non ritoccarlo), insieme; **(4)** non adesso: prima si finiscono le attività aperte.

## 2. Cosa c'è oggi (misurato il 10 novembre, dal CSS e da uno screenshot a 1280 px)

- La testata (`.header-content`, `.sr-header-inner`) è larga fino a **1200 px**; il contenuto delle pagine no: `.list-page-content` (Canzoni, Film, Note…) **800 px**, `.main-content` **900 px**, la pagina Link (`.list-page--library`) **820 px**, le impostazioni 900 px; il gestore delle playlist arriva a 1560 px.
- A 1280 px di schermo la pagina Canzoni occupa circa 750 px al centro: **più di 250 px vuoti per lato**, mentre la testata è più larga del contenuto. Su schermi grandi (1920) i lati vuoti sono più di 500 px.
- Tema scuro unico (regola del progetto), niente libreria di componenti, CSS semplice.

## 3. Come si affronta (proposta di metodo, non ancora il disegno)

1. Una sessione di **brainstorming con mockup da guardare** (non parole): due o tre impostazioni diverse della pagina larga, sullo stesso contenuto vero (la pagina Canzoni con 60 playlist, il Journal, il Player), scelte da Michele.
2. Le direzioni da mettere a confronto, da affinare: contenuto che **usa la larghezza** (lista a sinistra e dettaglio o filtri a destra, come una posta elettronica), **griglia di schede** al posto di una colonna sola, **barra laterale** fissa con le sezioni (oggi nella testata) e le playlist, oppure un **cruscotto** con più colonne per tipo (canzoni, film, software, note).
3. Vale **anche sul telefono** (la spec `2026-11-08-web-mobile-ux-design.md` è ancora da fare): un solo ripensamento che regga schermo largo e stretto, non due.
4. Le regole che restano: tema scuro unico, niente dipendenze pesanti, le pagine continuano a parlare solo con il server (regola P).

### 3.1 Prima tornata di mockup (10 novembre, dopo il suo «vai con il look and feel»)

Una tela di tre direzioni a 1440 px, con la **palette di Mondrop** (giallo `#FFD60A` su blu notte, un solo accento), contenuto d'esempio e **numeri veri** della libreria (1,7k link, 943 canzoni, 731 film, 1,4k software, 56 playlist; i numeri delle raccolte sono d'esempio perché le raccolte non esistono ancora): <https://claude.ai/artifact/KLVkyBKY96mXZR6Wptn6y3> (privata: la apre solo il suo account).

- **A · Studio:** tre colonne (navigazione, elenco, dettaglio) e il Player come barra sempre in basso; si clicca una riga e il dettaglio cambia.
- **B · Bacheca:** parete di schede (ogni post con i suoi brani, film e software in vista) e pannello di dettaglio a destra che si chiude.
- **C · Home:** sezioni come nella Home di Mondrop (Riprendi, nuove canzoni, playlist, raccolte scoperte, da vedere), con le raccolte al loro posto.

Tutte e tre sono fluide: a schermo intero si adattano alla finestra e sul telefono la navigazione diventa una fila in alto. Il colore dell'accento si cambia dai ritocchi (giallo di Mondrop, verde di oggi, azzurro). Non sono ancora codice del sito.

### 3.2 Le risposte di Michele alla prima tornata (10 novembre, testuali)

> «1 - si, mi piace la A con le sezioni di C - possiamo metterle tute e tre configurabili ?
> 2 Giallo e nero - Mondrop like ( e devon andare insieme gli stili )
> 3 si, ma spostabile»

Lette così (letture mie, da correggere):

- **L1. Il telaio è la A (Studio)** (barra in alto, menu a sinistra, area centrale, Player): la Home usa **le sezioni della C** (Riprendi, nuove canzoni, playlist, raccolte, da vedere). **Le tre viste esistono tutte e sono configurabili**: *Home* (le sezioni), *Studio* (elenco e dettaglio), *Bacheca* (parete di schede); si passa dall'una all'altra con un interruttore in testa alla pagina, e ogni pagina **ricorda** la sua vista. Anche le sezioni della Home si scelgono (quali, e in che ordine).
- **L2. Colori e forme di Mondrop, uguali.** Giallo `#FFD60A` come unico accento; il **nero di sistema** (`#000`, righe e schede `#1C1C1E`, rialzi `#2C2C2E`, testo secondario bianco al 72 %, riempimento dei pulsanti-pillola bianco al 12 %) e il **blu notte** (`#242945` → `#080911`) solo dove l'app lo usa (Home e Player); pulsanti a pillola, schede con angoli 14–16, cifre a larghezza fissa. **Devono andare insieme**: un solo elenco di valori (token) per sito e app, con un test che fallisce se i due si allontanano (come `RulePTests` per la regola P). Il colore non si cambia dall'utente.
- **L3. Il Player è una barra sempre disponibile, ma spostabile:** in basso (predefinito), fluttuante e trascinabile, a destra (pannello con copertina e coda), o nascosto (una riga nel menu a sinistra). La scelta si ricorda.

**Domanda ancora aperta (mia):** la configurazione (vista di ogni pagina, sezioni della Home, posto del Player) si ricorda **per browser** o **per utente, su tutti i dispositivi**? Consiglio per utente sul server (una famiglia con più dispositivi: stesso aspetto ovunque; una tabella e una rotta).

### 3.3 La risposta di Michele alla domanda aperta (10 novembre, testuale)

> «si, configurazione per utente - di default vista A»

Letta così:

- **L4. La configurazione è dell'utente e sta sul server** (l'utente di Authelia: Michele, Sara, Archimede): lo stesso aspetto su PC, telefono e tablet. Che cosa si ricorda: la **vista di ogni pagina** (Home · Studio · Bacheca), **quali sezioni ha la Home e in che ordine**, **dove sta il Player** (in basso, fluttuante con la sua posizione, a destra, nascosto). Il server **decide i valori di partenza** (regola P: i client mostrano, non decidono) e **valida** quello che riceve. ADR-0026.
- **L5. Di default la vista è la A (Studio) su ogni pagina**: elenco a sinistra e dettaglio a destra. La Home a sezioni e la Bacheca sono scelte dell'utente, non il punto di partenza. Il Player parte in basso.
- **L6. I valori di stile sono uno solo per sito e app** (ADR-0025): `frontend/src/styles/tokens.css` con gli stessi numeri di `MondropKit/MondropPalette.swift` e un test che li confronta.

**Fasi** (piano `docs/superpowers/plans/2026-11-10-web-look-and-feel.md`; ognuna con i suoi test e il suo deploy, **solo con l'OK di Michele**): **P1** valori di stile e telaio (barra in alto, menu a sinistra, Player in basso) con tutte le pagine dentro il telaio; **P2** la configurazione per utente sul server (tabella, rotte, convalida); **P3** le viste (Studio di partenza, Bacheca, Home a sezioni con la sua rotta del server) e l'interruttore; **P4** «Personalizza» e il Player spostabile.

## 4. Domande aperte per Michele (per quando si comincia)

- Quali pagine contano di più per lui, oggi? (l'ordine d'uso decide dove lavorare per prima.)
- «Generico»: c'è un sito o un'app che gli piace, da cui prendere il tono? (anche Mondrop, che è già giallo su nero.)
- Vuole che il Player diventi la pagina principale, o resta una pagina tra le altre?
