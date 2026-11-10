# Raccolte: la libreria si ordina da sola per argomento, luogo e tipo (richiesta 2026-11-09)

Stato: **scelte approvate da Michele il 10 novembre** («1 si, - 2 no, - 3 5 voci - 4 ok.», §1.2), con due aggiunte sue (§1.3): il luogo dal testo con i nomi dei locali e il link a Google Maps (qui, §4.6), e le playlist automatiche dai post di musica (spec a parte). **Nessun codice ancora**; si costruisce per fasi (§10), ognuna con il suo OK di deploy. La prova di fattibilità è del 9 novembre, sui dati veri, **in sola lettura e in locale** (§3).
Disegno: `assets/2026-11-09-collections-proposal.html` (mockup, si apre nel browser) e `assets/2026-11-09-collections-proposal.png`.
Spec collegata: `2026-11-10-auto-playlists-and-playlist-list-design.md` (ADR-0023). ADR di questa: ADR-0022.
Codice previsto: backend `services/collections*.ts`, `services/entryPlaces.ts`, `routes/collections.ts`, migrazione `021_collections.sql` (il numero esatto dipende dall'ordine di costruzione); sito `pages/CollectionsPage.tsx`, `components/CollectionRail.tsx`.

## 1. Richieste di Michele (testuali)

### 1.1 9 novembre: la richiesta

> «vorrei che crei una serie di aggregazioni, proponendo alcune di base, sulle viste che possono uscire dalle voci in libreria, ad esempio "ristoranti", "ristoranti a milano", "musica", "wallpaper", "casa", "montagna", "ricette" ecc. fammi delle proposte, sia di aggregazioni, che di ux di come si possno vedere/scegliere. Vorrei sia tutto automagico, ad esempio "vino" viene scoperto da solo e proposto.»

In una frase: la libreria (oggi un diario in ordine di data) deve potersi guardare **per argomento, per luogo e per tipo**, e gli argomenti li deve **trovare da sola**: nessuno li dichiara, nessuno li mantiene.

### 1.2 10 novembre: le risposte alle quattro domande della proposta (Q1 la UX, Q2 Mondrop, Q3 la soglia e il tono, Q4 i nomi di base)

> «1 si, - 2 no, - 3 5 voci - 4 ok.»

Lette così: **Q1 sì**, A (binario) e B (pagina) subito e poi C (scaffali); **Q2 no**, le raccolte che non sono musica restano del sito e Mondrop non le mostra (le **playlist** che nascono dalla musica sì, spec a parte); **Q3 5 voci**, attive da sole; **Q4 ok**, l'elenco di §4.5.

### 1.3 10 novembre: due aggiunte

> «Voglio anche che il luogo venga identificato dal testo ( es: voce che dice "ecco i ristoranti nuovi da provare su milano" e in tal caso voglio anche una sezione con i nomi dei ristoranti ) e abbia un link a googlemap (oppure apri in gmap ).»

È §4.6 (e cambia §4.3 e §6).

> «voglio anche che se il reeel/post parla di musiche ( ecco le 5 musiche di natale ) mi venga creata una "playlist con il titolo adeguato" e le 5 musiche dentro. se il titolo è generico ( ecco gli album jaaz da ascoltare ... ) la play list è "jazz da ascoltare" e deve essere una sola. in tal caso le musiche sono ordinate per data di inserimento, le ultime per prime per facilitare gli ascolti. mondrop deve permettere di vedere queste play list. Se le play list diventano molte devo poterle selezionare/paginare/cercare, e di fianco al nome la data di creazione e un ordine di data. questo anche su mondrop.»

È un'altra funzione (le playlist, non le raccolte): spec `2026-11-10-auto-playlists-and-playlist-list-design.md`, ADR-0023.

## 2. Cosa c'è oggi (misurato il 9 novembre 2026, sola lettura)

- **1696 voci complete** (dal 14 febbraio), tutte di Michele tranne una anonima (la famiglia non ha ancora voci proprie, nessuna condivisione). Il ritmo è salito: 92 in aprile, 278 in agosto, **347 in ottobre**, circa 11 al giorno. A mano non si tiene in ordine.
- **Si guardano come una lista per data** (pagina «Link»: solo un filtro per testo, 40 voci per volta). Esistono le pagine per **tipo** (canzoni, film, note, software) ma nessuna vista **per argomento**.
- **I tag non bastano come chiave:** 3256 tag diversi; i più frequenti sono segnaposto che il modello ricopia dal prompt (`#tag` in 129 voci, `@utente` in 75) e lo stesso tema è spezzato in varianti (intelligenza artificiale: `#ai` 157 voci, `#aitools` 67, `#intelligenzaartificiale` 60, `#aiagents` 47, `#artificialintelligence` 41…).
- **Cosa c'è dentro:** circa la metà parla di intelligenza artificiale e sviluppo; 719 voci hanno canzoni (ma solo **94** hanno canzoni che vengono dal **contenuto** del post, le altre circa 626 solo l'impronta audio del sottofondo), 256 film, 701 software, 264 un luogo (nota `place`), 69 un libro; il resto è una coda lunga di nicchie (§3).
- **Il materiale per mostrarle c'è:** il 96 % delle voci ha una miniatura (1621) e 981 sono caroselli con immagini. 225 note hanno già coordinate, ma **sbagliate spesso** (nel campione: «Luogo» → Cremona, «Montagna» → Reims, §4.3).
- **I mezzi locali ci sono già:** Ollama dietro il gpu-router ha `nomic-embed-text` (vettori, 137 M) e `glm-4.7-flash` (testo). Nessun servizio nuovo e **niente pgvector** (ADR-0001 resta valida: 1700 vettori stanno in una tabella e si confrontano in memoria).

## 3. La prova: la scoperta da sola funziona (e dove no)

Ho preso riassunto e tag delle **1643 voci** con testo, ne ho fatto i vettori con `nomic-embed-text` (**12 secondi in tutto**, circa 7 ms a voce), le ho raggruppate (vettori centrati sulla media, soglia calibrata sui dati) e ho fatto nominare i gruppi a `glm-4.7-flash` (32 gruppi in 16–25 secondi). Tutto locale, nessuno ha detto al sistema quali argomenti cercare. **Tutte le voci con testo hanno partecipato, comprese quelle con canzoni** (i risultati sotto non si riproducono togliendole).

**Cosa è uscito da solo** (voci per gruppo; i nomi sono quelli dopo la pulizia di §5):

| Gruppo trovato | Voci | Nota |
|---|---|---|
| **Vino** (vini italiani, vitigni, prezzi) | 15 | tutte e 15 hanno una parola del vino (controllo con un'espressione indipendente) |
| **Ristoranti** | 7 | tutte parlano di ristoranti o di Milano; 5 su 7 dicono «Milano» (§4.3) |
| **Casa e design** (bioedilizia, progettare casa) | 10 | |
| **Energia e domotica** (fotovoltaico, accumulo; casa smart) | 9 + 12 | due gruppi vicini: si fondono |
| **Viaggi** | 7 | |
| **Salute** (due temi precisi) | 19 + 11 | |
| **Finanza e investimenti** | 38 | |
| **Auto e moto** | 12 | |
| **Anime** | 24 | |
| **Moda e stile** (armadio sostenibile) | 6 | |
| **Intelligenza artificiale**, con i sotto-temi usciti da soli: AI locale e modelli, agenti, MCP e skill, voce e audio, video e immagini… | molte decine | metà della libreria: serve la gerarchia (§4.4) |

**Cosa ha insegnato la prova** (decide il disegno):

1. **Trova nicchie vere a costo quasi zero**, anche piccole (7 voci). «Vino» è uscito senza che nessuno lo nominasse.
2. **I nomi liberi del modello sono sporchi:** simboli (`#Vini italiani`, `@Tecnologia`), refusi («Tinitus», «Alzhaimer»), un nome fatto di JSON rotto, un padre sbagliato (moda sostenibile sotto «Cibo e bevande»), il gruppo di Milano chiamato «Colazioni e caffè» senza il luogo. Con **un elenco di circa 30 nomi di base** da cui scegliere e una **pulizia** (tolgo `#@"*`, ritrovo il nome dell'elenco anche scritto `Intelligenza_artificiale`) i nomi diventano giusti quasi sempre; restano 3 su 32 inventati male («Modafair»): vanno **scartati e ritentati**, non pubblicati.
3. **I gruppi generici si spezzano o si mescolano:** la musica è uscita in tre gruppi (277, 164 e 62 voci) e uno è stato chiamato «Mente»; l'intelligenza artificiale in undici. Quindi un gruppo **musicale** o **di film** non si pubblica come tema (è già un tipo, §4.1) e un gruppo senza coerenza **non si pubblica** (§5.4).
4. **I luoghi per voce sono sporchi come i nomi:** su 7 voci di Milano, 3 danno «Milano» pulito, 2 lo danno sporco («Milan», «#Milano»), 1 è un JSON rotto e 1 non dà niente: dopo la pulizia restano **5 su 7** (il JSON rotto vale «nessun luogo»); su 15 del vino 13 non danno luogo (giusto) e 2 ne inventano uno («Montagne de Reims»: vero, ma il post non lo nomina). Per questo il luogo si accetta solo se **compare nel testo** della voce (§4.3).
5. **Gli esempi di Michele, onestamente, oggi:** **vino** e **ristoranti a Milano** esistono già; **casa** (10) e **montagna** (4–6 voci a occhio: il Cervino, un hotel a Bressanone…) sono piccole; **ricette** 2–3 voci; **wallpaper** 1 voce (quella di stamattina). Le ultime tre **non si vedranno finché non arrivano a 5**: è voluto (§5), e **quando arrivano compaiono da sole**, che è il punto della richiesta.
6. **Quando sarebbero nate** (rigiocando la storia con la regola «5 voci»): circa **34 raccolte da marzo a ottobre, cinque al mese**; «Vino» il **20 maggio**, «Energia e domotica» il 7 agosto, i ristoranti di Milano il **17 settembre**, «Viaggi» il 20 settembre, «Casa e design» il 21 settembre. È un'approssimazione: il raggruppamento è stato fatto una volta sola su tutta la libreria, non voce per voce.

### 3.1 I parametri della prova (per rifarla)

- **Testo di ogni voce:** il riassunto (se manca, la didascalia, 400 caratteri) + fino a 12 tag puliti (via `#tag`, `@utente`, `#fyp`, `#viral`, `#perte`, `#foryou`, `#foryoupage`, `#reels`, `#instagram`, `#explore`, `#trending`, `#x` e ogni `@…`), al massimo 1400 caratteri; 1643 voci su 1698 (55 non hanno abbastanza testo).
- **Vettori:** `nomic-embed-text` con `POST /api/embed` del gpu-router, testo preceduto da `clustering: `, a gruppi di 32; poi lunghezza 1, **sottratta la media della libreria** e di nuovo lunghezza 1. Senza la sottrazione tutte le voci si somigliano: con vettori non centrati la soglia utile era 0,84 e il risultato peggiore (un gruppo da 669).
- **Gruppi:** voce per voce in ordine di data, ognuna entra nel gruppo con il centro più simile se il coseno è ≥ **0,42**, altrimenti ne apre uno; poi 3 passate che rimettono ogni voce al centro più vicino; poi si fondono i gruppi con centri a coseno ≥ **0,54** (soglia + 0,12). Risultato: 43 gruppi da almeno 4 voci, 76 % delle voci coperte. Sensibilità: soglia 0,35 → 33 gruppi da 5 o più con l'89 % coperte; 0,45 → 33 gruppi con il 63 %.
- **Nomi:** `glm-4.7-flash:q4_K_M`, `format` = JSON Schema, `think: false`, 8 riassunti del gruppo (170 caratteri) e i tag più frequenti, l'elenco del §4.5 nel prompt.
- **Luoghi:** una voce per volta (testo 300 caratteri e tag).
- **Gli script della prova stanno nella cartella di lavoro della sessione, non nel repository**: il **primo passo del piano è rifare la calibrazione** (fase 0: esportare i testi, fare i vettori, i gruppi, e fissare le costanti sull'insieme d'oro di §9). L'accesso ai dati è lo stesso della prova (lettura del database di produzione, come i controlli post-deploy); l'insieme d'oro si legge poi dall'anteprima del ricalcolo (§9), mai scrivendo.

## 4. Le aggregazioni: tre strati

Una **raccolta** è una vista sulle voci (non una copia: una voce può stare in più raccolte, e in ognuna c'è una volta sola; il link al post resta su ogni card, ADR-0017).

### 4.1 Tipi (sempre presenti, calcolati sull'estrazione, gratis)

**Musica** · **Film e serie** (256) · **Software e app** (701) · **Luoghi** (264) · **Libri** (69). Sono **predicati sul database** (`results.songs`, `films`, `software`, note `place` e `book`), **non righe** della tabella delle raccolte, ma l'API li dà come raccolte «virtuali» con id fisso (`type:music`, `type:films`, `type:software`, `type:places`, `type:books`). Ognuno ha la sua vista migliore (Musica → «Suona», il player e le playlist che esistono; Film → locandine e «da vedere / visto»; Software → elenco con link; Luoghi → i locali di §4.6; Libri → copertine): la raccolta è una **porta** verso pagine che esistono.
- **Musica** = ogni voce con **almeno una canzone** nell'estrazione, qualunque ne sia la fonte (719 il 9 novembre). Delle 719 solo **94** hanno canzoni che vengono dal contenuto del post (`ai_analysis`, `both`, liste, link): sono quelle che alimentano le **playlist automatiche** (spec playlist). Le altre sono reel con un sottofondo riconosciuto: stanno in «Musica» **e** nel loro tema (un reel sul vino con una canzone di sottofondo è in «Musica» e in «Vino»: i tipi sono ortogonali ai temi). Una faccetta «Fonte» della pagina Musica può separarli («il post parla di musica» / «musica di sottofondo»).
- **I gruppi trovati dai vettori che sono musicali o di film non sono temi** (§5.4): sono già «Musica» e «Film e serie».

### 4.2 Temi (scoperti, righe in tabella)

Gruppi di voci che parlano della stessa cosa, trovati dai vettori (§5) e nominati con l'elenco di §4.5. Nascono con 5 voci, muoiono sotto 3. **Vino, Casa e design, Montagna e outdoor, Ricette, Sfondi** dell'elenco di Michele sono temi: oggi due sono già vivi (§3), gli altri compaiono quando arrivano a 5.

### 4.3 Luoghi (dal testo) e combinazioni

Richiesta di Michele (§1.3): **il luogo si identifica dal testo** della voce.
- **Il luogo di una voce** è una città, una regione o un paese **nominato** nel testo: didascalia, riassunto, tag, note, e il testo letto nel video (OCR sulle immagini, parlato). Lo estrae una chiamata dedicata (la stessa dei locali, §4.6), in coda dopo l'analisi, mai dentro l'analisi.
- **Il controllo è letterale:** il luogo che il modello restituisce deve **comparire nel testo** della voce (dopo la pulizia: via `#`, maiuscole, accenti; varianti come «Milan» → «Milano» con l'elenco dei luoghi). Così non entra «Montagne de Reims» da un post sul vino che non lo nomina. Un luogo fuori dall'elenco (comuni italiani, regioni, paesi) o un JSON rotto vale «nessun luogo». **Mai** dalla geocodifica delle note di oggi (sbagliata: «Luogo» → Cremona, «Montagna» → Reims).
- **Faccetta «Dove»** di una raccolta: i luoghi nominati da almeno 2 voci della raccolta (è un aiuto per filtrare, soglia bassa).
- **Combinazioni, calcolate e non salvate:** «Ristoranti · Milano» compare come chip e come link (`?dove=milano`) quando tema × luogo hanno **almeno 5 voci**; «Milano» da sola (tutti i temi e i tipi) è una raccolta **virtuale** (`place:milano`) a 8 o più voci. Nessuna combinazione si scrive a mano e nessuna ha un ciclo di vita proprio: nasce e muore con i numeri. «Ristoranti a Milano» dell'elenco di Michele è questa.

### 4.4 Gerarchia e appartenenza

- **Le intestazioni** («Cibo e bevande», «Casa», «Tecnologia»…) sono **etichette fisse della tabella del seme** (§4.5): raggruppano la pagina «Raccolte», **non sono raccolte**, non hanno conteggio né id. Una raccolta il cui nome non è nel seme sta sotto «Altre».
- **Le raccolte hanno due livelli:** un tema e i suoi figli trovati (Intelligenza artificiale → AI locale e modelli, Agenti, Voce e audio, Video e immagini…); chi non ha un figlio chiaro resta nel padre. Il binario non mostra più di circa 12 raccolte (le più vive); il resto sta nella pagina «Raccolte».
- **Appartenenza:** una voce entra nel tema (foglia) con il centro più simile se il coseno supera la soglia, e **anche nel secondo** se supera la soglia pure lui (al massimo 2 temi per voce, sulla card al massimo 2 chip di tema); entra anche nel padre del suo tema. I tipi e i luoghi sono **ortogonali** (una voce è in «Musica» e in «Vino» insieme). Le correzioni dell'utente (`user_add`, `user_remove`) vincono sempre (§5.8).

### 4.5 Il set di base (il «seme»)

Un elenco di **circa 30 nomi italiani**, in un solo posto del codice (`SEED_COLLECTIONS`, con l'intestazione di ognuno), che serve **solo a dare nomi puliti**: una raccolta non esiste finché non ha voci, e un argomento che non è in elenco si può trovare lo stesso (§5.5). Michele: «ok» (Q4).

| Intestazione | Nomi di base |
|---|---|
| Tipi (virtuali) | Musica · Film e serie · Software e app · Luoghi · Libri |
| Cibo e bevande | Vino · Ristoranti · Ricette |
| Casa | Casa e design · Fai da te · Energia e domotica |
| Fuori casa | Viaggi · Montagna e outdoor · Animali e natura |
| Persone e salute | Salute · Sport e fitness · Mente e spiritualità · Famiglia e genitori |
| Tecnologia | Intelligenza artificiale · Sicurezza informatica · Auto e moto |
| Soldi e lavoro | Finanza e investimenti · Lavoro e carriera |
| Cultura e svago | Anime · Giochi · Arte e cultura · Scienza · Umorismo · Moda e stile · Foto e video · Sfondi |

### 4.6 I locali citati e il link a Google Maps (richiesta di Michele, §1.3)

Michele: una voce che dice «ecco i ristoranti nuovi da provare su Milano» deve dare **il luogo** (Milano) e anche **una sezione con i nomi dei ristoranti**, ognuno con **un link a Google Maps** («apri in gmap»).
- **Estrazione:** la chiamata dedicata «luoghi e locali» (una per voce, ~1 s, in coda, mai dentro l'analisi, risponde con uno JSON Schema) dà `place` (come §4.3) e `venues`: i **nomi propri** di locali che il post elenca (ristorante, pizzeria, bar, caffè, hotel, rifugio, cantina, negozio, altro), con la città se è diversa. **Controllo letterale:** il nome deve comparire nel testo della voce (dopo la pulizia); niente nomi generici («un ristorante», «il locale»); al massimo 20 per voce. Se il post dà solo il luogo e nessun nome, **non si inventa niente**: la voce ha il luogo e nessun locale.
- **La sezione «Locali»** sta sulla card (si apre sotto la voce) e sulla pagina della raccolta: l'elenco dei nomi, con il tipo e **«Apri in Maps»**. **Una cosa = una voce** (ADR-0017): lo stesso locale (nome pulito e città) citato in tre post è **una riga** con tre link ai post.
- **Il link lo costruisce il server** (regola P: il client non sa come si fa): `https://www.google.com/maps/search/?api=1&query=<nome>, <città>` (con la città se c'è), campo `mapsUrl` in ogni risposta. È solo un **indirizzo da aprire**: nessuna chiave, nessuna chiamata a Google dal server, niente esce finché Michele non lo tocca; sul telefono apre l'app di Google Maps se c'è. Per il solo luogo (Milano) lo stesso schema.
- **Niente mappa nostra:** la vista «Mappa» prevista nella proposta non serve più; c'è il link a Google Maps (le coordinate dei locali non servono: la ricerca di Maps trova il posto dal nome e dalla città).

## 5. Come si scoprono da sole (il ciclo)

1. **Una voce nuova** (dopo l'analisi, in coda, **mai** dentro l'analisi: se manca il router, aspetta e riprova; stesso schema di `softwareExtraction`) prende: un **vettore** (`nomic-embed-text`, riassunto + tag puliti dai segnaposto), e dalla chiamata dedicata il **luogo** e i **locali** (§4.3, §4.6). I tipi li ha già dall'estrazione.
2. **Assegnazione subito:** se il vettore sta entro la soglia dal centro di una raccolta attiva, la voce entra (al massimo 2 temi); questa corsia veloce **aggiunge, non toglie**.
3. **Ogni notte** (e dopo 25 voci nuove) si **ricalcolano i gruppi su tutte le voci** (1700 vettori: un secondo). Un gruppo nuovo **eredita id e nome** della raccolta vecchia con cui ha più membri in comune, se sono almeno **la metà dei membri della vecchia** (niente raccolte che «ballano»); gli altri gruppi sono raccolte nuove (o figli, §5.6). I **centri si muovono** e un membro può uscire (per esempio se una rianalisi cambia il suo vettore); `user_add` non esce mai, `user_remove` non rientra mai.
4. **Nascita e morte** (valori di partenza, da tarare nella fase 0): nasce a **5 voci** (Michele, Q3) e con coerenza sopra soglia; a 3–4 è «in osservazione» (non si vede, si legge in admin); **muore** sotto 3 (isteresi: non nasce e muore a ogni voce). Un gruppo troppo largo e incoerente (la «Varie» che non dice niente) **non si pubblica**. Un gruppo il cui centro è vicino (stessa soglia di fusione) al centro delle voci che **parlano di musica** (le 94 con canzoni dal contenuto) o delle voci con film **non è un tema**: è già «Musica» o «Film e serie». Per Software, Luoghi e Libri non si assorbe niente: sono menzioni, non argomenti.
5. **Il nome**, in ordine: (a) l'elenco di §4.5 (il modello sceglie, la pulizia ritrova il nome esatto); (b) un nome nuovo, accettato solo se ha 1–3 parole, solo lettere, **e una sua parola compare in almeno il 30 % delle voci** (contro le invenzioni), e non è «Post», «Contenuti», «Varie»; (c) il tag dominante se lo condivide ≥ 50 % delle voci; (d) altrimenti **non si pubblica** e si ritenta la notte dopo. Un nome cambiato da Michele **non si tocca mai più**.
6. **Si divide e si fonde:** una raccolta con ≥ 60 voci e sotto-gruppi di ≥ 8 si divide in figli; due raccolte con centri quasi uguali e stesso nome dopo la pulizia si fondono.
7. **Annuncio, sul sito** (Mondrop non mostra le raccolte, Q2): una raccolta nuova ha il segno «Nuova» per 7 giorni e una striscia «Nuove raccolte» nella Home e in cima alla pagina «Raccolte». **La prima corsa** pubblica le 12 più grandi e coerenti e mette il resto sotto «Altre raccolte», con **una sola striscia** («Ho trovato N raccolte»), non una per raccolta. Dove una voce appena salvata è finita lo dice l'esito di ritorno che esiste già («Salvato in: Ristoranti · Milano», ADR-0015).
8. **Correzioni che durano:** rinomina, unisci a un'altra, nascondi, «non è questo» su una voce, «aggiungi a…». Stanno in tabella a parte e **sopravvivono a ogni ricalcolo**: una raccolta nascosta resta nascosta, una voce tolta non rientra.
9. **«Perché è qui?»:** ogni raccolta dice le 3–4 parole che la definiscono e le due voci più centrali. Senza spiegazione l'automatico sembra magia sbagliata.
10. **Tutto locale** (`nomic-embed-text` e `glm-4.7-flash` via gpu-router): **mai Claude** (regola del progetto per questo lavoro), nessun dato esce. Interruttore `COLLECTIONS_AUTO=0` (ferma la scoperta, le raccolte esistenti restano). Ricalcolo a mano: `node dist/scripts/rebuildCollections.js --dry-run` (**anteprima per default**, `--apply` solo con l'OK di Michele).
11. **Costi:** vettori di tutta la libreria 12 s; una voce nuova ~7 ms; un nome ~1 s per gruppo; luoghi e locali ~1 s per voce, **una tantum ~30 minuti** in coda sulle 1700 voci già presenti (come il riempimento degli anni, mai insieme alle analisi).

## 6. Come si vedono e si scelgono (UX)

Tre proposte che sono **tre ingrandimenti degli stessi dati** (Michele, Q1: sì, A e B subito, poi C). Solo sul **sito**: Mondrop non mostra le raccolte (Q2: no). Disegni in `assets/`.

### 6.1 A. Il binario di chip in cima a «Link»

`Tutte 1696 · Musica 719 · Film e serie 256 · ✦ Vino 15 · Ristoranti 7 · Casa e design 10 · … · Altre ▾`. Un tocco filtra la lista lì (`?raccolta=<id>`, quindi il link si condivide e il tasto indietro funziona); due chip si **combinano** (tema + luogo = «Ristoranti a Milano», senza una raccolta scritta apposta). Scelto un tema compare una seconda riga di **faccette**: «Dove: Milano 5», «Fonte: IG 6 · TikTok 1», «Quando». Ordine: prima le nuove (✦), poi quelle con voci aggiunte negli ultimi 14 giorni, poi per grandezza. È il modo **meno invasivo**: la pagina che Michele già usa guadagna una riga.

### 6.2 B. La pagina «Raccolte» (voce nuova nel menu, tra Inbox e Link)

Una griglia di carte con **mosaico 2×2 di miniature** (il 96 % ha una miniatura), nome, numero di voci, ✦ per le nuove; **raggruppate per intestazione** («Cibo e bevande: Vino · Ristoranti · Ricette»); in cima la striscia «Nuove» (7 giorni) e un campo che filtra le raccolte; in fondo «Nascoste» (per recuperarle) e «In osservazione» (solo admin). È la strada per **sfogliare** e per scoprire cosa ha trovato il sistema.

### 6.3 C. Gli scaffali nella Home del sito (dopo A e B)

Come la Home di Mondrop (ADR-0020): il server manda **sezioni già pronte** (la striscia «Nuove raccolte» e 3–4 scaffali: nome, 6 voci più recenti come carte con miniatura, «Vedi tutto»); l'ordine lo decide il server (novità, voci aggiunte di recente). Nessun client calcola niente (regola P).

### 6.4 La pagina di una raccolta

Intestazione (nome, numero, ✦, menu ⋯: rinomina · unisci · nascondi), «Perché è qui?», faccette (Dove, Fonte, Quando), e **le viste che hanno senso** (le dice il server con `views` e `defaultView`, il client disegna solo quelle): **Griglia** (predefinita se ≥ 60 % delle voci ha miniatura: Sfondi, Ricette), **Lista** (testo del riassunto: Software, Film), **Suona** (la raccolta Musica: accoda nel player che c'è). Sotto, per le raccolte con locali, la sezione **«Locali»** (§4.6): i nomi, il tipo, **«Apri in Maps»**, i post che li citano.

### 6.5 La card

Miniatura, riassunto di una riga, **fonte + «Apri il post»** (regola ADR-0017), **chip di raccolta in testa** (al massimo 2 di tema più il luogo), poi i **tag veri** (quelli scritti dall'utente da Telegram e i più frequenti; **i segnaposto `#tag`, `@utente`, `#hashtag` non si mostrano più**; al massimo 4 chip in tutto). «×» su un chip di raccolta = «non è questo» (correzione che resta); «+» = aggiungi a un'altra raccolta. Il filtro per tag della pagina Link resta com'è. Se la voce ha dei locali, «Locali (N)» apre l'elenco con «Apri in Maps».

### 6.6 Ricerca, esito del salvataggio

- **Ricerca** («Cerca nella libreria…»): scrivere «vino» mostra in cima la raccolta **Vino** (come il primo risultato di Spotify) e sotto le voci.
- **Esito di ritorno** (ADR-0015, esiste già, testo): dopo il salvataggio dice dove è finita la voce, «Salvato in: Ristoranti · Milano». Su Mondrop è solo un testo nella Posta.

### 6.7 Mondrop

**Non mostra le raccolte** (Michele, Q2: no). Mostra le **playlist** che nascono dai post di musica e le sa cercare, ordinare e sfogliare (spec playlist). Se un giorno si cambia idea: sezione `collections` nella Home e pagina in sola lettura (regola P, un `kind` sconosciuto si ignora).

### 6.8 Cosa non si fa

Nessuna cartella da creare a mano, nessun gestore di tag, nessuna domanda a cui rispondere per vedere le cose. Le correzioni (§5.8) sono facoltative. Nessuna mappa nostra (c'è Google Maps).

## 7. Decisioni (con i default scelti: da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| C1 | **Il nome** | **«Raccolte»** (il «aggregazioni» di Michele; nel codice `collections`) |
| C2 | **Tre strati** | Tipi (calcolati) · Temi (scoperti, in tabella) · Luoghi e combinazioni (calcolati da `entry_places`), §4 |
| C3 | **Il set di base** | ~30 nomi italiani, §4.5 (**Michele: ok**); servono a dare nomi puliti, **mai una raccolta vuota** |
| C4 | **Soglia e tono** | Nasce **attiva a 5 voci** (**Michele: «5 voci»**), «Nuova» 7 giorni sul sito e striscia nella Home; mai una domanda |
| C5 | **Prima corsa** | Pubblica le 12 più grandi e coerenti, il resto sotto «Altre raccolte»; **una sola striscia** |
| C6 | **Correzioni** | Rinomina, unisci, nascondi, «non è questo», «aggiungi a…»; **durano** per sempre |
| C7 | **Gerarchia** | Intestazioni fisse del seme (non raccolte); raccolte a due livelli; il binario mostra ~12; l'intelligenza artificiale è un padre con figli |
| C8 | **Luoghi dal testo** | Il luogo **compare nel testo** della voce (controllo letterale) ed è nell'elenco dei luoghi; faccetta «Dove» a 2 voci, combinazione a 5, «Milano» sola a 8; mai dalla geocodifica delle note di oggi |
| C9 | **Locali e Maps** | Chiamata dedicata «luoghi e locali»; nomi propri che compaiono nel testo, ≤ 20; **«Apri in Maps»** con link costruito dal server (§4.6); niente mappa nostra |
| C10 | **Viste** | Le decide il server per raccolta (griglia, lista, suona) più la sezione «Locali»; il client disegna solo quelle |
| C11 | **Dove, in che ordine** | **Solo sito** (**Michele: Q1 sì, Q2 no**): binario A e pagina B prima, scaffali C poi; Mondrop non mostra le raccolte |
| C12 | **Per utente** | Le raccolte di ognuno sono sulle **sue** voci (proprie e condivise con lui); la famiglia ha le sue |
| C13 | **Tutto locale** | `nomic-embed-text` e `glm-4.7-flash` via gpu-router; mai Claude; niente esce; `COLLECTIONS_AUTO=0` |
| C14 | **Dati** | `entry_vectors`, `entry_places`, `entry_venues`, `collections` (solo temi), `collection_entries` (§8); le raccolte sono **derivate**: si ricostruiscono, tranne le correzioni |
| C15 | **Musica** | Ogni voce con almeno una canzone (porta verso il player); le 94 con canzoni dal contenuto alimentano le playlist; un gruppo musicale o di film non è un tema |
| C16 | **Appartenenza** | Al massimo 2 temi per voce più il padre; tipi e luoghi ortogonali; il ricalcolo notturno rifà i gruppi su **tutte** le voci con id ereditati per sovrapposizione |
| C17 | **Chip e tag** | Chip di raccolta in testa, tag veri dopo, segnaposto nascosti; il filtro per tag resta |
| C18 | **Numeri** | Dopo le playlist automatiche (2.20.0, spec playlist): le raccolte sono **2.21.0** (fase 1); nessun deploy né TestFlight senza il tuo OK, uno per volta |

## 8. Dati e contratto (bozza; ADR-0022)

**Migrazione** (anche in `init.sql`), solo SQL diretto, niente ORM:

- `entry_vectors(entry_id PK → entries ON DELETE CASCADE, model, vector REAL[], text_hash, embedded_at)`: il vettore si rifà solo se cambia il testo o il modello.
- `entry_places(entry_id, place, kind ('city'|'region'|'country'), PK(entry_id, place))`: nomi puliti, **senza coordinate** (il link a Maps parte dal nome).
- `entry_venues(entry_id, venue_key, name, kind, place, PK(entry_id, venue_key))`: `venue_key` = nome pulito + `|` + città pulita (identità: «una cosa = una voce», ADR-0017).
- `collections(id, owner_user, name, name_by ('auto'|'user'), group_label (dal seme, `null` = Altre), parent_id, state ('watching'|'active'|'hidden'|'merged'), origin ('seed'|'found'|'manual'), centroid REAL[], size, coherence, created_at, updated_at)`: **solo i temi** e i loro figli.
- `collection_entries(collection_id, entry_id, score, source ('auto'|'user_add'|'user_remove'), PK(collection_id, entry_id))`: `user_remove` **ricorda** una voce tolta.
- I **tipi** (`type:*`) e i **luoghi** (`place:*`) non hanno righe: l'API li calcola.

**Rotte** (sito, chiave utente come le altre; ognuna tocca solo le voci dell'utente):

- `GET /api/collections` → `{ collections: [{ id, name, kind ('type'|'theme'|'place'), group, parentId, count, isNew, thumbs: [≤4], views, defaultView }] }`, ordinate dal server.
- `GET /api/collections/:id?dove&fonte&q&offset&limit` → `{ collection, why, facets: { places, sources, months }, entries: [riga come in /api/entries + chip], venues: [{ key, name, kind, place, mapsUrl, posts: [{ entryId, sourceUrl, sourcePlatform, createdAt }] }], total }`.
- `POST /api/collections/:id/{rename,merge,hide,unhide}`; `POST|DELETE /api/collections/:id/entries/:entryId`.
- `GET /api/entries?view=summary` (righe) porta `collections: [{ id, name }]` per i chip della card; `GET /api/entries/:id` porta `places` e `venues` (con `mapsUrl`).
- Admin: `POST /api/admin/collections/rebuild?dry=1` (anteprima: raccolte, dimensioni, id dei membri; è da qui che si legge l'insieme d'oro).
- **`mapsUrl(nome, luogo)`** è una funzione pura del server: `https://www.google.com/maps/search/?api=1&query=` + `encodeURIComponent("nome, luogo")`.

**Lavori:** gancio dopo l'analisi (`onAnalysisFinished`: vettore, luogo e locali, in coda) e un lavoro notturno di consolidamento. Nessuno dei due può far fallire un'analisi o bloccare il worker.

## 9. Test e prova

- **Funzioni pure con vettori finti** (niente Ollama nei test, regola del progetto): nascita a 5 e non a 4; isteresi 3–4; id ereditati per sovrapposizione ≥ metà; una correzione (nascondi, rinomina, «non è questo») **sopravvive al ricalcolo**; un gruppo incoerente non si pubblica; un gruppo vicino al centro musicale o dei film non è un tema; al massimo 2 temi per voce; divisione in figli; fusione; una raccolta vuota non esiste.
- **Il nome:** pulizia (`#@"*`, `Intelligenza_artificiale` → «Intelligenza artificiale»), invenzioni scartate, il tag dominante come ripiego, JSON rotto → nessun nome.
- **Il luogo:** il luogo **non nel testo** si scarta («Montagne de Reims»); varianti («Milan», «#Milano») → «Milano»; fuori elenco scartato; faccetta a 2, combinazione a 5, «Milano» sola a 8.
- **I locali:** un nome che non compare nel testo si scarta; nomi generici scartati; ≤ 20; lo stesso locale in due post è **una riga con due link**; **`mapsUrl`**: codifica di accenti, `&`, apostrofi, senza città.
- **Rotte** con dipendenze iniettate (come `HomeDeps`): utente isolato, ordine deciso dal server, `views` e `defaultView`, chip nelle righe, `venues` con `mapsUrl`.
- **Sito:** il binario filtra e combina, «Nuova» sparisce dopo 7 giorni, un `kind` sconosciuto non rompe, i tag segnaposto non si mostrano e quelli veri sì, «Apri in Maps» apre l'indirizzo del server; un test come `ruleP.test.ts` che vieta al client di calcolare raccolte o di costruire indirizzi di Maps.
- **Rotture provate** con il banco delle mutazioni (una modifica alla volta: soglia 5→4, isteresi, id ereditati, persistenza delle correzioni, controllo letterale del luogo), come per i testi.
- **L'insieme d'oro, in lettura** dall'anteprima del ricalcolo contro la produzione (come `postdeploy_check.py`): «Vino» ≥ 12 voci, un tema Ristoranti con luogo «Milano» ≥ 5, «Casa e design» ≥ 8; **nessun tema pubblicato è in maggioranza «Musica» o «Film e serie»**; nessun nome con `#@"*`; nessun luogo che non compaia nel testo.

## 10. Fasi (ognuna con il suo OK di deploy)

0. **Calibrazione** (parte del piano, in sola lettura): rifare la prova di §3.1 dentro il codice e fissare le costanti (soglia dei gruppi, di fusione, di coerenza, di assorbimento) sull'insieme d'oro.
1. **SoundReel 2.21.0, server e sito:** vettori, luoghi e locali (con la corsa una tantum), raccolte e correzioni, rotte, binario A, pagina B, chip sulle card, sezione «Locali» con «Apri in Maps».
2. **Scaffali (C) nella Home del sito, ricerca, esito «Salvato in…»** (anche nella risposta di Telegram).
3. Mondrop: **nessun lavoro per le raccolte** (Q2); le playlist sono nella loro spec.

## 11. Rischi e limiti

- **Nomi, luoghi e locali del modello sono instabili** (§3): per questo l'elenco, la pulizia, il controllo letterale nel testo, lo scarto e la ritentata; e la correzione manuale che vince.
- **I gruppi possono «ballare»** quando arrivano voci nuove: id ereditati per sovrapposizione, isteresi, e i nomi cambiati a mano non si toccano.
- **Una metà della libreria è un solo tema:** senza gerarchia il binario sarebbe tutto «intelligenza artificiale».
- **La soglia dei vettori dipende dal modello:** calibrata sui dati veri (centrati sulla media; senza centrarli tutto sembra simile). Se si cambia modello si ricalibra e si rifanno i vettori (`model` è in tabella).
- **Una voce con poco testo** (55 su 1698 non ne hanno abbastanza, tra riassunto, didascalia e tag, per un vettore) resta senza raccolte di tema; ha comunque i tipi.
- **I locali dipendono da quanto il post li dice:** un reel che mostra posti senza nominarli non dà nomi (non si inventano); un reel con nomi scritti nell'immagine dipende dall'OCR.
- **Fuori ambito:** condividere una raccolta con un altro utente, raccolte fatte a mano da zero, riordino a mano, esportazioni, raccolte per autore del post, la mappa interna, le raccolte su Mondrop.

## 12. Cosa è deciso e le scelte mie da controllare

**Deciso da Michele (10 novembre):** UX A e B poi C (Q1 sì); niente raccolte su Mondrop (Q2 no); nascita a 5 voci, attive da sole (Q3); l'elenco di §4.5 (Q4 ok); il luogo dal testo con i nomi dei locali e il link a Google Maps (§4.6); le playlist dai post di musica (spec a parte).

**Scelte mie** (dalla lettura di un revisore esterno della spec, 10 novembre; correggi se non vanno):
1. **«Musica» è ogni voce con una canzone** (719), anche solo di sottofondo, perché è la porta verso il player; i reel con canzoni dal contenuto (94) alimentano le playlist. Il gruppo musicale o di film trovato dai vettori **non è un tema** (§4.1, §5.4).
2. **Il ricalcolo notturno rifà i gruppi su tutte le voci**, con id ereditati per sovrapposizione (≥ metà della vecchia), centri che si muovono, `user_add` che non esce e `user_remove` che non rientra (§5.3).
3. **Appartenenza:** al massimo 2 temi per voce più il padre; tipi e luoghi ortogonali (§4.4).
4. **Salvate in tabella solo le raccolte-tema.** Tipi e luoghi si calcolano; le combinazioni sono tema × luogo, senza ciclo di vita; le **intestazioni** («Cibo e bevande»…) sono etichette fisse, non raccolte (§4.4, §8).
5. **Luogo:** controllo letterale nel testo, faccetta a 2 voci, combinazione a 5, «Milano» sola a 8; **senza coordinate** (§4.3).
6. **Locali:** una chiamata dedicata, nomi che compaiono nel testo, una riga per locale anche se citato in più post, link costruito dal server (§4.6). **Niente mappa nostra.**
7. **Chip e tag:** i chip vanno in testa, i tag veri restano, i segnaposto spariscono (§6.5).
8. **Parametri della prova** scritti qui (§3.1); gli script non entrano nel repository; la fase 0 rifà la calibrazione.
9. **Ordine di costruzione:** prima le playlist automatiche (2.20.0, più piccole e servono a chi ha molte playlist), poi le raccolte (2.21.0). Si inverte con una parola.
