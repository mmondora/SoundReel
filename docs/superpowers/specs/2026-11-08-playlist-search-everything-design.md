# Creare le playlist: la ricerca prende da tutto, non solo dalla libreria (richiesta 2026-11-08)

Stato: **costruita** (SoundReel 2.16.0, 2.16.1 e 2.17.0; le prime due in produzione, la terza in attesa dell'OK di deploy di Michele). Nessun ADR nuovo: è la decisione dell'**ADR-0018** («una ricerca sola su diario, libreria di geekom e NAS», regola P) applicata a un cliente in più, il gestore delle playlist del sito (nota di aggiornamento in coda all'ADR).
Codice: `services/mondropSearch.ts` (`songsOnlyAsFiles`), `routes/songs.ts` (`GET /api/songs?scope=everything`), `frontend/src/hooks/usePlaylistManager.ts` e `components/manager/ManagerPane.tsx`.

## 1. Richiesta di Michele (testuale)

> «anche la creazione delle playlist, la ricerca deve prendere da tutto e non solo dalla libreria»

Si lega alla regola P dello stesso giorno («posso cercare anche senza avere/fare playlist, alla Spotify»; i client parlano sempre e solo con SoundReel, e quanti elenchi ci siano lo sa il server).

## 2. Com'era (misurato l'8 novembre sui dati veri, sola lettura)

- **Dove si creano e si riempiono le playlist:** solo nel gestore del sito (`PlaylistManagerPage`, il «Norton Commander» a due pannelli). L'app Mondrop non ha una schermata di creazione: da Cerca si aggiunge con «Aggiungi a playlist…», e Cerca già cerca in tutto.
- **Cosa cercava il gestore:** il suo pannello «Libreria» caricava `GET /api/songs`, cioè i brani del **diario** (796 per Michele), e la ricerca di testo e i filtri lavoravano solo su quelli. Un brano che esiste **solo come file** (geekom, NAS) non c'era: «Bassi Maestro» dava **0 righe** nel gestore e **11** in Cerca.
- **Effetti collaterali:** un brano solo-file messo in una playlist da Cerca compariva nel gestore come «non nel tuo journal» (segnaposto) e la copia di quella playlist in un'altra lo **saltava**.
- **Quanto è «tutto»:** la ricerca di Mondrop vede **4.439 brani** = 796 del diario + **3.643 solo-file** (3.880 file di geekom e del NAS, raggruppati per canzone come in Cerca; nessuna chiave in comune col diario). Calcolo in 118 ms a freddo e 32–36 ms a caldo, 934 KB di JSON.

## 3. Decisioni prese con valori di default (da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| P1 | **Il pannello «Libreria» del gestore diventa «tutto»** | Si chiama **«Tutti i brani»** (EN «All songs», con il conteggio) e contiene il diario **più** i brani solo-file, **una riga per canzone**, con la stessa identità (`songKey`) e lo stesso raggruppamento di Cerca (ADR-0018, 2.13.1): la stessa registrazione trovata due o tre volte è una riga. La ricerca di testo (ordine delle parole e accenti ininfluenti, anche l'album), i filtri e l'ordine non cambiano: lavorano su tutto. «Libreria» era ambiguo (in SoundReel è anche la libreria MP3 di geekom) |
| P2 | **Lo decide il server** (regola P) | `GET /api/songs?scope=everything` risponde con i brani del diario e, in coda, i brani solo-file ordinati per artista e titolo, con `libraryOnly: true`, `mentions: []`, `meta: null`, le facette vuote (`sources`, `platforms`, `tags`: assenti farebbero scaricare al sito tutti i riepiloghi del diario) e i flag `fs` / `mediaServer` di dov'è il file. Un file di un brano che il diario ha già non è mai una seconda riga (né per chiave né come stessa registrazione con un'altra grafia). **Senza `scope` non cambia niente**: la pagina Canzoni, il player e «Scegli cosa suonare» restano sul diario. Se i file non rispondono (la chiavetta staccata) la lista è quella del diario e l'errore va nel log |
| P3 | **Come si riconosce un brano solo-file** | Un badge «Solo file» (tratteggiato) al posto di tipo e piattaforma (non ha post); il pallino verde e il badge del luogo (FS / MS) come per gli altri, perché il server sa dov'è il file. Non ha tag, anno né genere: nei filtri conta come «senza» (nessun filtro lo esclude per errore finché non se ne sceglie uno che richiede quel dato) |
| P4 | **Tetto alle righe disegnate** | 4.439 righe senza finestra renderebbero la pagina lenta: si disegnano le **prime 300** e «Mostra altri N» (footer: «Mostrati 300 di 4439»). **La ricerca e i filtri lavorano su tutte le righe, non solo su quelle disegnate** e ripartono dalle prime righe; il cursore (frecce, Fine) è sempre disegnato |
| P5 | **Le playlist** | Un brano solo-file in una playlist è una **riga vera** (non «non nel tuo journal») e si copia, sposta e toglie come gli altri; resta segnaposto solo una chiave che nessuno conosce (né diario né file). Il gestore non salta più i brani messi da Cerca |
| P6 | **Fuori da questa richiesta** | La pagina Canzoni (è il diario), le playlist dinamiche (regole sugli ascolti, non una ricerca), l'app Mondrop (Cerca cerca già in tutto). Il **player web** è entrato dopo, su risposta di Michele (P8) |
| P7 | **Versione** | SoundReel **2.16.0** (gestore) e **2.16.1** (correzione, §3b); il player web **2.17.0**; la ricerca dei testi su Internet, che aveva il numero 2.16.0, slitta alla **2.18.0** |
| P8 | **Il player web: «Scegli cosa suonare»** *(risposta di Michele: «Sì, anche il player»)* | Con il pannello aperto, o con una scelta ancora attiva, la lista «Tutte» prende da **tutto** (diario + solo-file): ricerca di testo, autore, album, anni lavorano su tutto. L'elenco grande si chiede **una volta e solo quando serve** (pannello aperto, una scelta attiva, una playlist scelta), non a ogni visita: la pagina si apre sul diario, come prima. **Gli altri scaffali** (preferiti, «mi piace», da ascoltare, scaricati) restano del diario: un solo-file non ha storia di ascolto e finirebbe tutto in «da ascoltare». **Una playlist** si risolve sull'elenco completo (può contenere solo-file). Si disegnano le prime 300 righe e «Mostra altri N». **La coda salvata** (sessionStorage) che contiene un solo-file si ricostruisce dall'elenco completo, una volta, e si salva intera (prima il player la ricostruiva dal solo diario: i solo-file sparivano e la coda più corta veniva salvata sopra quella vera); se l'elenco non arriva usa il diario, se nel frattempo l'utente ha avviato altro vince l'utente |

## 3b. Trovato dopo il deploy (2.16.1)

I controlli post-deploy della 2.16.0 hanno mostrato che **il piano di riproduzione** (`/api/songs/:key/play`, 2.15.0) e lo **stato** (`…/state`) localizzavano il file **per nome** tra i brani del diario: per un brano solo-file senza artista («Track 01») o con un'altra grafia dicevano «nessun file» e in casa avrebbero fatto partire YouTube invece del file sul box. Prima non si vedeva perché il sito non mostrava i solo-file; la 2.16.0 li rende raggiungibili. **Regola:** un brano che non è nel diario sta dove sta **il file che la sua chiave nomina** (la voce di libreria), mai per somiglianza di nome (stessa regola di `libraryFilesOf` per suonare e scaricare). Corretto nella 2.16.1, con test.

## 4. Limiti noti

- Un brano che il diario ha già e un file con un'altra grafia (stesso titolo, un artista in comune) sono **una riga**, quella del diario, come in Cerca: se una playlist ha la chiave della grafia dei file (messa prima che il brano entrasse nel diario) quella riga resta un segnaposto.
- «Mostra percorsi» (W8) per un brano solo-file non mostra percorso: il server non manda indirizzi di negozi (regola P); resta il badge del luogo.

## 5. Test

- **Backend** (`mondropSearch.test.ts`, `routes/songs.test.ts`; 159 file, 2551 test): `songsOnlyAsFiles` elenca una riga per canzone (17 file → 10 brani, due registrazioni dello stesso nome senza artista in comune restano due), li segna `libraryOnly` senza post né metadati e con i flag, li ordina, mostra l'album del **tag** del box e non la cartella, non ripete un brano che la lista ha già (per chiave e come stessa registrazione), è vuoto senza file e lavora sulla lista che gli si dà; la rotta senza `scope` non chiede mai i file, con `scope=everything` li aggiunge in coda, li chiede con la lista che restituisce, e un guasto dei file costa solo i brani in più (con l'errore nel log).
- **Sito** (`PlaylistManagerPage.everything.test.tsx`, `api.songs.test.ts`; nessuno scaricamento dei riepiloghi del diario per i brani solo-file; 70 file, 995 test): il gestore chiede `everything` e il pannello si chiama «All songs (5)»; il brano solo-file è una riga con il badge, il pallino verde e il luogo; «bassi maestro» e «maestro bassi» e l'album trovano i file mai postati; **F5 copia** un brano solo-file nella playlist dell'altro pannello; una playlist che già lo contiene lo mostra come riga vera mentre una chiave sconosciuta resta segnaposto; 300 righe di 350 con «Mostra altri 50», la ricerca trova anche un brano fuori dalle prime 300 e riparte da 300, **Fine** disegna l'ultima riga. Provato rompendo il codice di proposito (niente `everything`, niente tetto, niente badge): ogni rottura fa fallire il test giusto.
- **Prova reale** (sola lettura, `scratchpad/everything_sim.mts`): 3.643 brani solo-file, 4.439 in tutto, 11 di Bassi Maestro, nessuna chiave doppia.

## 6. Domande per Michele e risposte (8 novembre)

1. Nel **player web** («Scegli cosa suonare») vuoi la stessa cosa, cioè tutto? **Risposta: «Sì, anche il player»** (P8, release 2.17.0 con il suo OK di deploy).
2. Il nome del pannello del gestore, **«Tutti i brani»**, va bene al posto di «Libreria»? **Risposta: sì** (nome confermato).
