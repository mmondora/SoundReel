# Niente duplicati, e il link al post su ogni card (richiesta 2026-11-08)

- **Data:** 2026-11-08
- **Stato:** **Costruito, non ancora distribuito** (SoundReel 2.11.0, aspetta l'OK di Michele al deploy). Le decisioni D1–D4 e D6 sono costruite con i default sotto; **D5 (le versioni delle canzoni) è deciso da Michele («Versione di») e si costruisce dopo**; la **fusione delle 9 entry doppie** è uno script pronto e provato (sezione 6): Michele ha dato l'OK a lanciarla dopo il deploy. Identità delle entry e dei media toccano i dati (**ADR-0017**).
- **Owner:** Michele
- **Correlati:** `adr/0017-one-identity-per-thing-and-cards-link-back-to-the-post.md`, `docs/superpowers/specs/2026-11-07-multi-user-authelia-design.md` (le entry sono private per utente), ADR-0011 (la chiave normalizzata `normKey`)

## 1. Richiesta di Michele (testuale)

> «le entry in soundreel non devono essere duplicate, così come le canzoni ( al massimo si mette un link all'originale ), i software, i film ecc.
>
> Nelle card dei media trovati, compreso al software, voglio anche il link al post. Es 5 canzoni sono state estratte dallo stesso link.»

**Come la leggo (da confermare):** ogni cosa (un post, una canzone, un software, un film, una nota) esiste **una volta sola**; se la stessa cosa viene trovata di nuovo, non nasce un doppione: al massimo si aggiunge un riferimento all'originale (un'altra menzione, un altro link al post). Su **ogni card** di un media trovato (canzone, film, software, nota) si vede il **link al post** da cui è stato estratto (il link originale, Instagram, TikTok, YouTube…): se 5 canzoni vengono dallo stesso post, le 5 card portano lo stesso link.

## 2. Com'è oggi (misurato l'8 novembre sul journal reale, sola lettura)

- **Entry:** 1.700. **9 gruppi doppi, 9 entry in più, tutte Instagram** (8 `completed` + `completed`, 1 story in errore): la stessa reel salvata con forme d'URL diverse (`?utm_source=…`, `?igsh=…`, `?img_index=3`), create prima che il normalizzatore e il controllo per shortcode ci fossero. Nessun doppione su altre piattaforme, nessun post uguale fra utenti diversi (i journal sono privati). Il controllo di oggi (`findEntryByUrl`: URL pulito, poi shortcode) previene i nuovi, ma **non è atomico**: due condivisioni nello stesso istante possono passare entrambe.
- **Canzoni:** 785 chiavi normalizzate; **8 esistono sotto più grafie** (versioni: `(instrumental)`, `(slowed & reverb)`, `(over slowed)`, `(feat. …)`); 93 canzoni vengono da più di un post e sono già **una sola card «×N menzioni»**.
- **Film:** 627 titoli normalizzati, **14 sotto più grafie o anni** (la chiave `filmKey` distingue «Dune» da «Dune (2021)»).
- **Software:** 206 card, **7 nomi mostrati più volte (10 card in più)**: lo stesso prodotto con URL diversi (pagina ufficiale, repo giusto, repo inventato dal modello, lo stesso repo con `#readme`), con tag diversi (`repo`/`product`) e con **URL segnaposto** (`https://github.com/...`, `…/your-ecc-repo-link`). Esempio: «Claude Code» in 4 card.
- **Le card:** canzoni, film e note linkano alla **entry del journal** (`/?entry=<id>`, «×N menzioni»); la card software mostra solo il numero. **Nessuna porta il link al post originale** (`sourceUrl`), e una menzione oggi è solo `{ entryId, createdAt }`.

## 3. Decisioni prese con valori di default (da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| D1 | **Una cosa = una card** | L'identità è il nome normalizzato (minuscole, accenti e punteggiatura ignorati). **Software:** stesso nome = una card, qualunque tag o URL. **Film:** stesso titolo normalizzato con anno uguale **o mancante** su uno dei due = una card. **Canzoni:** **restano come sono**: una canzone ha una sola chiave (`songKey`, artista e titolo normalizzati) e una sola card con tutte le sue menzioni (93 canzoni vengono già da più post in una card sola). **Non si cambia la loro identità** (decisione presa costruendo): quella chiave è anche la chiave di playlist, `song_files` e `song_meta`, e fonderne due alla lettura farebbe sparire una voce che una playlist o un file ha per nome. Le 8 canzoni sotto più grafie (`(instrumental)`, `(slowed & reverb)`, `(feat. …)`) restano quindi card separate finché Michele non decide D5. Per software e film si fa **alla lettura** (nessuna migrazione dei dati): le voci originali restano nelle entry |
| D2 | **Entry uniche** | Una entry per utente e per post. La creazione diventa **atomica** (un blocco per chiave del post: due condivisioni insieme non fanno due entry). Le **9 entry doppie** si fondono con uno script una tantum (`--dry-run`, copia di sicurezza, un OK di Michele prima di lanciarlo): resta la più vecchia con dati, si uniscono canzoni, film, note, software, tag, link, condivisioni e registro azioni, e si cancella il doppione (come è costruito: sezione 6) |
| D3 | **Il link al post sulle card** | Ogni menzione porta anche `sourceUrl` e `sourcePlatform`. Le card di **canzoni, film, software e note** mostrano «Dal post» con un link per menzione (fino a 3, poi «+N»), che apre il **post originale** in una nuova scheda; il «×N menzioni» continua a portare alla entry nel journal. Cinque canzoni dello stesso post hanno lo stesso link |
| D4 | **Software: un solo link principale** | Il link principale è, in ordine, un **repository verificato** (GitHub, GitLab, Codeberg), il sito ufficiale, un altro; gli altri URL restano come «Altri link». Gli **URL segnaposto** (`…/...`, `your-…`, `example`, `<…>`) si scartano; i tag si fondono (`repo` se c'è un repo) |
| D5 | **Versioni delle canzoni** *(confermato da Michele l'8 novembre: «Versione di»; si costruisce dopo la 2.11.0, sezione 7)* | Instrumental, slowed / sped up, live, remix, acoustic, cover, karaoke sono **audio diversi**: restano card separate ma portano **«Versione di <originale>»** con il link alla canzone originale. `feat.`, `Official Video`, `Lyrics`, `Remastered` sono la stessa canzone (D1) |
| D6 | **Niente si cancella dai file** | La fusione riguarda le schede e le voci del journal, mai gli MP3, le playlist o la libreria |

## 4. Test

- Aggregatori (`aggregateSongs`, film, note, software): ogni menzione ha `sourceUrl` e `sourcePlatform`; la stessa cosa da più post = una card con tutte le menzioni.
- Software: stesso nome con URL, tag e grafie diversi = una card; URL segnaposto scartati; link principale per ordine di preferenza; `#readme` e barra finale non creano un doppione.
- Film: «Dune» e «Dune (2021)» = una card; anni diversi restano film diversi.
- Entry: due creazioni simultanee dello stesso post = una entry; lo script di fusione in `--dry-run` non cambia niente e, per davvero, unisce i dati e non perde né canzoni né note né condivisioni (anche su Postgres vero).
- Frontend: le card mostrano il link al post (nuova scheda, `rel` sicuro), «+N» oltre tre, nessun link quando manca `sourceUrl`.
- **Fatto (8 novembre):** aggregatori, collasso di software (30 casi) e film, blocco per post (due condivisioni insieme = una entry), `PostLinks` sulle quattro card e lo script di fusione hanno i loro test (`softwareCollapse`, `filmCollapse`, `mentions`, `aggregators.mentions`, `entryKeyLock`, `linkIngest`, `PostLinks`, `postLinks`, `mergeDuplicateEntries`: 35 casi). Lo script è stato provato anche **su un Postgres vero di prova** (51 controlli: l'anteprima non cambia niente, l'applicazione tiene ogni condivisione, job, avviso, intenzione, richiesta Spooty e riga di log, un gruppo con un job in corso è saltato, la copia di sicurezza è in `0600`, una seconda passata non fa danni) e in **anteprima sul journal reale**.

## 5. Domande aperte per Michele — le sue risposte (8 novembre)

Risposta testuale di Michele all'elenco di cinque domande (deploy, fusione, D5, link, riempimento software): «1 si, e commit 2 si 3 si ( Versione di ) 4 accanto a xN 5 si, se serve usi vulcano»

1. **Deploy della 2.11.0: sì, e commit** (commit e push dopo il deploy, come nella sua regola).
2. **Fusione delle 9 entry doppie: sì**, dopo il deploy, con l'anteprima e la copia di sicurezza (sezione 6).
3. **D5, le versioni delle canzoni: sì, «Versione di …».** Instrumental, slowed, sped up, live, remix, acoustic, cover, karaoke restano **card separate** che portano **«Versione di <originale>»** con il link alla canzone originale (non righe dentro la card originale). Non è nella 2.11.0: è la release successiva, e vale la regola «nessun deploy senza un OK nuovo». Come si costruisce: sezione 7.
4. **Il link al post sta accanto a «×N menzioni»** (com'è costruito), non al posto del link alla entry del journal.
5. **Riempimento dei software citati (`backfillSoftware`): sì.** «Se serve usi vulcano»: il lavoro del modello passa già dal gpu-router, che preferisce vulcano (poi archi-PC, poi GEEKOM); i dati non escono dal journal e il lavoro è tutto locale.

## 6. La fusione delle entry doppie, com'è costruita (`backend/src/scripts/mergeDuplicateEntries.ts`)

**Cosa vedrebbe Michele (anteprima sul journal reale, 8 novembre, nessuna modifica):** 9 gruppi, 9 entry in più. Otto sono coppie `completed` della stessa reel con forme d'URL diverse; una è una story Instagram, entrambe in `error`, senza niente dentro (`stories/spiritmoderna/3885815053622458244`). In ogni gruppo la tenuta ha già la miniatura e le slide sono tante quante quelle del doppione: **nessun avviso di file persi**. I doppioni portano 0–3 job (tutti `done` o `failed`, nessuno in coda né in corso) e fino a 45 righe di log, nessuna condivisione, avviso, intenzione o richiesta Spooty.

**Regole (decise costruendo, nel solco di D2):**
- **Chi resta:** la entry **più vecchia che ha dati** (canzoni, film, note, software, un riassunto o una trascrizione); se nessuna ha dati, la più vecchia completata; altrimenti la più vecchia. Perché la più vecchia: il suo id è quello che un messaggio di Telegram, una condivisione o un segnalibro hanno più probabilità di avere già in mano. Il gruppo è «stesso utente + stesso post» (`postKey`): mai fra utenti diversi.
- **Cosa si unisce:** canzoni, film, note, software, link e tag (`mergeEntryResults`, additivo); se la stessa canzone, lo stesso film o lo stesso software ci sono in entrambe, la copia della tenuta si **completa** con quello che sapeva solo l'altra (un link Spotify, un poster, `addedToPlaylist: true`, la fonte «both»), **senza sovrascrivere niente** di ciò che la tenuta ha. Riassunto, trascrizione e arricchimenti della tenuta restano; quelli dell'altra riempiono solo un vuoto. I due registri azioni si uniscono in ordine di tempo, con una riga `merged_duplicate` per ogni entry che se ne va.
- **Cosa si sposta sulla tenuta:** condivisioni (`entry_shares`, senza toccare quelle già presenti), job (**tutti, anche uno in coda**: è lavoro sullo stesso post e l'analisi è additiva, una seconda esecuzione non fa danni, un nuovo tentativo perso sì), avvisi della posta (un solo «ti hanno condiviso…» per utente e entry), intenzioni di condivisione (se tutte e due hanno una intenzione aperta per lo stesso mittente vince quella della tenuta, indice unico), la richiesta Spooty (una per entry: se la tenuta ne ha già una, quella del doppione se ne va con l'entry) e le righe di log. Sono le sole tabelle che puntano a una entry; `job_queue` non ha la cascata, quindi va spostata **prima** della cancellazione.
- **Cosa non si tocca mai (D6):** MP3, playlist, libreria, `song_meta`, `song_files`. **I file della cartella del doppione** (`/media/<id>/`: miniatura, immagini delle slide) **non si copiano**: la pulizia delle cartelle orfane li toglie dopo 7 giorni, quindi una tenuta senza miniatura o senza immagini delle slide ne resta senza, e le slide prese dall'altra perdono il link all'immagine (testo OCR e riassunto restano). L'anteprima lo scrive in una riga `ATTENZIONE` per ogni gruppo dove succede.

**Come gira:**
- **Anteprima per default** (`--dry-run` è accettato e vince su `--apply`); `--apply` scrive. Dentro il container: `node dist/scripts/mergeDuplicateEntries.js [--apply] [--backup /tmp/file.jsonl]`.
- **Copia di sicurezza prima di tutto:** una riga JSON per ogni entry coinvolta e per ogni riga che la riguarda (condivisioni, job, avvisi, intenzioni, richieste Spooty, log), file `0600`. Di default in `/tmp` **dentro il container**, **non** sotto `/data/media`: quella cartella è servita via HTTP su `/media` e ogni sottocartella che non è l'id di una entry viene cancellata dopo 7 giorni. Va **copiata fuori dal container** appena finito (`docker cp`).
- **Una transazione per gruppo:** le righe si bloccano e si **rileggono dentro la transazione** (il lotto di ri-analisi in corso scrive sulle entry), il piano si rifà sulle righe fresche; **un gruppo con un job in corso si salta**, non si forza (un solo gruppo saltato non ferma gli altri); un errore su un gruppo fa `ROLLBACK` di quel gruppo e il resto continua; uscita non zero se c'è stato un errore.
- Rilanciarlo è sicuro: dopo la fusione non restano gruppi da unire.

## 7. D5 — «Versione di …» (deciso da Michele l'8 novembre; si costruisce dopo la 2.11.0)

**Richiesta (sua risposta):** le versioni delle canzoni restano card separate con **«Versione di <originale>»** e il link alla canzone originale; il link al post sta accanto a «×N menzioni».

**Dati reali (journal, 8 novembre, sola lettura):** 795 coppie titolo/artista distinte, 153 con una parentesi, un trattino o «feat.». Sono versioni vere: `(Instrumental)`, `(Slowed)`, `(Slowed + Reverb)`, `(Ultra / Super / Over Slowed)`, `(Instrumental Slowed)`, `(Remix)`, `(… Mix)`, `(Edit)`, `- Live`, `(Piano Version)`, `(Orchestral Version)`, `(Epic Version)`, `(Lunar Lo-Fi Version)`, `(Speed)`. Sono rimasterizzazioni o crediti: `(2008 Remaster)`, `(Remastered)`, `(feat. Pusha T)`, `(with Gordon Tracks)`. **Non sono versioni, fanno parte del titolo:** `(It Goes Like) Nanana`, `(Interlude)`, `(Nature Sounds)`, `(From "Spirited Away")`, `(Main Title Theme)`, `(Magic Feeling)`, `(Gangster Trap)`, `(Imagine That)`, `(I Love)`, `(Deluxe Edition)`. Le re-caricazioni «slowed» hanno spesso un altro artista (chi le ha pubblicate), e a volte nessuno («undefined»).

**Regole (default scelti, da correggere se non vanno):**
- **V1 · Riconoscimento prudente.** Un gruppo fra parentesi tonde o quadre, o un suffisso dopo « - », è una **versione** solo se **tutte** le sue parole stanno nel vocabolario delle versioni (slowed, sped up, speed, reverb, instrumental, karaoke, live, remix, mix, edit, acoustic, unplugged, cover, piano, orchestral, epic, lo-fi, nightcore, 8d, bass boosted, version, ultra, super, over, special, pitched…) più numeri, anni e connettori (`+`, `&`, `and`, `to`); altrimenti resta nel titolo. **Crediti** (`feat.`, `ft.`, `with …`) e **rimasterizzazioni** (`Remaster`, `Remastered 2011`) sono *decorazioni*: lo stesso brano scritto in un altro modo, non un audio diverso.
- **V2 · L'originale** è la card che ha il titolo di base (senza versioni né decorazioni) e almeno un artista in comune (confronto per parole; un artista mancante o «undefined» non esclude: basta il titolo se l'originale è uno solo). Se **non c'è** una card dell'originale: con una versione vera (strumentale, slowed, live, remix…) l'etichetta compare lo stesso, **senza link**; con le sole decorazioni (crediti, rimasterizzazione) non compare niente.
- **V3 · Dato.** `versionOf?: { title, artist, songKey | null, kinds[] }` su ogni canzone aggregata, calcolato **alla lettura** in `aggregateSongs` (nessuna migrazione). **La `songKey` non cambia**: playlist, `song_files` e `song_meta` restano intatti.
- **V4 · La card** mostra «Versione di «Titolo»» (con il link all'originale quando c'è: apre la pagina Canzoni filtrata su quel titolo) più i tipi riconosciuti («slowed + reverb», «strumentale»…), accanto a «×N menzioni» e al link «Dal post».
- **V5 · Test.** Una tabella con i titoli reali sopra (versioni, decorazioni, e i negativi che restano titolo), il collegamento con originale presente, assente, con artista diverso o mancante, e due originali possibili (nessun link se è ambiguo); la card con e senza `versionOf`.

