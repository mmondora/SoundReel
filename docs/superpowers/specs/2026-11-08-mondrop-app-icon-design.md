# L'icona di Mondrop, rifatta a vettore (richiesta 2026-11-08)

Stato: **costruita e su TestFlight** (Mondrop 1.7.0, build 8, caricata l'8 novembre alle 16:34, elaborata e VALID). Michele: «icona va bene». Solo interfaccia: nessuna ADR (le regole d'interfaccia stanno nella spec).
Codice: `ios/scripts/make_app_icon.mjs` (disegno e cataloghi), sorgenti SVG in `ios/icon/`, prove `ios/scripts/make_app_icon.test.mjs` e `ios/MondropTests/AppIconAssetsTests.swift`.

## 1. Richieste di Michele (testuali)

> «volgio rifare l'icona di mondrop, mi sembra troppo poco professionale.»

Davanti alla bacheca di prove (quattro idee, ognuna in tre colori, e la proposta con le prove a grandezza reale), la risposta:

> «la goccia con le onde ( sondo giallo e goccia nera ) per mondrop, mentre la casa gialla con le onde a sfondo azzurro per home-ass»

Dopo che la gemella era stata installata nell'app della TV:

> «Non voglio due app diverse sulla tv - l'app è quella di prima e deve avere icona diversa e basta.»

## 2. Com'era e perché non andava (misurato l'8 novembre)

- Il 7 novembre Michele scelse «P — casa-lanterna» tra le prove della sessione Grok (brief: «casa Casamon, giallo, stile surreal del reel, niente persone, pochi occhi»): **un dipinto** (una casetta sotto un'aurora) generato con l'IA e ritagliato a 1024 px.
- Da vicino è un quadro; **alle misure vere** di una Home (120 px sul telefono), di Impostazioni (87 e 58 px) e delle notifiche (40 px) diventa una macchia di colori: la casa non si distingue più. Un'icona professionale ha **un solo segno**, una sagoma che si legge a colpo d'occhio, due colori, ed è nitida a ogni misura.

## 3. Decisioni prese con valori di default (da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| D1 | **Disegnata a vettore, non più dipinta** | L'icona è codice: `ios/scripts/make_app_icon.mjs` costruisce gli SVG (in `ios/icon/`) e da lì scrive i PNG dei cataloghi. Nitida a ogni misura, ogni modifica si rivede come differenza di testo, niente file a mano |
| D2 | **L'app: goccia nera con le onde, sfondo giallo** | Scelta di Michele (idea 1b della bacheca). La goccia è il «drop» di Mondrop, le onde sono il suono (un equalizzatore) ritagliato nel ventre della goccia: le barre mostrano il fondo giallo pulito, mai un'ombra sporca (c'è un test) |
| D3 | **iOS 18: tre versioni** | *Normale* (quella scelta), *scura* (goccia gialla su blu notte, se il telefono è in tema scuro) e *tinta* (grigia, la colora il sistema). **Mio default, non chiesto da Michele**: sono le tre che iOS 18 prevede e senza di esse il sistema scurisce l'icona normale per conto suo. Se non servono si tolgono due righe di `Contents.json` e i due file |
| D4 | **Foglio di condivisione** | La **stessa goccia con una freccia in giù** al posto delle onde («lascia qui»), stessi colori. **Mio default**: l'icona di prima (casa + velo + freccia) veniva dal dipinto e accanto alla nuova non starebbe. Michele aveva scelto la vecchia (variante «E2») il 7 novembre |
| D5 | **macOS** | Come prima: tessera arrotondata di 824 px con ombra morbida su 1024 trasparente, dieci tagli (16, 32, 128, 256 e 512 pt a 1× e 2×) |
| D6 | **«home-ass» è l'app TV Casamon** | Lo deduco da `casamon-tv/docs/roadmap.md` §4: l'icona dell'app TV è la «gemella di casa-lanterna di Mondrop nei colori di HA» e Home Assistant è il suo cuore. La gemella nuova è **la casa gialla con le onde su azzurro** (idea 2c): la stessa costruzione, la casa al posto della goccia, il blu al posto del giallo. Vive nello stesso script (`--house <cartella>`) così le due icone restano parenti. **Non fa parte dell'app Mondrop** |
| D7 | **La gemella è installata nell'altro repo** | L'8 novembre il sistema mi ha prima negato la sovrascrittura dei due PNG tracciati di `casamon-tv` e non l'ho aggirata; ho chiesto a Michele, che ha risposto di sì («Sì, installala tu»). Copiati: `apps/tv-webos/shell/icon.png` (80 px) e `largeIcon.png` (130 px), più `docs/art/icon/casamon-tv-icon-v2.svg` e `-1024.png`. **Nessun commit** in quel repo e nessun suo documento toccato (c'è una sessione «home-ass» che ci lavora): `git checkout -- apps/tv-webos/shell` ripristina i due PNG |
| D8 | **Una sola app sulla TV, la stessa di prima: cambia solo l'icona** *(risposta di Michele)* | L'app resta `dev.casamon.tv`, titolo «Casamon»: **nessuna seconda app**, nessun nuovo `appinfo.json`. Cambiano **solo** `icon.png` (80 px) e `largeIcon.png` (130 px), più il sorgente d'arte in `docs/art/icon/`. Niente altro: né `splash.png`, né colori o titolo in `appinfo.json`, né documenti dell'altro repo, a meno che Michele non lo chieda |

## 4. Le prove che Michele ha visto

Quattro idee, ognuna scura / gialla / blu (il colore d'accento dell'app, `AccentColor` = 0.20 0.45 0.98): **1 goccia e onde**, **2 casa e onde**, 3 goccia sull'acqua (cerchi che si allargano), 4 goccia e play. Scelte: la 1 gialla per Mondrop, la 2 blu per «home-ass». Scartate perché dicono «acqua» più che «musica» (3) o perché il play è già nel player (4). Una prima versione «casa con la goccia dentro» sembrava il sensore di una perdita d'acqua e fu tolta prima della bacheca.

## 5. La gemella per l'app TV Casamon

File (casa gialla con le onde su azzurro, RGB senza alpha come i vecchi): `house.svg`, `house-1024.png`, `house-130.png`, `house-80.png`. Si rifanno con `node ios/scripts/make_app_icon.mjs --house <cartella>`. **Installati** (D7); se si deve rifare, come dice `casamon-tv/docs/roadmap.md` §4 (80 e 130 px in `apps/tv-webos/shell/`):

```
cp house-80.png  ~/works/casamon-tv/apps/tv-webos/shell/icon.png
cp house-130.png ~/works/casamon-tv/apps/tv-webos/shell/largeIcon.png
cp house.svg     ~/works/casamon-tv/docs/art/icon/casamon-tv-icon-v2.svg
cp house-1024.png ~/works/casamon-tv/docs/art/icon/casamon-tv-icon-v2-1024.png
```

**Non toccato nell'altro repo, per decisione di Michele (D8):** `appinfo.json` (id, titolo, colori), `splash.png` (ha ancora il dipinto) e i documenti di quel repo (la roadmap §4 e il `CHANGELOG` parlano ancora della gemella dipinta con i tratti bianchi del logo di HA: li aggiorna, se serve, la sessione che ci lavora).

## 6. Test

- `ios/scripts/make_app_icon.test.mjs` (`node --test`, nove prove): l'arte è vettore puro (1024, niente testo né immagini dentro); le immagini iOS sono PNG 1024 **RGB senza alpha**; **un buco è pulito** (la barra mostra lo stesso pixel del fondo: la prima bozza sporcava le onde con l'ombra, provato anche a rompere il codice di proposito); la goccia è nera sul giallo e gialla sullo scuro; il catalogo elenca scuro e tinta solo se ci sono, più i dieci tagli macOS; un catalogo scritto è completo con le misure dichiarate; la tessera macOS ha gli angoli trasparenti e l'ombra; gli SVG di `ios/icon/` sono **quelli che lo script disegna** (nessuno li ha toccati a mano); i cataloghi committati sono validi.
- `MondropTests/AppIconAssetsTests.swift`: sull'app, legge i PNG committati (intestazione IHDR): tre versioni 1024 senza alpha per l'app, una per il foglio di condivisione, i dieci tagli macOS di entrambi alla misura giusta e con alpha. Fa fallire la build se qualcuno mette nel catalogo un'icona con trasparenza, che App Store Connect rifiuta solo al caricamento.
- A mano: l'icona vista sul telefono dopo l'installazione (Home, Impostazioni, notifica, tema scuro).

## 7. Domande per Michele

1. «home-ass» è l'app TV **Casamon**? (la mia deduzione, D6; **confermata** dal nome della sessione di Claude Code che lavora in `casamon-tv`, che si chiama «home-ass», e da Michele con «Sì, installala tu»).
2. ~~Le due versioni iOS 18 (scura e tinta) e l'icona del foglio di condivisione con la freccia vanno bene? (D3 e D4: miei default.)~~ Risposta di Michele (8 novembre, dopo le anteprime): **«icona va bene»**. D3 e D4 confermate.
3. ~~Installo io la gemella nell'altro repo (D7)?~~ Risposta di Michele: «Sì, installala tu». Fatto.
