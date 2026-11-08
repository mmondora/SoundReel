# Il Player di Mondrop su iPad: colori e spazi (richiesta 2026-11-08)

Stato: **costruita** (Mondrop 1.7.0, build 9). Solo interfaccia: nessuna ADR (le regole d'interfaccia stanno nella spec).
Codice: `ios/MondropKit/PlayerStyle.swift` (colori e geometria, numeri puri), `ios/Mondrop/WinampPlayerView.swift`, prove `ios/MondropTests/PlayerStyleTests.swift`.

## 1. Richiesta di Michele (testuale)

Con una schermata dell'iPad:

> «Questa la home su ipad - colori sbagliati e spazi da rivedere»

## 2. Cosa non andava (visto nella schermata e riprodotto l'8 novembre nel simulatore, iPad Air 11" in modo chiaro)

- **Colori.** Lo sfondo del Player è **sempre scuro** (un gradiente), ma il testo prendeva i colori dinamici del sistema, che in modo chiaro sono **neri**: titolo, artista, tempi e icone del trasporto erano neri su blu-verde scuro, quasi invisibili. I pulsanti «Parole» e «In coda» erano blu su grigio chiaro, il tasto play verde, la traccia dello slider invisibile: **tre accenti diversi (verde, blu, nero), nessuno è il giallo della nuova icona**.
- **Spazi.** Su iPad la **cover era un rettangolo alto** (320 × 650 pt invece di un quadrato: un `frame(maxWidth:)` messo prima di un `aspectRatio` lascia libera l'altezza), lo slider correva da bordo a bordo sotto una colonna stretta, tutto era appeso in cima a uno schermo alto e i pulsanti stavano uno sotto l'altro con distanze diverse. Sull'iPhone lo slider e i tempi toccavano i bordi.
- **Forme dei pulsanti.** Nella schermata di Michele i pulsanti hanno un secondo riquadro grigio dietro (l'impostazione di Accessibilità «Forme dei pulsanti» disegna una forma dietro ogni pulsante: nel simulatore senza l'impostazione non si vede): i pulsanti ora disegnano **una forma sola** da sé.

## 3. Decisioni prese con valori di default (da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| D1 | **Il Player è scuro per costruzione** | Ogni colore del Player viene da **una tavolozza** (`PlayerPalette`), mai dai colori dinamici del sistema, e i controlli sono avvisati di disegnarsi scuri (la traccia dello slider si vede). Uguale in modo chiaro e scuro |
| D2 | **L'accento è il giallo dell'icona** | Giallo Mondrop al posto di verde e blu: la scritta MONDROP, il tasto play, lo slider, le icone dei pulsanti. Lo sfondo è il blu notte → quasi nero della versione scura dell'icona. Testo bianco; il secondario bianco al 72 % |
| D3 | **Una colonna al centro** | Larga al massimo **560 pt** su iPad (480 su iPhone), centrata anche in verticale: lo slider e i pulsanti non corrono più da bordo a bordo; margini di 24 / 32 pt |
| D4 | **La cover è un quadrato vero** | Il lato lo chiede il riquadro stesso: fino a un terzo dell'altezza, al massimo 440 pt (iPad) o 340 (iPhone), mai meno di 160. Coda vuota: una nota musicale invece di una lettera |
| D5 | **Ritmo verticale** | Distanze fra i gruppi (cover, titoli, slider, controlli, pulsanti) di 28 pt su iPad e 18 su iPhone; titolo grande su iPad |
| D6 | **Pulsanti** | Trasporto «semplice» (nessuna forma del sistema), **Parole** e **In coda** come due pillole bianche trasparenti con un filo di bordo, **affiancate** se c'è posto e una sotto l'altra se no. Ogni pulsante ha il suo nome per VoiceOver (prima le icone non ne avevano) |
| D7 | **Il resto dell'app non cambia** | Le altre schede restano con i colori del sistema e l'accento blu (`AccentColor`); la barra delle schede è del sistema |

## 4. Test

`PlayerStyleTests` (12): il rapporto di contrasto WCAG calcolato (testo ≥ 7 sui due estremi dello sfondo, secondario ≥ 4,5, accento ≥ 7, errore ≥ 4,5, testo sulla pillola ≥ 4,5 e le sue icone ≥ 3); lo sfondo è scuro e l'accento è il giallo; la geometria per iPad in verticale (colonna 560, cover 378) e in orizzontale (252), iPhone (cover 243, margini 24), mai sotto 160 né sopra 440; una **scansione dei sorgenti** fa fallire la build se il Player torna a usare colori di sistema (`.primary`, `.secondary`, `Color.red`, materiali), se perde `colorScheme .dark` o se la cover torna a un `aspectRatio` dopo un `frame(maxWidth:)`. Verificato **a occhio** nel simulatore (iPad Air 11" e iPhone 17e, modo chiaro e scuro): `scratchpad/ipad/`.

## 5. Domande per Michele

1. **L'accento giallo anche nel resto dell'app?** Oggi le altre schede e la barra delle schede restano blu (D7). Il giallo ci starebbe bene in modo scuro; in modo chiaro servirebbe un ambra più scuro per il testo. È una scelta di marchio: dimmi se la vuoi.
2. Le «Forme dei pulsanti» (D6): era acceso sul tuo iPad (Impostazioni → Accessibilità → Schermo e dimensioni testo)? Se sì, il Player ora non ne ha un secondo riquadro.
