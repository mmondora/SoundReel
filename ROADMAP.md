# SoundReel — Roadmap Ideas

Idee future non ancora in sviluppo. Non ordinate per priorità.

---

## Instagram Saves → Contenuti Tematici (+ Mneme)

**Cosa**: importare i salvataggi Instagram dell'utente, raggrupparli per tema, e archiviarli come **contenuto semantico** — non come video/post raw.

**Esempi**:
- "tavolo moderno per esterni" → tema: casa / stile francese
- "risotto" → tema: ristorante (Milano?)

**Concetto chiave**: non archiviare il media, ma il *significato* del salvataggio — cosa si vuole ricordare, non cosa è stato salvato.

**Pipeline immaginata**:
1. Fetch dei saved posts Instagram (API o scraping via instaloader)
2. AI (Ollama) estrae il "contenuto": oggetto, luogo, stile, intenzione
3. Clustering automatico per tema
4. Entry nel journal Soundreel con tag semantici
5. Sync verso Mneme come knowledge nodes

**Output**: non un post, ma una scheda tipo "Ristorante consigliato: X (Milano) — risotto" o "Arredo: tavolo ferro battuto esterno — stile provenzale".

---

## Link musicali → estrazione Spotify URL → download Spooty

**Cosa**: quando un link salvato fa riferimento a musica in forma editoriale (es. "I migliori dischi del 2026", "Top 10 album da ascoltare", "Le canzoni dell'estate"), estrarre i link Spotify citati nel contenuto e metterli automaticamente in coda download su Spooty.

**Trigger**: entry con tag musicale o summary che contiene riferimenti a classifiche/liste di album/canzoni.

**Pipeline immaginata**:
1. AI (Ollama) analizza il contenuto dell'entry e identifica se è una lista/classifica musicale
2. Se sì, scraping della pagina sorgente per estrarre link Spotify (`open.spotify.com/album/*`, `open.spotify.com/track/*`)
3. Ogni link trovato → POST a `http://spooty:3000/api/playlist`
4. Logga nel journal "X link Spotify trovati e inviati a Spooty"

**Note**:
- Spooty già integrato nel webhook Telegram — riutilizzare logica esistente e `SPOOTY_URL`
- Playwright (già presente per JS rendering) utile per pagine che caricano i link via JS
- Evitare duplicati: verificare se link Spotify già inviato prima di ri-accodare

---
