# Addendum: Gestione Prompt Templates

## Contesto

Aggiungere a SoundReel la possibilità di **visualizzare e modificare i prompt AI** direttamente dal frontend, senza dover fare redeploy. I prompt sono configurazione, non codice.

## Requisiti

### 1. Nuovo documento Firestore: `config/prompts`

Struttura:

```json
{
  "contentAnalysis": {
    "name": "Analisi contenuto (Gemini)",
    "description": "Prompt per estrarre canzoni e film da caption e thumbnail",
    "template": "Analizza questo contenuto proveniente da un post social...",
    "variables": ["caption", "hasImage"],
    "updatedAt": "2025-01-31T10:00:00Z"
  },
  "telegramResponse": {
    "name": "Risposta Telegram",
    "description": "Template per la risposta del bot dopo l'analisi",
    "template": "🎵 SoundReel ha analizzato il tuo link!\n\n{{#songs}}🎶 Canzoni trovate:\n{{#each songs}}• {{title}} — {{artist}}{{#if addedToPlaylist}} ✓{{/if}}\n{{/each}}{{/songs}}...",
    "variables": ["songs", "films", "frontendUrl"],
    "updatedAt": "2025-01-31T10:00:00Z"
  }
}
```

### 2. Nuova pagina frontend: `/prompts`

Layout:

1. **Lista prompt** (sidebar o cards): nome + descrizione breve per ogni template
2. **Editor** (area principale):
   - Nome e descrizione (editabili)
   - Textarea grande per il template (monospace font, syntax highlighting opzionale)
   - Lista variabili disponibili (read-only, informativo)
   - Bottone "Salva"
   - Bottone "Ripristina default"
   - Timestamp ultimo aggiornamento

3. **Preview** (opzionale ma utile):
   - Mostra il prompt renderizzato con dati di esempio
   - Permette di testare prima di salvare

### 3. Cloud Function: `updatePrompt`

Endpoint per salvare i prompt modificati:

```
POST /updatePrompt
Body: { promptId: "contentAnalysis", template: "...", name: "...", description: "..." }
```

- Valida che `promptId` sia uno dei prompt conosciuti
- Aggiorna il documento `config/prompts` in Firestore
- Logga la modifica (chi, quando, diff se possibile)

### 4. Modifica alla pipeline `analyzeUrl`

La Cloud Function `analyzeUrl` deve:

1. Leggere il prompt da `config/prompts` invece di averlo hardcodato
2. Cacheare in memoria per evitare una lettura Firestore ad ogni richiesta (cache con TTL 5 minuti)
3. Interpolare le variabili nel template (usa una libreria semplice tipo `handlebars` o fai replace manuale)

### 5. Prompt di default

Se `config/prompts` non esiste o un prompt specifico manca, usare i default hardcodati nel codice. Il documento Firestore viene creato automaticamente al primo salvataggio da UI.

Default per `contentAnalysis`:

```
Analizza questo contenuto proveniente da un post social e identifica tutte le menzioni di canzoni e film/serie TV.

Per le CANZONI cerca: musica in sottofondo, canzoni citate nel testo, artisti menzionati, album o tracce specifiche.
Per i FILM/SERIE cerca: titoli di film o serie TV, scene o citazioni riconoscibili, registi o attori menzionati.

Caption del post:
"{{caption}}"

{{#if hasImage}}[Thumbnail del post allegata come immagine]{{/if}}

Rispondi ESCLUSIVAMENTE con JSON valido, senza markdown, senza commenti, senza altro testo:
{
  "songs": [
    { "title": "nome canzone", "artist": "artista", "album": "album o null" }
  ],
  "films": [
    { "title": "titolo", "director": "regista o null", "year": "anno o null" }
  ]
}

Se non trovi nulla, rispondi: { "songs": [], "films": [] }
```

Default per `telegramResponse`:

```
🎵 SoundReel ha analizzato il tuo link!

{{#if songs.length}}
🎶 Canzoni trovate:
{{#each songs}}
• {{title}} — {{artist}}{{#if album}} ({{album}}){{/if}}{{#if addedToPlaylist}} ✓ Aggiunta alla playlist{{/if}}
{{/each}}
{{/if}}

{{#if films.length}}
🎬 Film trovati:
{{#each films}}
• {{title}}{{#if year}} ({{year}}){{/if}}{{#if director}} — {{director}}{{/if}}
{{/each}}
{{/if}}

{{#unless songs.length}}{{#unless films.length}}
❌ Nessuna canzone o film identificato in questo contenuto.
{{/unless}}{{/unless}}

📋 Dettagli: {{frontendUrl}}
```

### 6. Navigazione

Aggiungere link a `/prompts` nel header o nella pagina Settings. Label: "Prompt Templates" o "Configurazione AI".

### 7. Sicurezza

L'endpoint `updatePrompt` deve essere protetto con lo stesso `API_SECRET` usato per gli altri endpoint. La pagina `/prompts` è accessibile solo a te (single user, nessuna auth aggiuntiva necessaria).

---

## Struttura file da creare/modificare

### Nuovi file frontend:
- `src/pages/Prompts.tsx` — pagina gestione prompt
- `src/components/PromptEditor.tsx` — editor singolo prompt
- `src/components/PromptPreview.tsx` — preview opzionale

### Nuovi file functions:
- `src/updatePrompt.ts` — Cloud Function per salvare
- `src/services/promptLoader.ts` — carica prompt con cache

### File da modificare:
- `src/App.tsx` — aggiungere route `/prompts`
- `src/components/Header.tsx` — aggiungere link navigazione
- `src/services/aiAnalysis.ts` — usare `promptLoader` invece di prompt hardcodato
- `src/telegramWebhook.ts` — usare template per la risposta

---

## Note implementative

- Per il templating usa `handlebars` (leggero, supporta `#if`, `#each`, `#unless`) oppure una soluzione custom con regex se vuoi zero dipendenze
- L'editor può essere una semplice `<textarea>` — non serve un code editor complesso
- La preview è un nice-to-have: se la implementi, usa dati mock fissi per renderizzare il template
