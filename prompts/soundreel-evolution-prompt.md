# SoundReel — Prompt di Evoluzione v2.0

> Prompt per Claude Code — Febbraio 2026
> Riferimento: soundreel.md (documentazione v1.4.0)

---

## Contesto

SoundReel è una web app single-user (React 18 + Firebase) che analizza contenuti social per estrarre canzoni, film, note, link e tag. La documentazione completa dell'architettura, stack e pipeline è nel file `soundreel.md` nella root del progetto. **Leggilo per intero prima di iniziare qualsiasi modifica.**

Questo prompt descrive tre evoluzioni interconnesse da implementare in sequenza:

1. **Audio Transcript** — estrazione speech-to-text dal video, integrazione nella pipeline AI e nel modello dati
2. **GUI Redesign** — layout master-detail con entry inspector
3. **Entry Activity Explorer** — timeline delle azioni pipeline nel pannello inspector

---

## Epic 1 — Audio Transcript

### Obiettivo

Estrarre il testo parlato dai video analizzati (speech-to-text) e usarlo come input aggiuntivo per l'analisi AI, migliorando significativamente la qualità dei risultati.

### Scelta architetturale: Gemini come STT engine

Usa **Gemini 2.0 Flash** per la trascrizione. Il modello è già nello stack, supporta input audio/video nativi, e non introduce nuove dipendenze. Non aggiungere Whisper o Google Cloud Speech-to-Text.

### Modifiche Backend

#### 1. Nuovo step pipeline: `transcribeAudio`

Inserisci un nuovo step nella pipeline `analyzeUrl`, **dopo** l'estrazione contenuto (step 2) e **prima** dell'analisi AI (step 3):

```
Estrazione contenuto → Trascrizione audio → Analisi AI parallela (con transcript)
```

Implementazione:
- Se il video URL è disponibile (da Instagram API o cobalt), invia l'audio a Gemini con un prompt di trascrizione
- Prompt suggerito: `"Trascrivi fedelmente tutto il parlato presente in questo audio. Restituisci solo il testo trascritto, senza commenti o formattazione. Se non c'è parlato, rispondi con stringa vuota."`
- Salva il risultato in `results.transcript` (stringa, può essere vuota)
- Registra l'azione nell'`actionLog` con: tipo `transcribe`, esito (success/error/skipped), durata in ms

Guardrail:
- Se il video URL non è disponibile → skip con log `skipped: no audio source`
- Se la durata del video supera **5 minuti** (300 secondi) → skip con log `skipped: video too long`
- Se Gemini fallisce → la pipeline continua senza transcript (resilienza esistente)
- Timeout dedicato per la trascrizione: **60 secondi**

#### 2. Transcript come input per analisi AI

Modifica lo step di analisi Gemini (step 3) per includere il transcript:
- Aggiungi la variabile `{{transcript}}` al template Handlebars del prompt di analisi contenuto
- Se il transcript è disponibile, il prompt Gemini riceve: caption + thumbnail + transcript
- Se il transcript è vuoto o assente, il template deve funzionare identicamente a oggi (graceful degradation)
- Aggiorna la documentazione delle variabili disponibili nel prompt editor

#### 3. Modello dati Firestore

Aggiungi al documento `entries`:

```typescript
results: {
  // campi esistenti...
  transcript?: string;  // testo trascritto, opzionale
}
```

Nessuna migrazione necessaria — il campo è opzionale e le entry esistenti continuano a funzionare.

#### 4. Transcript nel bot Telegram

- Aggiungi `{{transcript}}` come variabile disponibile nel template Telegram
- Se presente, mostra il transcript troncato a **500 caratteri** con `...` se troncato
- Se assente, il messaggio non cambia

### Modifiche Frontend

La visualizzazione del transcript è coperta dall'Epic 2 (GUI Redesign). Non modificare le card attuali per il transcript — sarà integrato nel nuovo layout.

---

## Epic 2 — GUI Redesign: Layout Master-Detail

### Obiettivo

Ridisegnare la Home da feed verticale flat a layout master-detail, con card compatte a sinistra e pannello inspector a destra. Il nuovo layout supporta transcript, activity log, e risultati espansi senza sovraccaricare le card.

### Importante: approccio al design

- Tema chiaro Apple-style (mantieni il design language attuale)
- **Non aggiungere dark mode** in questa iterazione
- Layout responsive: master-detail su desktop, navigazione full-screen su mobile
- Usa le convenzioni CSS/styling già presenti nel progetto
- Animazioni subtle: transizioni per apertura/chiusura pannello, non decorative

### Layout Desktop (≥ 768px)

```
┌──────────────────────────────────────────────────────────┐
│  [Logo]  SoundReel          [Settings] [Prompts] [Console] │
├──────────────────────────────────────────────────────────┤
│  [ Incolla URL... ]                        [Analizza]    │
├────────────────────┬─────────────────────────────────────┤
│                    │                                     │
│   JOURNAL          │   ENTRY INSPECTOR                   │
│   (card compatte)  │                                     │
│                    │   Header: thumb, titolo, stato,     │
│   ┌──────────────┐ │           piattaforma, data         │
│   │ ● selected   │ │   Actions: Retry, DeepSearch,      │
│   │   card       │ │            Delete, Open Original    │
│   └──────────────┘ │                                     │
│   ┌──────────────┐ │   Summary                           │
│   │   card       │ │                                     │
│   └──────────────┘ │   Transcript (collapsible)          │
│   ┌──────────────┐ │                                     │
│   │   card       │ │   Results: Songs, Films, Notes,     │
│   └──────────────┘ │           Links, Tags               │
│   ┌──────────────┐ │                                     │
│   │   card       │ │   Enrichments                       │
│   └──────────────┘ │                                     │
│                    │   Activity Timeline                  │
│                    │                                     │
├────────────────────┴─────────────────────────────────────┤
```

Proporzioni: journal ~35%, inspector ~65%. Il journal è scrollabile indipendentemente dall'inspector.

### Layout Mobile (< 768px)

- La Home mostra solo il journal (feed verticale di card compatte)
- Click su una card → navigazione full-screen al pannello inspector con back button
- Il back button torna al journal mantenendo la scroll position

### Card compatta (pannello journal)

Ogni card nel journal mostra:

```
┌─────────────────────────────────────┐
│ [thumbnail]  Platform     2h ago    │
│ 50x50       "Summary text troncato  │
│  round       a una riga..."         │
│              🎵 2  🎬 1  📝 3  💬   │
│              ● completed            │
└─────────────────────────────────────┘
```

- Thumbnail: 50x50 rounded
- Platform: icona o testo della piattaforma sorgente
- Tempo relativo (2h ago, yesterday, etc.)
- Summary troncato a una riga
- Icone conteggio: 🎵 songs, 🎬 films, 📝 notes, 💬 presente solo se c'è transcript
- Badge stato: `processing` (animato), `completed`, `error`
- Card selezionata: bordo o sfondo accent per indicare quale entry è nell'inspector
- Entry in stato `processing`: le icone conteggio si aggiornano in tempo reale

### Pannello Inspector

Sezioni verticali scrollabili (non tab):

#### Header
- Thumbnail grande (se disponibile)
- Titolo/caption (prime 2 righe)
- Badge piattaforma + badge stato
- Data completa
- Link all'URL originale (apre in nuovo tab)
- **Pulsanti azione**: Retry (↻), Deep Search (🔍), Delete (🗑), copia URL

#### Summary
- Il riassunto AI di 1-2 frasi
- Sempre visibile, non collassabile

#### Transcript
- Testo trascritto completo
- **Collassabile**: mostra preview di 3 righe, click per espandere
- Se non disponibile: **sezione non renderizzata** (nessun placeholder)
- Badge lingua se rilevabile

#### Results
Ogni sottosezione è presente solo se ha contenuti:

**Songs** — per ogni canzone: titolo, artista, artwork Spotify (se trovata), link Spotify, link YouTube. Indicazione della fonte (audio fingerprint, Instagram metadata, AI caption, AI transcript).

**Films** — per ogni film: titolo, anno, regista, poster TMDb (se trovato), link IMDb.

**Notes** — raggruppate per categoria (luoghi, eventi, brand, libri, prodotti, citazioni, persone). Ogni categoria è un blocchetto con label.

**Links** — lista di URL estratti, cliccabili.

**Tags** — hashtag e menzioni come chip/badge inline.

#### Enrichments
- Risultati deep search, se presenti
- Raggruppati per tipo (video musicali, Wikipedia, siti ufficiali, trailer)
- Se non presenti e deep search non eseguita: pulsante "Esegui Deep Search" inline

#### Activity Timeline (Epic 3)
- Vedi sezione Epic 3 sotto

### Stato iniziale

All'apertura della Home, se non c'è nessuna entry selezionata, il pannello inspector mostra un placeholder con:
- Icona/illustrazione minimal
- Testo: "Seleziona un'entry per esplorare i dettagli"

### Real-time updates

Mantieni il pattern `onSnapshot` esistente:
- Nuove entry appaiono in cima al journal
- Se l'entry selezionata è in `processing`, l'inspector si aggiorna in tempo reale
- L'activity timeline si popola step by step durante l'analisi

---

## Epic 3 — Entry Activity Explorer (Timeline)

### Obiettivo

Mostrare la cronologia di tutti gli step della pipeline eseguiti su una entry, direttamente nel pannello inspector.

### Posizione nella GUI

Ultima sezione del pannello inspector, dopo Enrichments. Sempre presente per ogni entry (anche in stato `processing`).

### Struttura timeline

Timeline verticale, ogni nodo è uno step:

```
  ✓  Estrazione contenuto          0.8s
  │   Instagram API (cookie auth)
  │
  ✓  Trascrizione audio            3.2s
  │   Gemini STT — 45 parole
  │
  ✓  Analisi AI (Gemini)           2.1s
  │   3 songs, 1 film, 5 notes
  │
  ✗  Audio fingerprint (AudD)      1.5s
  │   Error: rate limit exceeded
  │   [Espandi dettaglio ▼]
  │
  ✓  Spotify lookup                0.4s
  │   2/3 tracce trovate
  │
  ✓  TMDb lookup                   0.3s
  │   1/1 film trovato
  │
  ⏭  Enrichment                    —
     Non eseguito
```

### Regole di rendering

- **Icone stato**: ✓ verde (successo), ✗ rosso (errore), ⏭ grigio (skippato), ⟳ blu animato (in corso)
- **Nome operazione**: leggibile, non il nome tecnico della funzione. Mappa `actionLog.type` a label leggibili
- **Sottotitolo**: breve descrizione del risultato o dell'errore
- **Durata**: in secondi, allineata a destra
- **Dettaglio espandibile** (solo per errori o su richiesta): blocco con dati JSON formattati, messaggio di errore completo, stack trace se presente. Pulsante "Copia JSON" nella clipboard
- **Dati sensibili**: maschera token, cookie, API key nei dettagli espandibili. Pattern: sostituisci tutto tranne i primi 4 e ultimi 4 caratteri con `***`

### Mapping actionLog → Timeline

Il rendering della timeline legge `entry.actionLog[]` e mappa ogni elemento. Se l'actionLog non contiene un campo `duration`, calcola la durata dalla differenza tra timestamp consecutivi. Se un tipo di azione non è nel mapping, mostra il tipo raw come fallback.

### Real-time durante processing

Se l'entry è in stato `processing` e l'inspector è aperto su quella entry:
- I nuovi step appaiono nella timeline man mano che vengono registrati nell'actionLog
- Lo step corrente mostra l'icona ⟳ animata
- Al completamento dello step, l'icona cambia a ✓ o ✗ con animazione

---

## Note implementative generali

### Ordine di implementazione

1. **Epic 1 (Transcript)** — backend first, poi template Telegram. Non toccare il frontend.
2. **Epic 2 (GUI Redesign)** — redesign completo della Home con il nuovo layout. Includi la sezione transcript.
3. **Epic 3 (Activity Timeline)** — aggiungi la sezione timeline nell'inspector già costruito in Epic 2.

### Testing

- Dopo ogni Epic, verifica con `npm run build` sia in `frontend/` che in `functions/`
- Testa la pipeline con un URL Instagram (con cookie configurati) per verificare il transcript
- Testa il layout su viewport desktop (1440px) e mobile (375px)
- Verifica che le entry esistenti (senza transcript) renderizzino correttamente

### Cosa NON fare

- Non aggiungere dark mode
- Non cambiare lo stack tecnologico (no Tailwind se non già presente, no nuove librerie UI)
- Non modificare le Cloud Functions esistenti tranne dove esplicitamente indicato
- Non creare nuove collection Firestore — il transcript va in `results.transcript`
- Non modificare il flusso OAuth Spotify
- Non toccare la pagina Settings, Prompts o Console (tranne aggiornare le variabili disponibili nei prompt)

### File di riferimento

Leggi `soundreel.md` per l'architettura completa. Rispetta le convenzioni di naming, struttura cartelle e pattern già presenti nel codice.
