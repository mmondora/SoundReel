# I testi delle canzoni, cercati su Internet quando mancano (richiesta 2026-11-08)

Stato: SoundReel **2.19.0** (la rotta e la ricerca) **in produzione dall'8 novembre, 20:13**; Mondrop **1.7.0 build 10** (l'app) **su TestFlight dalle 20:17**. Una rotta nuova e un'origine dati nuova sono architettura: **ADR-0021**.
Codice: backend `services/lyricsFinder.ts`, `services/songLyrics.ts`, `db/migrations/020_song_lyrics.sql`, `routes/mondrop.ts` (`GET /api/mondrop/songs/:key/lyrics`); app `ios/MondropKit/LyricsLoader.swift`, `LocalAudioPlayer.swift`, `ios/Mondrop/WinampPlayerView.swift`.

## 1. Richieste di Michele (testuali)

Con la copertina (spec `2026-11-08-player-cover-art-design.md`):

> «Nel player iOS voglio avere la copertina del disco o della canzone se non c'è trovale su Internet, come le parole.»

La frase si poteva leggere in due modi; la lettura (b) era: quando un brano non ha testo, il server lo cerca su Internet. Risposta di Michele (8 novembre):

> «Sì, cercale su Internet»

## 2. Com'era

«Le parole» di un brano erano **la trascrizione del post** (quello che Whisper sente nel video, che può essere parlato e non cantato) oppure un testo **incollato a mano** sul telefono. Un brano senza né l'una né l'altro non aveva niente. In più le liste (Cerca, Libreria, Home) **non portano i testi** (sono pesanti): un brano suonato da lì non mostrava le parole nemmeno quando la trascrizione esisteva.

## 3. Decisioni (con i default scelti: da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| L1 | **Da dove vengono, in ordine** | 1. quello che l'utente ha **scritto o incollato** sul telefono (vince sempre); 2. quello che il **server ha già** (la trascrizione del post, come oggi); 3. **Internet**, solo quando i due mancano. Internet **non sostituisce mai** un testo che esiste («quando mancano»). Se vuoi i testi veri al posto delle trascrizioni dei post è una riga |
| L2 | **Li trova il server, l'app chiede a SoundReel** (regola P) | `GET /api/mondrop/songs/:key/lyrics`: l'app non parla mai con un archivio di testi. Vale per ogni brano che l'utente può suonare, anche solo-file |
| L3 | **Dove si cerca** | **LRCLIB** (archivio libero di testi, nessuna chiave, `lrclib.net/api/search`), con uno User-Agent che dice chi siamo. Escono solo **autore e titolo**, niente sull'utente |
| L4 | **Solo con un riscontro forte** | Il titolo (senza i segni tra parentesi o dopo un trattino: «(feat. X)», «(Remastered 2011)», «- Radio Edit») e un autore accreditato devono essere **gli stessi** (maiuscole, accenti e punteggiatura a parte). Senza autore non si cerca. **Meglio nessun testo che le parole di un'altra canzone** |
| L5 | **Le versioni** | Un brano che è una versione (Speed, Slowed + Reverb, Remix, Live…) e non ha un testo suo ripiega sul testo dell'**originale** (`versionOf`), tranne le versioni **Instrumental / Karaoke** |
| L6 | **Strumentali** | Se l'archivio dice che il brano è strumentale: risposta `200` con `instrumental: true` e niente testo; l'app dice «Brano strumentale» invece di «Nessun testo» |
| L7 | **Trovato una volta, tenuto** | Tabella `song_lyrics`: un testo trovato resta; «non c'è» si ricorda **7 giorni**; un guasto dell'archivio **non** si ricorda (non è una risposta). Due richieste per lo stesso brano condividono una ricerca; le richieste a LRCLIB sono distanziate (almeno 1 secondo) |
| L8 | **L'app** | Quando parte un brano senza testo lo chiede a SoundReel (una volta; il testo si tiene sul telefono, quindi c'è anche offline; «nessun testo» si ricorda 1 giorno). Il foglio «Parole» dice **da dove viene** («Testo trovato su Internet», «Trascrizione del post», «Scritto da te»). **Modifica** funziona come prima e vince su tutto |
| L9 | **Privacy e diritti** | I testi sono protetti da diritto d'autore: si tengono per l'uso privato della famiglia, non si pubblicano da nessuna parte e non escono dal server e dai telefoni. Un interruttore `LYRICS_ONLINE=0` spegne la ricerca su Internet senza rilasciare niente |
| L10 | **Fuori da questa release** | I testi **sincronizzati** (karaoke: LRCLIB li ha), il player web (non ha «parole»), la traduzione, altri archivi |
| L11 | **Numeri** | SoundReel **2.19.0**; Mondrop **1.7.0 build 10** |

## 4. Il contratto

`GET /api/mondrop/songs/:songKey/lyrics` (chiave `X-SoundReel-Key`, sola lettura):
- `200 { "songKey": "…", "lyrics": "testo…", "source": "transcript" | "internet", "instrumental": false }`
- `200 { …, "lyrics": "", "source": "internet", "instrumental": true }` per un brano strumentale
- `404 { "error": "song not found" }` se nessuno conosce il brano; `404 { "error": "no lyrics" }` se non c'è niente; `500 { "error": "lyrics failed" }`
- `Cache-Control: private, max-age=86400`. Nessun campo nomina un negozio o un indirizzo.

## 5. Test

- **Server:** il riscontro (titolo con e senza segni, autore con più nomi, accenti, un'altra canzone con lo stesso titolo, titolo contenuto in un altro, nessun autore), la scelta tra i risultati, gli strumentali, le versioni (ripiego sull'originale, non per Instrumental), la tabella (trovato resta, «non c'è» 7 giorni, guasto non ricordato), una ricerca per volta per brano, la distanza tra le richieste, l'interruttore, la rotta (404 diversi, 401, trascrizione prima di Internet). Rete finta: nessuna chiamata vera nei test.
- **App:** decodifica, 404 = nessun testo (ricordato), il testo tenuto sul telefono, il percorso mai assoluto, il brano che parte senza testo lo chiede e lo mostra, un brano cambiato nel frattempo non prende il testo dell'altro, la scelta dell'origine.

## 6. Domande per Michele e risposte (8 novembre)

1. **Le parole su Internet?** Risposta: **«Sì, cercale su Internet»**.
2. **Da correggere se non va (default scelti):** i testi di Internet **non** sostituiscono le trascrizioni dei post (L1); il ripiego sull'originale per le versioni (L5); «non c'è» ricordato 7 giorni (L7).
3. **Visto in produzione (8 novembre, dopo il deploy delle 20:13; domanda aperta):** «The Winner Takes It All» (ABBA, 1581 caratteri, 75 righe) e «Heart of Glass» (Blondie, 1170 caratteri, 41 righe) sono arrivati da Internet in 0,9 s; «Clocks», «Dreams» e «Lose Yourself» hanno servito la trascrizione del post, come da L1. Ma **una trascrizione cortissima batte i testi veri**: «Clocks» ne ha una di **33 caratteri**, e **67 entry** con canzoni ne hanno una di 21–100 caratteri (frammenti di ciò che Whisper ha sentito in un reel; sotto i 20 non si serve già oggi). Per loro Internet non si chiede mai. Proposta, **non fatta** (è la regola L1): sotto una soglia (100 caratteri?) la trascrizione conta come «testo che manca», si cerca su Internet e, se non si trova niente, resta la trascrizione. Da decidere con Michele.
