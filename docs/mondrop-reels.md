# I reel in Mondrop — contratto API (`/api/mondrop/reels`, `/api/mondrop/reels/:id`, `/api/mondrop/reels/:id/image`)

Spec: `docs/superpowers/specs/2026-11-12-mondrop-home-play-loop-reels-design.md` (M5, §4), ADR-0033. Richiesta di Michele (12 novembre): «Voglio avere anche un tab con le altre categorie sul reel ( dove però per ora l'unica cosa che viene portata sulla device è la musica ) ma non il link al reel ma la sua scomposizione e spiegazione.»
**Stato: in produzione dal 12 novembre (SoundReel 2.27.0, 17:40), verificato sul server vero; `openUrl` (la scheda del film) è della 2.28.0, in produzione dal 13 novembre (00:15, revisione `a290ace`) e verificata sul server vero.** Dove il codice ha precisato il contratto, è corretto qui (le righe «come fa il codice»).

## Che cosa è

L'elenco dei post (reel, caroselli, link) che SoundReel ha già analizzato per la persona, dal più recente: di ognuno **di cosa parla** (la spiegazione: il riassunto dell'analisi) e **cosa contiene, diviso per categoria** (musica, film, software, luoghi, libri, prodotti, marchi, persone, eventi, citazioni). Il **server** scompone e spiega, l'app disegna (regola P). Si legge soltanto quello che l'analisi ha già salvato: **nessun modello, nessuna chiamata esterna, niente in coda, niente scritto**.

**Non c'è il link al post** — né in un campo né dentro le parole: nessuna risposta contiene `sourceUrl`, `mediaUrl`, `imdbUrl` o `url`, nessun indirizzo (`http…`, `www…`) nel testo e nelle cose del reel, e l'indirizzo del post non compare da nessuna parte (i **brani** sono quelli di sempre e portano il vecchio `coverUrl` (l'indirizzo di una copertina del fornitore: Apple o Deezer; l'app non lo scarica, chiede la copertina a SoundReel con `coverPath`)). **Un'eccezione sola, dalla 2.28.0** (Michele, 12 novembre: «Q3 si apri sulla scheda»): un **film** può avere `openUrl`, la **scheda del film su IMDb**, costruita dal server dall'id (vedi `sections`); mai il post, mai un software, mai una scheda dell'elenco. **Sul telefono resta solo la musica**: i brani di un reel sono i brani di Mondrop (si suonano, si scaricano, si mettono in playlist); tutto il resto è testo che l'app legge ogni volta e **non tiene**.

## Chi è l'utente — e la sicurezza

Come tutte le rotte `/api/mondrop/*`: header `X-SoundReel-Key`; **l'utente è quello della key**, mai il corpo, la query o il percorso (`?user=` e `X-SoundReel-User` sono ignorati per una key legata a una persona). Si leggono **solo i reel che la persona può leggere**: i suoi più quelli condivisi con lei (la regola di tutte le liste del sito, **senza** la vista dell'amministratore sui post anonimi). Un reel che non esiste e uno che la persona non può leggere hanno la **stessa** risposta, `404 { "error": "not_found" }`: mai `403`. Le rotte stanno sotto `/api/mondrop` (Traefik senza Authelia), mai dietro Authelia. Senza key `401` prima di tutto. Sono **tutte letture**: `POST`, `PUT`, `PATCH` e `DELETE` non esistono (`404`).

**Come fa il codice (SQL):** la visibilità è sempre nella `WHERE` e ogni valore (utente, id, categoria di un filtro, limite, scarto) è un **parametro**, mai scritto nel testo della query; di `results` si leggono solo le parti che servono (mai l'indirizzo del post, la didascalia, la trascrizione o il testo letto dalle immagini).

## Le rotte

### `GET /api/mondrop/reels?limit&offset&kind&facets`

| Parametro | Significato | Se sbagliato |
|---|---|---|
| `limit` | quanti reel, da 1 a **50** (di partenza **20**) | `400 { "error": "invalid_limit" }` |
| `offset` | da quale reel (di partenza 0; al massimo 1 000 000) | `400 { "error": "invalid_offset" }` |
| `kind` | solo i reel che hanno almeno una voce di questa categoria: `music`, `film`, `software`, `place`, `book`, `product`, `brand`, `person`, `event`, `quote` | `400 { "error": "invalid_kind" }` |
| `facets` | `1` o `true`: aggiunge `kinds`. `0` o `false` (o niente): no | `400 { "error": "invalid_facets" }` |

**Come fa il codice:** un numero va scritto con le sole cifre (`5`, non `+5`, `5.0`, `1e1`, `-1`); un valore **vuoto** vale «non dato» (un'app che costruisce l'indirizzo da parti facoltative); lo **stesso nome due volte** (`?kind=film&kind=book`) è sbagliato; la categoria va scritta come sopra, minuscola, senza spazi; il primo parametro sbagliato nell'ordine `limit`, `offset`, `kind`, `facets` dà il nome all'errore e **non si legge niente**; ogni altro parametro (`?user=…`) è ignorato.

Risposta `200` (`Cache-Control: no-store`):

```json
{
  "total": 1665,
  "limit": 20,
  "offset": 0,
  "kinds": [ { "kind": "music", "label": "Musica", "count": 733 }, { "kind": "film", "label": "Film", "count": 264 }, … ],
  "reels": [
    {
      "id": "8167b826-f8e2-4298-b477-174c41bcc13b",
      "createdAt": "2026-11-12T07:46:32.515Z",
      "platform": "instagram",
      "summary": "Claude OS è un sistema completo che offre oltre 500 competenze, masterclass e automazioni per potenziare le capacità di Claude.",
      "imagePath": "/api/mondrop/reels/8167b826-f8e2-4298-b477-174c41bcc13b/image",
      "counts": [
        { "kind": "music",    "label": "Musica",   "count": 1, "names": ["End Of Line - Slowed + Reverb"] },
        { "kind": "software", "label": "Software", "count": 4, "names": ["Claude", "Notion", "Gmail"] }
      ]
    }
  ]
}
```

- **Quali reel:** quelli **completati** che hanno una spiegazione **o** almeno una voce in una categoria che si mostra. Dal più recente; a parità di data per `id`, così due pagine non mostrano mai lo stesso reel. `total` è quanti reel passano le **stesse** condizioni (e il filtro `kind`), non quanti ce ne sono nella pagina, e resta giusto oltre la fine (pagina vuota).
- `kinds` (**solo con `facets`**): quanti reel hanno ciascuna categoria su **tutti** quelli leggibili (non seguono né la pagina né il filtro `kind`), **nell'ordine delle categorie** e **solo quelle con almeno un reel**. Un reel conta una volta per ogni categoria che ha. È approssimato come il filtro: conta quello che l'analisi ha salvato, prima della pulizia (un reel con una sola nota che la pulizia butta conta lo stesso). **Come fa il codice:** se le faccette falliscono (va nel log) la risposta c'è lo stesso, **senza `kinds`**.
- `platform`: `instagram`, `tiktok`, `youtube`… in minuscolo, `other` se non si sa. Serve per scrivere «Instagram · 12 nov»; **non è un indirizzo**.
- `summary`: la spiegazione, di una riga o due, già pulita (vedi sotto), o `null`.
- `imagePath`: percorso **di SoundReel** della miniatura (320 px), **solo se la miniatura è un file del server** (1 594 reel su 1 665 il 12 novembre); l'indirizzo di una CDN altrui non si passa mai. L'app lo chiede con la key.
- `counts`: **solo le categorie con almeno una voce**, nell'ordine delle categorie; `count` è quante voci ha la pagina del reel in quella categoria (la scheda dice quello che la pagina mostra), `names` i **primi tre** titoli (al massimo 60 caratteri ciascuno, con «…»). Per la Musica sono i titoli dei brani.
- Un guasto nel leggere i reel è `500 { "error": "reels_failed" }` (va nel log, mai nel corpo).

### `GET /api/mondrop/reels/:id`

`404` se il reel non esiste, non è leggibile **o non è tra quelli che l'elenco mostra** (una scheda dell'elenco si apre sempre, il resto no), o se `:id` non può essere l'id di un post (un UUID, o i 20 tra lettere e cifre dei post arrivati da Firestore: 87 su 1 743; **non si interroga nemmeno il database**). Risposta `200` (`Cache-Control: no-store`):

```json
{
  "id": "805eb3b3-2eff-4c91-81da-1d0121ac3cb9",
  "createdAt": "2026-11-12T07:30:00.000Z",
  "platform": "instagram",
  "summary": "Un post sui modelli di rischio usati nei Paesi Bassi per valutare i cittadini.",
  "imagePath": "/api/mondrop/reels/805eb3b3-2eff-4c91-81da-1d0121ac3cb9/image",
  "tags": ["intelligenzaartificiale", "welfare"],
  "sections": [
    { "kind": "music", "title": "Musica", "tracks": [ { "songKey": "yom::garden of eden", "title": "Garden of Eden", "artist": "Yom", "state": "ready", "downloadPath": "/api/mondrop/songs/…/file", "coverPath": "/api/mondrop/songs/…/cover", "…": "…" } ] },
    { "kind": "film", "title": "Film", "items": [ { "title": "Dune", "detail": "2021 · regia di Denis Villeneuve", "openUrl": "https://www.imdb.com/title/tt1160419/" } ] },
    { "kind": "software", "title": "Software", "items": [ { "title": "Notion", "detail": "prodotto · Appunti e database" } ] },
    { "kind": "place", "title": "Luoghi", "items": [ { "title": "Trattoria da Gino, Milano", "detail": null } ] }
  ],
  "insights": [ { "label": "Philip Alston", "text": "Philip Alston è un esperto di diritti umani…" } ],
  "verdict": { "label": "dubbio", "explanation": "Non ci sono fonti." },
  "slides": [ { "index": 0, "summary": "La prima slide spiega il problema." } ]
}
```

- `sections`: **nell'ordine delle categorie**, **solo quelle con qualcosa**. La **Musica** ha `tracks`: gli **stessi oggetti `track`** della libreria e di Cerca (stato, `downloadPath`, `coverPath`, `version`, `bytes`…, costruiti con `buildTracks`), **senza il campo `mediaUrl`** (sempre `null` dalla 2.13.0 e mai letto dall'app; il vecchio `coverUrl` invece resta, come in ogni elenco di brani); sono i brani del post che il **diario della persona** conosce (per la chiave `artista::titolo` come l'ha scritta il post), nell'ordine del post, una volta ciascuno, **al massimo 50**; un brano che il diario non conosce non compare (nessun buco). Le altre categorie hanno `items` `[{ "title", "detail": string|null, "openUrl"?: string }]`, **al massimo 20**. **`openUrl` (dalla 2.28.0) c'è solo su un film** che ha la sua pagina su IMDb ed è `https://www.imdb.com/title/<id>/`, **costruito dal server** dall'id (`tt` e 7–10 cifre) di un indirizzo che è una pagina titolo di IMDb (`imdb.com`, con al più `www.` o `m.`; niente credenziali, porta o host più lungo): **qualunque altro valore** (un altro sito, la pagina di una persona, una ricerca, l'indirizzo del post, un testo) **non dà `openUrl`**, e allora **la chiave non c'è** (non `null`). Mai sul software (l'analisi ha un indirizzo per 1 software su 1 370), mai sulle altre categorie, mai nelle schede dell'elenco. Lo stesso film nominato due volte è una voce sola e tiene la scheda della menzione che ce l'ha. Il 12 novembre: 498 dei 741 film dei 1 665 reel.
- `tags`: le parole chiave **senza `#` né `@`**, senza i segnaposto del modello (`tag`, `utente`, `hashtag`), una volta ciascuna (senza badare alle maiuscole), al massimo 12.
- `insights`: gli «approfondimenti» che il modello locale ha scritto per ciò che il post nomina (`label` + `text`, mai i link), **al massimo 8**, `text` al massimo 600 caratteri, **mai senza testo**, la stessa etichetta una volta. **Possono essere sbagliati** (li scrive un modello): l'app li presenta come «Generato dall'IA».
- `verdict`: il verdetto del reel (`vero`, `falso`, `dubbio`, `ai-generated`, `phishing`, `sicuro`, `sospetto`) con le sue parole (`explanation`, `""` se non ce ne sono) — senza la confidenza — o `null`.
- `slides`: per i caroselli, **solo le slide che hanno una spiegazione**: `index` (da 0; la posizione nella lista se manca) e `summary` (al massimo 600 caratteri). Niente immagini né il testo letto da esse.
- Gli altri campi (`id`, `createdAt`, `platform`, `summary`, `imagePath`) sono quelli dell'elenco.
- Un guasto nel leggere il reel è `500 { "error": "reels_failed" }`. **Un guasto dei brani** (il diario o la libreria) costa **solo la Musica** (nel log): la pagina risponde senza quella sezione.

### `GET /api/mondrop/reels/:id/image`

Il JPEG della miniatura (`<media>/<id>/thumbnail.jpg`, 320 px). Header `Content-Type: image/jpeg`, `Content-Length`, `Cache-Control: private, max-age=86400`. `404 { "error": "not_found" }` se il reel non è leggibile, se la miniatura non c'è o è vuota, o se `:id` non può essere un id. **Il permesso si chiede prima del disco** e nessun percorso esce dalla cartella dei media.

## Come si scompone un reel (le regole, scritte in codice e provate sui 1 665 reel veri)

1. **Categorie, nell'ordine in cui compaiono ovunque:** Musica, Film, Software, Luoghi, Libri, Prodotti, Marchi, Persone, Eventi, Citazioni. La Musica viene dalle canzoni del post, i Film dai film, il Software dal software, le altre dalle **note** per categoria (`place`, `book`, `product`, `brand`, `person`, `event`, `quote`). La categoria `other` delle note e ciò che non è una categoria di cose (`tag`, `tags`, `note`, vuota, un numero, una parola in italiano) **non si mostra**: è ciò che il modello non ha saputo classificare. La categoria si legge senza badare a maiuscole e spazi.
2. **Pulizia delle parole del modello** (in ogni campo): niente segnaposto copiati dal prompt (`#tag`, `@utente`, `#hashtag`, `...`, `null`, `anno o null`); un testo vuoto o fatto di soli segni non è una voce; a capo e spazi doppi diventano uno spazio; **gli indirizzi scritti dentro le parole si tolgono e le parole restano** («Vedi https://… per il resto» → «Vedi per il resto»); un nome senza le virgolette che il modello ci mette intorno (`'AGENTI'` → `AGENTI`); senza i segni di un JSON rotto ai bordi (`> vLLM`, `}TypeScript`, `Zed {`) e **scartato** se dentro restano graffe, apici inversi o `**`; scartati i frammenti di percorso (`/n`, `/repo`, `/name`) e le note che sono solo il nome della loro categoria (`event`, `persona`); per il software anche i titoli che non sono nomi (`isJunkSoftwareTitle`: `tool`, `repo`…).
3. **La stessa cosa una volta sola, nello stesso reel** (senza maiuscole, accenti e punteggiatura): il software, i luoghi, i prodotti, i marchi, le persone e gli eventi sono la **stessa famiglia** («Notion» come software e come prodotto è una cosa sola) e vale la **prima categoria** nell'ordine; un film e un libro con lo stesso titolo, una citazione, una canzone **non** si fondono con nient'altro (la canzone ha la sua identità: la chiave).
4. **Tagli** (in caratteri, con «…»): titolo 140, dettaglio 200 (il dettaglio intero), citazione 280, riassunto 1 500, approfondimento 600, slide 600; **al massimo 20 voci** per categoria (le ripetute non ne consumano), **50 brani**, 12 parole chiave, 8 approfondimenti. Le schede dell'elenco dicono quello che la pagina mostra, già tagliato.
5. **Una nota che è una frase intera** (650 su 5 000 il 12 novembre: «Timorasso Derthona, Vigneti Massa (Piemonte) - vitigno salvato dall'estinzione…»): se è più lunga di 80 caratteri e **il primo separatore** (` - `, ` – `, ` — `, `: `) cade dopo il terzo carattere e **entro l'80°**, ciò che sta prima è il **titolo** e il resto il **dettaglio**; altrimenti resta intera (un nome con un trattino dentro non si spezza).
6. **Film:** `detail` = «anno · regia di …» (l'anno è un anno: «anno o null» o «molto tempo fa» non lo sono). **Software:** `detail` = il tipo (`repo`, `prodotto`, `articolo`; `other` nessuno) e la descrizione, separati da « · ».
7. **Un reel danneggiato** (un JSON di un tipo che non ci si aspetta: una lista che è un testo, una nota che è un numero) **è un reel senza niente**, mai un errore.

**Misurato il 12 novembre sui 1 665 reel di Michele:** 1 665 schede, 16 senza spiegazione, 57 senza categorie (solo la spiegazione), **1** del tutto vuota (né una né le altre dopo la pulizia); 1 594 con la miniatura; la pagina pesa in mediana 719 byte (al massimo 3,9 KB senza brani); 6 schede toccano un limite (20 voci o 50 brani). Chiavi di brano: 1 021 delle 1 022 che il costruttore fa esistono in `song_meta`. Limiti noti: i modelli confondono le categorie («Claude» come persona, come film e come software; un film che è un software) e a volte scrivono un testo del riconoscimento ottico come nome (`'da e Jango ChatGPT >`): non si può correggere qui.

## Errori

| Risposta | Quando |
|----------|--------|
| `400 { "error": "invalid_limit" \| "invalid_offset" \| "invalid_kind" \| "invalid_facets" }` | un parametro dell'elenco è sbagliato (vedi la tabella) |
| `401` | key mancante o non valida (prima di tutto) |
| `404 { "error": "not_found" }` | il reel non esiste, non è leggibile, non è tra quelli che si mostrano o l'id non è un id; la miniatura non c'è |
| `404` (senza corpo nostro) | **un server senza la 2.27.0**: la rotta non esiste; l'app dice «Serve un SoundReel più recente» |
| `500 { "error": "reels_failed" }` | un guasto del server (va nel log, mai nel corpo) |

## Come si comporta l'app (non lo decide il server, ma la risposta deve reggerlo)

- L'app **non tiene** i dati dei reel sul telefono (solo le miniature nella cache di sistema, che iOS svuota quando serve); senza rete il tab dice che serve la rete. La **musica** già scaricata si suona lo stesso.
- Legge in modo tollerante: una categoria o un campo che non conosce si tiene e non si disegna; `names`, `tags`, `insights`, `slides` e `verdict` mancanti valgono «niente».
- **Apre un solo indirizzo, e solo con un tocco**: l'«Apri» sulla scheda di un film (`openUrl`, pulsante «Apri su imdb.com», che dice dove va). L'app apre solo una pagina web su **https**, con un host e **senza credenziali**; un indirizzo diverso lascia il film senza «Apri» e non rovina la voce. Un server 2.27.0 non manda il campo (nessun «Apri», il resto funziona); la build 20 lo ignora. Un test dell'app fallisce se i modelli dei reel hanno un campo di indirizzo diverso da `openUrl` o se una vista dei reel apre altro.
