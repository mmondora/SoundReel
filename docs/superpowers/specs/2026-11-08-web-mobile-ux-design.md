# Il sito web usabile da telefono — gui/ux mobile (roadmap)

- **Data:** 2026-11-08
- **Stato:** **Richiesta registrata, in roadmap.** Nessuna versione assegnata e niente ancora progettato: questa spec raccoglie la richiesta, la base misurata sul codice e le regole di lavoro che propongo. Sono regole d'interfaccia, quindi **nessun ADR**
- **Owner:** Michele
- **Correlati:** `2026-11-07-web-player-ux-design.md` (regole W1–W8 del player), `2026-11-08-player-selection-and-filters-design.md` (il pannello «Scegli cosa suonare» nasce già a misura di telefono)

## 1. Richiesta di Michele (testuale)

«Altra cosa da mettere a roadmap è la gui/ux del sito web. Su mobile e telefono è inusabile.»

## 2. Come la leggo (da confermare con Michele)

Il sito va usato **dal telefono** almeno quanto dal computer: ogni pagina leggibile e comandabile con un pollice, senza zoom e senza scroll orizzontale. Non è una riscrittura dello stack né una nuova grafica del desktop: è un lavoro di progettazione **mobile-first, pagina per pagina**, che parte da un audit sul telefono vero.

## 3. Base di partenza (misurata sul codice il 2026-11-08; l'audit sul telefono la completerà)

- Il tag `viewport` c'è, ma il sito è nato per il desktop. Fogli di stile: `index.css` 5.192 righe e 12 `@media`; `player.css` 1.157 / 7; **`manager.css` 999 righe e 1 solo `@media`**; `library.css` 439 / 2; `stats.css` 377 / 3.
- Il **Playlist manager** è a due pannelli in stile Norton Commander, comandato con Tab, F-tasti, Ins, `+` `-` `*`: sul telefono questi tasti non esistono.
- **Testo piccolo:** oltre 100 regole usano caratteri tra 0,6 e 0,7 rem (9,6–11,2 px), sotto la soglia di leggibilità abituale (Apple indica almeno 11 pt).
- **Larghezze minime che a 390 px possono forzare lo scroll orizzontale:** `stats.css` `min-width: 520px`, `index.css` `min-width: 300px`, più vari 180–220 px (da verificare uno per uno).
- **15 pagine:** Home, Voci, Canzoni, Player, Playlist manager, Statistiche, Film, Note, Software, Libreria, Licenze, Impostazioni, Prompt, Console, Admin.

### Primi difetti misurati (browser headless, 390×844 e 360×800, contro un'API simulata, 2026-11-08)

Li ha annotati chi ha costruito «Scegli cosa suonare» sulle pagine che ha dovuto toccare; **non** sostituiscono l'audit sul telefono vero (niente Safari, niente safe-area reale). Player e mini player, dopo i ritocchi della 2.9.0, non hanno difetti a 390 e 360 px.

- **Playlist manager, bersagli sotto 44 px:** chip dei filtri (circa 1.330 nel DOM, alti ~28 px, compresi i chip «Anni»), righe dei brani (~30 px), bottoni F, schede dei pannelli ed etichette radio.
- **Playlist manager, contenuto tagliato:** artista e titolo, la barra dei tasti F e alcuni chip escono dal bordo destro e vengono **tagliati, non scorrono**. La pagina non scorre di lato.
- **Playlist manager, testo sotto 12 px:** etichetta del pannello 10,6 px, testo e conteggio dei chip 11,5 px, suggerimenti 11,5 px, legenda dei filtri 10,6 px, tasti `kbd` 11,2 px.
- **Intestazione:** i 7 link di navigazione sono più bassi di 44 px e il nome dell'utente è a 10,4 px.
- **Mini player:** nessun margine in basso per la safe-area, quindi sta sotto la barra home.

## 4. Decisioni prese con valori di default (da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| M1 | **Metodo** | Prima un **audit sul telefono vero** (Safari su iPhone di Michele, più 390×844 e 360×800 simulati) con schermate e un elenco di difetti per pagina, uno per riga con la gravità. Poi si sistema **in ordine d'uso**: Player + «Scegli cosa suonare», Home, Canzoni e Playlist manager, Impostazioni, il resto |
| M2 | **Principi** | Si parte dal telefono e il desktop si espande. Una colonna. Bersagli di tocco ≥ 44×44 pt. Campi di testo a 16 px (iOS non zooma da solo). Testo normale ≥ 12 px. **Mai scroll orizzontale:** le tabelle diventano liste a schede o hanno uno scroll interno dichiarato. Rispetto di notch e barra home (safe-area, `100dvh`). Solo tema scuro. Nessuna libreria UI pesante (regola del progetto) |
| M3 | **Navigazione** | Barra in basso, raggiungibile col pollice, con le 4–5 pagine d'uso (Player, Canzoni, Cerca, Home, Altro); le pagine rare (Prompt, Console, Admin, Licenze…) stanno sotto «Altro» |
| M4 | **Playlist manager** | Su telefono **un pannello alla volta** (Libreria ↔ Playlist con schede in alto), le azioni in un foglio «Azioni» al posto dei tasti F, selezione multipla con pressione lunga. **La tastiera completa resta su desktop**, non si tocca |
| M5 | **Player** | Copertina o video grandi, comandi grandi, coda in un foglio scorrevole, «Scegli cosa suonare» come foglio a tutta altezza. Nota: l'ascolto a schermo bloccato non è un obiettivo del web (YouTube e Safari lo limitano): per quello esiste Mondrop |
| M6 | **Pagine «solo desktop»** | Se una pagina non ha senso su telefono (es. Console, Admin) può restare com'è con un avviso, **purché Michele lo confermi**: la scelta è sua |
| M7 | **Come si prova il layout** | I test di Vitest/jsdom non misurano il layout. Default: uno script di audit con browser headless che misura per ogni pagina `scrollWidth ≤ innerWidth`, i bersagli di tocco sotto 44 px e il testo sotto 12 px, lanciato a mano (non in CI), più test jsdom per la logica (es. quale pannello è visibile). Un browser di test come dipendenza di sviluppo va confermato |

## 5. Criteri di accettazione

- Su tutte le pagine che restano in scope, a 390×844 e a 360×800: **nessuno scroll orizzontale**, nessun comando principale sotto 44 px, nessun testo sotto 12 px (tranne etichette secondarie dichiarate), nulla coperto da notch o barra home.
- Sul telefono di Michele, **senza zoom e senza scroll orizzontale**: trovare e suonare un brano, scegliere un album, aggiungere un brano a una playlist, mandare un link da analizzare, vedere le statistiche.
- Il desktop non peggiora (stessi test, stessa tastiera nel Playlist manager).

## 6. Fuori scopo

Un'app nativa per tutto (Mondrop copre l'ascolto offline); una nuova grafica del desktop; il cambio di stack.

## 7. Domande aperte per Michele

1. Quali sono le 3 cose che fai più spesso dal telefono sul sito?
2. Quali pagine non ti servono sul telefono (restano «solo desktop» con un avviso)?
3. Barra in basso o menu in alto?
