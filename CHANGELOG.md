# Changelog

Tutte le modifiche rilevanti a SoundReel sono documentate in questo file.

## [1.3.0] - 2026-01-31

### Novità
- **Internazionalizzazione (i18n)**: Supporto completo per Italiano e Inglese
  - Selettore lingua nelle Impostazioni
  - Default automatico basato sulla lingua del browser
  - Persistenza della preferenza in localStorage

### Miglioramenti
- Tutte le label UI ora localizzate
- Date e orari formattati secondo la lingua selezionata
- Messaggi di errore e successo localizzati
- Tooltip e placeholder tradotti

### Modifiche Tecniche
- Nuovo sistema i18n basato su React Context
- File `translations.ts` con tutte le stringhe
- Hook `useLanguage()` per accedere alle traduzioni
- Funzione `interpolate()` per stringhe parametriche

---

## [1.2.0] - 2026-01-31

### Novità
- **Supporto multi-piattaforma**: L'app ora funziona con qualsiasi social network
  - Instagram, TikTok, YouTube, Facebook, Twitter/X
  - Threads, Snapchat, Pinterest, LinkedIn, Reddit
  - Vimeo, Twitch, Spotify, SoundCloud
  - Qualsiasi altro URL con meta tag OG

### Miglioramenti
- Estrazione oEmbed generica per tutte le piattaforme che lo supportano
- Badge piattaforma dinamico con label specifiche (YT, FB, X, etc.)
- Fallback automatico su OG scraping per piattaforme senza oEmbed

### Modifiche Tecniche
- Nuovo sistema di configurazione piattaforme con pattern matching
- Tipo `SocialPlatform` condiviso tra frontend e backend
- Funzione `getPlatformConfig()` per accesso dinamico alla configurazione

---

## [1.1.0] - 2026-01-31

### Novità
- **Feature Toggles**: Nuova sezione in Impostazioni per gestire funzionalità avanzate
  - Toggle per abilitare/disabilitare Cobalt.tools (estrazione audio)
  - Toggle per ammettere URL duplicati (disabilita idempotenza per testing)

### Miglioramenti
- **Tema Light Apple-style**: Interfaccia completamente ridisegnata con tema chiaro
- **Date corrette**: Fix parsing date Firestore Timestamp nelle card
- **Card compatte**: Le entry senza risultati ora mostrano un layout compatto
- **Link cliccabili**: Il badge piattaforma (IG/TT) ora apre il post originale
- **Navigazione Console**: Aggiunto link "Home" nella pagina Debug Console

### Bug Fix
- Fix "Invalid date" nelle entry card
- Fix errore 500 causato da valori `undefined` nei log Firestore
- Fix Logger condiviso tra richieste (ora istanziato per-request)
- Fix HTML entities nelle caption (`&quot;`, `&#x1f3a7;` etc.)

### Modifiche Tecniche
- Cobalt.tools disabilitato di default (richiede autenticazione JWT)
- Migliorato logging con context per debugging
- Aggiunta gestione errori più robusta in contentExtractor

---

## [1.0.0] - 2026-01-31

### Release Iniziale
- Analisi URL da Instagram e TikTok
- Estrazione metadata via oEmbed e OG scraping
- Riconoscimento musicale con AudD API
- Analisi AI con Gemini Flash
- Integrazione Spotify (aggiunta automatica a playlist)
- Ricerca film su TMDb
- Bot Telegram
- Journal real-time con Firestore
- Debug Console con log filtrabili
- Editor Prompt personalizzabili
