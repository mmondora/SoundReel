# Player web — regole di interfaccia e di sorgente

- **Data:** 2026-11-07
- **Stato:** In implementazione (versione 2.8.0)
- **Aggiornamento (2.15.0, regola P, `adr/0018-…`, spec `2026-11-08-mondrop-search-spotify-style-design.md` S11):** **le regole W5–W7 e S2–S5 sulla sorgente non si applicano più nel browser: le applica il server.** Il player chiede `GET /api/songs/:key/play?prefer=auto|internet|media` e segue la risposta (`from`: `media-server`, `disk` o `youtube`; `download`; `fileUrl`). Regola di Michele (8 novembre): «se siamo su internet parte da youtube, sempre. se siamo in casa parte da youtube nel frattempo.» — da internet YouTube **sempre** (anche se il file c'è), in casa il file se c'è e altrimenti YouTube mentre il server lo prepara. L'interruttore «Sorgente» resta come **preferenza** che il browser manda (`prefer`); `GET /api/net` non è più chiamato dal player. Le «funzioni pure» del §5 (sorgente effettiva da modo, rete e posizione) stanno ora in `backend/src/services/playPlan.ts` con gli stessi casi di prova.
- **Owner:** Michele
- **Correlati:** `docs/mondrop-sync.md` («Primo play»), `docs/mondrop-stats.md` §6–§8, `2026-11-07-listening-stats-dynamic-playlists-design.md`, `2026-11-07-mp3-store-media-server-design.md` §2.9, `adr/0010-web-plays-from-media-server-no-copy.md`

Raccoglie in un posto solo le regole che Michele ha dato per il player web (`PlayerPage`, `MiniPlayer`, coda) e per il Playlist manager su **dove sta un brano** e **da dove si suona**.

## 1. Richieste (testuali, in ordine)

1. «vorrei che anche al primo play di una canzone, se non è già stata scaricata, la scarichi (mentre avviene il play, in parallelo, per le chiamate successive). Mentre se è già stata scaricata il play avviene dal file locale.»
2. «nel player web voglio vedere se una canzone è locale oppure no (e se è su FS, o su media server)»
3. «voglio che la lista delle canzoni scrolli (oppure tolga in alto quelle già ascoltate) - questo solo se la playlist è superiore a 20 canzoni, che diventa il limite di quelle mostrate. Quella in alto è sempre quella in play.»
4. «sul player web se c'è il video lo voglio al posto della foto, nello stesso spazio - se invece è in streaming locale, si deve mostrare la copertina/foto dell'album.»
5. «il webplayer non deve copiarla. dove l'ha copiata? deve "playarla" dal media server (questo anche da internet!). il webplayer scarica e mette sul media server se non ci sono. mondrop invece scarica in locale e playa in locale, ma vale solo per mondrop su device ios per ora.» *(caso: «Nightcall» di Kavinsky, già sul Fritz, era stata copiata su geekom al primo play)*
6. «dalla gestione playlist devo poter vedere la url/file location di ogni canzone. quelle con il pallino verde mi aspetto siano o sul filesystem di rete o sul media server.»
7. «anzi, il player da internet deve avere uno switch per dove prendere la canzone, il default è di prenderla da internet - l'alternativa è prenderla dal media server di casamon.dev (ma dovrebbe essere raro, se sono in auto col telefono le canzoni sono sul telefono)»
8. «mentre il comportamento di prima vale solo per quando il player è lanciato dalla rete interna, che preferisce il media server ad internet. anche qui si potrebbe azionare il toggle/switch in base alla rete»

**Come si leggono insieme (5, 7, 8):** le richieste 7 e 8 precisano la 5 («anzi», «mentre»). Il web **non copia mai** un brano che sta già sul media server (5) e, quando lo suona dal media server, lo fa **anche da internet** tramite il backend; ma **da dove suona** dipende dalla rete: **da internet il default è Internet** (YouTube), il media server è l'alternativa rara (7); **dalla rete interna il default è il media server** (8). Lo switch si imposta da solo in base alla rete e si può forzare a mano (8).

## 2. Decisioni prese con valori di default (da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| S1 | Posizioni dello switch «Sorgente» | **Auto** (default), **Internet**, **Media server**. `Auto` = rete interna → Media server; da internet → Internet. Le altre due forzano la scelta |
| S2 | Come si riconosce la rete | **Lato server**, con la stessa regola già usata da Mondrop (`/api/mondrop/net`): richiesta che arriva via Cloudflare (`CF-Ray` / `CF-Connecting-IP`) = **internet**; richiesta diretta a Traefik = **rete interna**. Endpoint `GET /api/net` → `{ network: "internal" \| "external" }`. Il browser non può saperlo da solo (non raggiunge il Fritz, HTTPS→HTTP bloccato) |
| S3 | Cosa vuol dire «Internet» | Il ripiego YouTube di sempre (video nel riquadro, W4): nessun carico sulla banda di casa |
| S4 | Cosa vuol dire «Media server» | Il file di **casa**, via backend: prima il **media server** (proxy HTTPS verso il Fritz, W5); se il brano non c'è ancora lì ma c'è sul disco di geekom (FS, es. appena scaricato in attesa di pubblicazione) suona quello; se non c'è né l'uno né l'altro suona da Internet e parte il download (W6) |
| S5 | Persistenza dello switch | La scelta manuale vale per quel browser (localStorage); `Auto` si rivaluta a ogni caricamento della pagina. Se `GET /api/net` fallisce `Auto` si comporta come da internet |
| S6 | Download in parallelo (W1) | Parte comunque al primo play quando il brano non è né su FS né su media server, **qualunque** sia la posizione dello switch |
| S7 | Chi vede i percorsi (W8) | Tutti gli utenti loggati del web: percorso su disco e URL del media server sono indirizzi di casa senza segreti dentro; si restringe agli admin se serve |
| S8 | Pallino verde (W8) | Verde **se e solo se** il brano è su FS o sul media server (`fs \|\| mediaServer`): dal pallino si risale sempre a un percorso visibile |
| S9 | Chiavetta del Fritz scollegata (è anche il drive dell'auto) | Il Fritz continua a rispondere ma con 1 voce di catalogo e `404` per ogni file. L'indice **non** viene sostituito da un catalogo crollato sotto la metà, un file si dichiara sparito solo se un file di controllo risponde, un brano che sta sul Fritz **aspetta** (10 min, nessun tentativo contato) invece di scaricarsi da YouTube in doppione. Visibile in `GET /api/admin/store` (`volumeMissing`). ADR-0010 §9 |

## 3. Regole

| # | Regola |
|---|--------|
| W1 | **Primo play**: il brano parte dalla sorgente scelta (W5). Se non è né su FS né sul media server parte in parallelo `POST /api/songs/:key/download` con priorità `play`, una volta per brano per sessione; si controlla `GET …/state` ogni ~5 s (max ~3 min); a download finito la riproduzione in corso **non** si interrompe, vale dalla volta dopo. *(download in parallelo: implementato in 2.7.0)* |
| W2 | **Dove sta il brano**: badge accanto a ogni brano della coda e nel brano in play: `FS` (disco di geekom), `MS` (media server), `FS+MS`; nessun badge = solo streaming. Dati: `fs` / `mediaServer` in `GET /api/songs`, `location` in `GET /api/songs/:key/state`. Stessi badge nel Playlist manager |
| W3 | **Finestra della lista**: coda di **più di 20** brani → se ne mostrano al massimo **20**; il primo è sempre quello in play, sotto i successivi; i già ascoltati escono dall'alto; riga di stato «20 di N · K già ascoltate nascoste». Con 20 o meno la lista è intera. Precedente/successivo/shuffle/ripeti lavorano sulla coda intera |
| W4 | **Spazio immagine** (il riquadro in cima al player dove oggi sta la foto): se il brano suona da **Internet** (ripiego YouTube) il **video sta al posto della foto, nello stesso riquadro** (stessa posizione e dimensione, il video si adatta con `contain`, senza spostare il resto della pagina); se suona dal **file di casa** (media server o FS, quindi audio in streaming) il riquadro mostra la **copertina / foto dell'album**. Passando da un brano all'altro il riquadro si adegua; se il video non parte o l'embed è bloccato si torna alla copertina; a download finito del primo play il brano in corso resta com'è (W1). Vale per la pagina del player; il mini player tiene la miniatura |
| W5 | **Switch «Sorgente»** nel player (pagina e mini player): `Auto` · `Internet` · `Media server` (S1–S5). Con `Media server` il file arriva da `GET /api/songs/:key/file`: il backend lo legge **dal Fritz** (proxy HTTPS con `Range`, quindi seek e ripresa, anche da internet) e **non lo copia** su geekom; il browser non parla mai col Fritz. Il badge del brano in play dice da dove sta suonando |
| W6 | **Nessuna copia, il web mette sul media server**: un brano già presente sul media server **non** viene mai copiato su geekom (né dal primo play né dal sync). Un brano che non c'è lo scarica il backend (YouTube) e lo **mette sul media server**: arriva sul disco di geekom (origine e appoggio, ADR-0006: il backend non monta mai lo share SMB) e un **invio su richiesta** del `fritz-sync` lo porta sul Fritz in pochi minuti; da quando il Fritz lo serve (verificato) le volte dopo suona da lì. **Mondrop su iOS no**: scarica in locale e suona in locale (vale solo per Mondrop su iOS, per ora) |
| W7 | **Rete**: `GET /api/net` dice se il client è in rete interna o da internet (S2); serve a `Auto` e non porta dati personali |
| W8 | **Gestione playlist (Playlist manager)**: di **ogni canzone** si vede la **posizione**: percorso del file su disco (FS), URL del file sul media server (MS) e, per i brani solo in streaming, il link YouTube; nel pannello brani come riga di dettaglio (attivabile) e nel dialogo dettagli del brano. Il **pallino verde** compare solo se il brano è su FS o sul media server (S8) |

### Caso di riferimento (W2, W5, W6, W8)
«Nightcall» di Kavinsky è sul media server (`Music/Kavinsky/Nightcall/…`). Oggi (2.7.0) l'interfaccia dice solo «scaricata», perché conosce soltanto «ha un file locale»: il dato che manca è la **posizione** (`fs` / `mediaServer`), non il download. In 2.8.0: badge **MS**, percorso/URL visibili nel Playlist manager, pallino verde perché è sul media server, suono dal media server (dalla rete interna di default, da internet solo scegliendo `Media server`) e **nessuna copia su geekom**. La copia che la 2.7.0 aveva fatto in `~/Music/SoundReel/Kavinsky - Nightcall.mp3` viene ritirata dalla 2.8.0 (solo se l'originale sul Fritz risulta raggiungibile).

## 4. Copertina

Ordine: copertina del brano (`song_meta.cover_url`, quella del lookup Deezer/iTunes o di Shazam/Spotify) → miniatura dell'entry → segnaposto neutro (mai un riquadro vuoto che sposta il layout).

## 5. Accessibilità e test

Il video ha un `title` leggibile dallo screen reader; il passaggio video↔copertina non ruba il focus; lo switch è un controllo etichettato (`role="radiogroup"` o `<select>`) con la sorgente effettiva letta ad alta voce. Test:

- funzione pura «sorgente effettiva» da (modo dello switch, rete, posizione del brano): `Auto`+interna → media server; `Auto`+internet → Internet; modo forzato vince sulla rete; media server senza FS né MS → Internet + download; `GET /api/net` in errore → come internet;
- funzione pura «video o copertina» da (sorgente in riproduzione, disponibilità del video): file di casa → copertina; ripiego YouTube con video → video; video fallito → copertina; cambio brano; primo play con download concluso (non cambia durante la riproduzione);
- backend: `/api/songs/:key/file` dal Fritz con `Range` (206, `Content-Range`), brano su FS e MS → vince MS, Fritz che non risponde → ripiego su FS, nessuna copia fatta dal worker per un brano del media server.
