# Richiesta a Claude Code: Piano Evolutivo SoundReel → Mneme

## Istruzioni operative

**Non scrivere codice. Non modificare file. Non creare nuovi file nel progetto.**

Il tuo compito è esclusivamente di analisi e pianificazione. L'output atteso è un documento di piano evolutivo.

---

## Fase 1 — Esplora e mappa SoundReel (as-is)

Analizza l'intera codebase del progetto corrente. Per ogni area, descrivi cosa trovi realmente — non assumere nulla.

Documenta:

**Struttura del progetto**
- Targets presenti (app principale, extension, widget, altri)
- Organizzazione delle cartelle e dei file principali
- Dipendenze esterne (SPM packages, CocoaPods, o nessuna)

**Data layer**
- Come vengono persistiti i dati (CoreData, SwiftData, UserDefaults, file system, altro)
- Quali entità/modelli esistono e quali proprietà hanno
- Se esiste un App Group configurato e quale identifier usa

**Networking**
- Se esiste un layer di rete, come è strutturato
- Quali endpoint chiama (se presenti) e con quale autenticazione
- Come gestisce errori e stati offline

**Auth**
- Se esiste un meccanismo di autenticazione e di che tipo

**Share Extension**
- Se esiste una Share Extension, cosa accetta (UTTypes dichiarati nell'Info.plist)
- Come comunica con l'app principale (App Group, Darwin notifications, altro)
- Cosa fa con il contenuto ricevuto

**UI e navigazione**
- Struttura di navigazione (TabView, NavigationStack, altro)
- Schermate principali e loro responsabilità
- Design system o componenti riusabili presenti

**Test**
- Se esistono test (unit, UI, integration) e cosa coprono

---

## Fase 2 — Descrivi il target: Mneme

Mneme è un personal knowledge vault con queste caratteristiche:

**Capture universale**
- Share Extension che accetta qualsiasi tipo di contenuto: URL, testo selezionato, immagini, file, audio
- Input da Telegram bot (canale alternativo da desktop)
- Input manuale dall'app

**Data model centrale: Memo**
- Ogni item salvato è un Memo con: id, user_id, source, content_type, raw_url, raw_text, raw_file_path, title, summary, tags, collection_id, note, status (pending → synced → indexed → error)

**Backend on-prem (Mac Mini M4)**
- FastAPI + PostgreSQL + pgvector
- Pipeline asincrona: estrazione testo → summarization → tagging → embedding (tutti via Ollama, nessun LLM SaaS)
- Modelli: nomic-embed-text per embedding, llama3.1:8b per RAG e summarization

**Auth multi-utente familiare**
- JWT homemade, nessun OAuth esterno
- Token conservato in Keychain
- Multi-utente con isolamento dati per famiglia

**App iOS: 3 tab**
- Feed: tutti i memo con filtri per tipo, stato shimmer per pending
- Collections: struttura ad albero (max 2 livelli)
- Ask Mneme: chat RAG con citazioni ai memo sorgente

**Sync offline-first**
- I memo creati offline vengono accodati localmente
- Sync automatico al ritorno della connessione (Background URLSession)

---

## Fase 3 — Produci il Piano Evolutivo

Sulla base di quello che hai trovato nella Fase 1 e del target descritto nella Fase 2, produci un documento strutturato con:

### 3a. Delta Analysis
Per ogni componente trovato in SoundReel, classificalo in una di queste categorie e motiva la scelta:

- **RIUTILIZZATO** — funziona as-is o con modifiche minime di configurazione
- **ESTESO** — la struttura è riusabile ma va generalizzata o ampliata
- **SOSTITUITO** — va riscritto perché incompatibile con il target
- **ELIMINATO** — specifico per la logica attuale, non serve in Mneme
- **NUOVO** — non esiste nulla di equivalente in SoundReel

### 3b. Rischi e vincoli
Identifica i punti di attenzione reali basandoti sul codice che hai visto:
- Cosa potrebbe rompersi durante la migrazione
- Dipendenze hard-coded che limitano la generalizzazione
- Decisioni architetturali attuali che potrebbero essere difficili da invertire
- Eventuali debiti tecnici che conviene affrontare prima di evolvere

### 3c. Ordine di esecuzione consigliato
Proponi una sequenza di sprint o fasi con:
- Cosa fare in ogni fase
- Perché quell'ordine (dipendenze tra task)
- Quale deliverable verifica che la fase sia completata
- Stima di complessità relativa (bassa / media / alta) — non in giorni, ma in termini di rischio e dimensione del cambiamento

### 3d. Invarianti da preservare
Cosa non deve cambiare durante l'evoluzione (funzionalità utente, comportamenti critici, configurazioni di sistema) per evitare regressioni.

---

## Output atteso

Un singolo documento markdown chiamato `SOUNDREEL_TO_MNEME_EVOLUTION_PLAN.md` con le sezioni 3a, 3b, 3c, 3d popolate con dati reali tratti dall'analisi del codice.

Il documento deve essere leggibile da un architect esterno che non ha visto il codice — ogni affermazione deve essere tracciabile a qualcosa di concreto trovato nella codebase.

**Nessun codice nel documento. Solo analisi, classificazioni e piano.**
