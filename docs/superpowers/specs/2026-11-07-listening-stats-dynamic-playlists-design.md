# Statistiche di ascolto, spazio su iPhone, playlist dinamiche, log di attività — design

- **Data:** 2026-11-07
- **Stato:** In implementazione (versione 2.8.0). Nessun deploy senza OK di Michele
- **Owner:** Michele
- **Correlati:** `docs/mondrop-stats.md` (contratto client), `docs/mondrop-sync.md`, ADR-0006

## 0. Richieste di Michele (testuali, in ordine)

1. «nel log voglio vedere le richieste di download e di sync delle device, oltre che la creazione di playlist (chi, quando) e l'associazione di canzoni alla playlist»
2. «su mondrop ios voglio anche le statistiche dei play fatti, che devono essere memorizzati (di tanto in tanto) con soundreel — le statistiche mi servono poi per le statistiche di ascolto di cui voglio una dashboard (globale) dal web»
3. «voglio anche poter, su ios, cancellare delle canzoni per risparmiare spazio, con l'opzione di eliminare quelle meno ascoltate — l'eliminazione di un blocco prevede una doppia conferma e comunque un log dettagliato sul server»
4. «voglio anche le playlist dinamiche, es: quelle più ascoltate la notte, al mattino dalle 7 alle 8 ecc.»
5. (chiarimento) «tipo è il tipo di musica (rock, jazz, trap ecc)» → nel Playlist manager «Tipo» = genere (già corretto).
6. «nel player web voglio vedere se una canzone è locale oppure no (e se è su FS, o su media server) e inoltre voglio che la lista delle canzoni scrolli (oppure tolga in alto quelle già ascoltate) — questo solo se la playlist è superiore a 20 canzoni, che diventa il limite di quelle mostrate. Quella in alto è sempre quella in play. Salva queste info, e quelle di prima fra le specifiche.»

7. «sul player web se c'è il video lo voglio al posto della foto, nello stesso spazio - se invece è in streaming locale, si deve mostrare la copertina/foto dell'album. salva le spec, e salva la regola di generare spec e adr quando ti do regole nuove.» → regola W4 in `2026-11-07-web-player-ux-design.md`; la regola di processo è in `CLAUDE.md` («Regole di lavoro») e nella memoria.

8. Regole successive sul **player web e sulla posizione dei brani** (nessuna copia dal media server, switch Auto/Internet/Media server secondo la rete, percorso/URL nel Playlist manager, pallino verde = disco o media server): testuali in `2026-11-07-web-player-ux-design.md` §1 (richieste 5–8); decisioni S1–S8, regole W1–W8; ADR-0010.
9. **Ricerca nella libreria** su libreria, media server e cartelle musica configurabili («Maestro Bassi… non so dove sono»): `2026-11-07-library-search-music-folders-design.md`; ADR-0011.
10. **Import della musica del Mac** sul media server con un prompt per il Claude Code del Mac: `2026-11-07-mac-music-import-design.md`; ADR-0012.

> Le regole del **player web** (primo play, badge FS/MS, finestra di 20, video o copertina, sorgente) stanno tutte in `2026-11-07-web-player-ux-design.md`.

> Le richieste precedenti di questa sessione sono già nelle specifiche: archivio MP3, primo play, Playlist manager «Norton Commander» e playlist condivise in `2026-11-07-mp3-store-media-server-design.md` §0/§2.9 e in `docs/mondrop-sync.md`; Shazam in §2.8 della stessa spec; link Spotify/Shazam nel `CLAUDE.md`.

## 1. Decisioni prese con valori di default (da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| D1 | Cosa è un «ascolto» | Il client manda fatti grezzi (ms ascoltati, durata); **conta** se `listenedMs ≥ min(30 s, 50 % della durata)`, il resto sono salti. La soglia vive sul server: si cambia senza aggiornare l'app |
| D2 | Quando l'app spedisce | Coda locale su file; a lotti da 20, in background, all'avvio, ogni 15 min in foreground; idempotente per id evento; nessuna perdita offline |
| D3 | Ascolti dal web | Sì, anche il player web registra (`origin: web`): la dashboard è «globale» su tutti i modi di ascoltare |
| D4 | Chi vede la dashboard | Admin: tutti gli utenti e dispositivi + filtri; gli altri utenti solo i propri numeri |
| D5 | Fasce orarie | Ora **locale dell'ascolto** (offset del telefono salvato nell'evento), non l'ora del server |
| D6 | Playlist dinamiche | Regola parametrica (fascia oraria, giorni, periodo, genere, ordine, limite, scope me/famiglia), ricalcolata a ogni richiesta (quindi a ogni Sync); preset pronti; sola lettura per i brani |
| D7 | Cancellazione su iPhone | Singola: una conferma. **Blocco** (selezione multipla, «meno ascoltate», «libera spazio»): **doppia conferma**. Sempre un evento al server con l'elenco completo; coda offline |
| D8 | Dopo una cancellazione | Il Sync **non** riscarica quel brano su quel telefono finché non si chiede «Riscarica» |
| D9 | «Meno ascoltate» | Ordinate per ascolti contati (tutti i dispositivi, da sempre) crescente, poi per ultimo ascolto più vecchio; i mai ascoltati per primi |
| D10 | Dove sta un brano (player web) — vedi `2026-11-07-web-player-ux-design.md` W2 | Due flag indipendenti per brano: **FS** (file sul disco di geekom: libreria Spooty o `SoundReel/`) e **media server** (replica verificata sul Fritz, oppure presente nel catalogo del Fritz anche se è un file suo e non nostro). Possono valere entrambi; nessuno dei due = solo streaming (YouTube) |
| D11 | Lista del player web — vedi `2026-11-07-web-player-ux-design.md` W3 | Se la coda ha **più di 20** brani se ne mostrano **al massimo 20**: il primo è sempre quello in play, sotto i successivi; quelli già ascoltati escono dall'alto. Con 20 brani o meno la lista resta intera. Un contatore dice quanti sono nascosti |

## 2. Dati (migration 017)

- `play_events(id PK client UUID, user_id, device, song_key, started_at, local_started_at, tz_offset_min, listened_ms, duration_ms, completed, origin, playlist_id, counted, received_at)` — `local_started_at` (timestamp senza zona) calcolato al ricevimento = `started_at + tz_offset_min`; ora e giorno locali si leggono da lì. Indici su `(user_id, started_at)`, `(song_key)`, `(counted, local_started_at)`.
- `device_events(id, ts, at, user_id, device, type, details JSONB, event_id UNIQUE)` — audit durevole (la console non lo cancella).
- `playlists.kind` (`static`|`dynamic`, default `static`) e `playlists.rule` (JSONB).

## 3. Backend

- `POST /api/mondrop/plays`, `POST /api/plays`, `POST /api/mondrop/device-events` (contratto in `docs/mondrop-stats.md`).
- `services/playEvents.ts` (validazione, inserimento idempotente, `counted`), `services/listeningStats.ts` (aggregati SQL per la dashboard e `plays`/`lastPlayedAt` per brano), `services/dynamicPlaylists.ts` (valutatore della regola + riepilogo leggibile + preset).
- `routes/stats.ts`: `GET /api/stats/listening`, `/recent`. Permessi: D4.
- Playlist: `kind`/`rule` nelle liste e nei dettagli; add/remove/reorder su una dinamica → `409 playlist_is_dynamic`; il manifest Mondrop di una dinamica calcola le `tracks` al volo.
- Manifest/track: `plays` e `lastPlayedAt` per brano.
- Dove sta il brano (D10): `GET /api/songs` aggiunge per canzone `fs` (= `inLibrary`) e `mediaServer` (replica verificata in `song_files` **oppure** voce nel catalogo `media_index` con la stessa chiave artista|titolo); `GET /api/songs/:key/state` aggiunge `location: { fs, mediaServer }`. Una query sola sul catalogo (chiavi normalizzate in memoria), non una per brano.

## 4. Log di attività (richiesta 1)

Scritto nella tabella `logs` esistente, quindi compare nella **Console** con il filtro «funzione» (= categoria); ogni riga ha `data.action` e `data.actor = { user, device, channel }`.

| Categoria | Azioni (messaggio d'esempio) |
|-----------|-------------------------------|
| `playlist` | `create` «mike ha creato la playlist «Road trip»» · `rename` · `delete` · `add_song` «mike ha aggiunto «White Flag – Bishop Briggs» a «Road trip»» · `remove_song` · `reorder` · `share` / `unshare` · `rule_update` |
| `sync` | `prepare` «mike (iPhone di Michele) ha avviato il sync di «Road trip»: 12 pronti, 5 in preparazione, 1 da cercare» · `manifest` (una volta ogni 10 min per dispositivo e playlist, non a ogni polling) |
| `download` | `request` «mike (iPhone di Michele) chiede «X» (priorità play) → in preparazione» · `file` «mike (iPhone di Michele) scarica «X» (5,5 MB)» (solo l'inizio del trasferimento, non ogni Range) · `done` (riusata / adottata dal media server, nessuna copia / YouTube) · `retire_copy` (copia 2.7.0 tolta) · `request` anche dal web · `failed` · `override` |
| `device` | `delete_songs` con l'elenco completo (titolo, artista, byte, ascolti, ultimo ascolto), motivo, criteri, conferme · `plays` (lotto di ascolti ricevuto: quanti, da chi) |

Chi = utente della key (+ etichetta del dispositivo) o utente Authelia sul web; i lavori del worker sono `sistema` con `requestedBy` nei dati.

## 5. iOS (Mondrop 1.4)

- **PlayTracker**: osserva il player, accumula i ms realmente ascoltati (seek/pausa non contano), emette un evento per sessione ≥ 3 s con `origin` local/stream e la playlist di partenza.
- **Coda eventi** su file in Application Support + **uploader** a lotti (D2), con `beginBackgroundTask` quando l'app va in background.
- **Spazio**: schermata con spazio occupato, elenco dei brani scaricati con peso, ascolti, ultimo ascolto; ordinamento «meno ascoltate»; selezione multipla; scorciatoie «Elimina le N meno ascoltate» e «Libera X MB»; doppia conferma per i blocchi (D7); evento al server in coda offline.
- **Skip-list** locale dei brani cancellati (D8) con «Riscarica».
- **Playlist dinamiche**: arrivano come playlist normali con badge e `ruleSummary`; il Sync scarica i brani correnti.

## 6. Web

- **Player web — dove sta il brano (D10):** accanto a ogni brano della coda e nel brano in play un badge: `FS` (disco di geekom), `MS` (media server), `FS+MS` (entrambi), nessun badge «solo streaming» (con tooltip in italiano/inglese). Il dato viene da `GET /api/songs` (`fs`, `mediaServer`) e, per il brano in corso, da `GET /api/songs/:key/state` (`location`); si aggiorna quando il download in parallelo del primo play finisce.
- **Player web — finestra della lista (D11):** coda ≤ 20 brani = intera come oggi; coda > 20 = finestra di 20 che parte dal brano in play (indice corrente) e scorre avanti con la riproduzione; i già ascoltati escono dall'alto, il brano in play è sempre in cima; riga di stato «20 di 57 · 14 già ascoltate nascoste». Precedente/successivo/shuffle/ripeti ragionano sulla coda intera, non sulla finestra. Vale anche per il mini player e per la pagina del player.

- Pagina **Statistiche** (`/stats`): totali, ascolti per giorno, mappa ora × giorno, classifiche (brani, artisti, tipi/generi), per dispositivo e per origine, mai ascoltati; selettore periodo e, per l'admin, utente/dispositivo. Grafici in SVG, nessuna libreria.
- **Playlist dinamiche** nel Playlist manager: come cartelle in sola lettura con un'icona, creazione/modifica della regola (fascia oraria, giorni, periodo, genere, ordine, limite) con preset.
- Il player web manda i suoi ascolti (D3).
- Il Playlist manager mostra gli stessi badge `FS` / `MS` accanto al pallino «scaricata».

## 7. Test

Unità su validazione, soglia `counted`, idempotenza, finestre che attraversano la mezzanotte, fusi/ora locale, valutatore delle regole, permessi della dashboard; SQL verificato su un Postgres vero (container usa-e-getta) con eventi sintetici; end-to-end: eventi → statistiche → playlist dinamica → manifest. iOS: XCTest su PlayTracker, coda, uploader, ordinamento «meno ascoltate», doppia conferma, skip-list.
