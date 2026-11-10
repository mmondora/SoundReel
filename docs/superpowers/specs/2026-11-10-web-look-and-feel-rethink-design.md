# Il look & feel del sito: ripensarlo, con meno spazio vuoto ai lati (richiesta 2026-11-10)

Stato: **richiesta registrata, non ancora progettata né costruita.** Michele ha detto di **finire prima le attività in corso** (le tre correzioni alle playlist automatiche, 2.20.2); questa si fa dopo, con una proposta da guardare prima di costruire. Solo interfaccia: nessun ADR.

## 1. Richiesta di Michele (testuale)

10 novembre, mentre guardava la pagina Canzoni con l'elenco delle playlist:

> «non mi piace il l&f generico, con molto spazio libero ai fianchi della pagina principale. dovremmo ripensarlo. ma ora finisci le attività»

Letta così (lettura mia, da correggere): **(1)** l'aspetto del sito oggi gli sembra **generico**; **(2)** il difetto che nomina è lo **spazio vuoto ai lati** del contenuto, che sta in una colonna stretta in mezzo allo schermo; **(3)** vuole **ripensarlo** (non ritoccarlo), insieme; **(4)** non adesso: prima si finiscono le attività aperte.

## 2. Cosa c'è oggi (misurato il 10 novembre, dal CSS e da uno screenshot a 1280 px)

- La testata (`.header-content`, `.sr-header-inner`) è larga fino a **1200 px**; il contenuto delle pagine no: `.list-page-content` (Canzoni, Film, Note…) **800 px**, `.main-content` **900 px**, la pagina Link (`.list-page--library`) **820 px**, le impostazioni 900 px; il gestore delle playlist arriva a 1560 px.
- A 1280 px di schermo la pagina Canzoni occupa circa 750 px al centro: **più di 250 px vuoti per lato**, mentre la testata è più larga del contenuto. Su schermi grandi (1920) i lati vuoti sono più di 500 px.
- Tema scuro unico (regola del progetto), niente libreria di componenti, CSS semplice.

## 3. Come si affronta (proposta di metodo, non ancora il disegno)

1. Una sessione di **brainstorming con mockup da guardare** (non parole): due o tre impostazioni diverse della pagina larga, sullo stesso contenuto vero (la pagina Canzoni con 60 playlist, il Journal, il Player), scelte da Michele.
2. Le direzioni da mettere a confronto, da affinare: contenuto che **usa la larghezza** (lista a sinistra e dettaglio o filtri a destra, come una posta elettronica), **griglia di schede** al posto di una colonna sola, **barra laterale** fissa con le sezioni (oggi nella testata) e le playlist, oppure un **cruscotto** con più colonne per tipo (canzoni, film, software, note).
3. Vale **anche sul telefono** (la spec `2026-11-08-web-mobile-ux-design.md` è ancora da fare): un solo ripensamento che regga schermo largo e stretto, non due.
4. Le regole che restano: tema scuro unico, niente dipendenze pesanti, le pagine continuano a parlare solo con il server (regola P).

## 4. Domande aperte per Michele (per quando si comincia)

- Quali pagine contano di più per lui, oggi? (l'ordine d'uso decide dove lavorare per prima.)
- «Generico»: c'è un sito o un'app che gli piace, da cui prendere il tono? (anche Mondrop, che è già giallo su nero.)
- Vuole che il Player diventi la pagina principale, o resta una pagina tra le altre?
