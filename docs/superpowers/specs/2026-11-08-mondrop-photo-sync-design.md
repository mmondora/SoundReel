# Mondrop — sync delle foto, al posto di Flickr (roadmap)

- **Data:** 2026-11-08
- **Stato:** **Richiesta registrata, in roadmap.** Niente è ancora implementato né deciso: questa spec raccoglie la richiesta, i fatti noti e le decisioni da prendere, con il default che propongo
- **Scadenza di fatto:** Flickr va dismesso nel 2027 («il prossimo anno»)
- **Aggiornamento 2026-11-08:** Michele: «Flickr lo vedremo a Natale, ora resta». **Rimandato a dicembre 2026**: fino ad allora Flickr resta com'è e non si fa nulla di questa spec (restano valide le misure e le domande aperte)
- **Owner:** Michele
- **Correlati:** `adr/0014-photo-sync-home-storage-ingested-by-memoryloom.md` (proposto), `adr/0006-mp3-origin-on-geekom-replica-on-fritz.md`, `adr/0009-activity-trail-in-logs-and-durable-device-audit.md`, `docs/mondrop-sync.md`, il progetto MemoryLoom (`~/works/memoryloom`)

## 1. Richiesta di Michele (testuale)

«Da mettere in roadmap un sync di Mondrop anche delle foto, come fa Flickr che devo dismettere il prossimo anno.»

## 2. Come la leggo (da confermare con Michele)

- **A. Il sync dal telefono.** Mondrop carica da solo le foto (e i video?) del rullino dell'iPhone verso casa, in background e senza doppioni, come oggi fa l'app Flickr: così Flickr non serve più per questo.
- **B. Conseguenza che la richiesta non dice:** dismettere Flickr vuol dire anche **mettere in salvo le foto che ci sono già**. A settembre MemoryLoom ne indicizzava 83.895 in 1.065 album, ma tiene solo metadati, miniature e volti: **gli originali stanno ancora su Flickr**. È la parte con la scadenza vera, quindi la tratto come fase a sé (§5, F2) e la metto prima del sync.

## 3. Fatti noti (verificati il 2026-11-08)

| Cosa | Stato |
|------|-------|
| MemoryLoom (hub, `memoryloom-web:5180`, gruppi family + admins) | Archivio multi-sorgente: Flickr + filesystem locali. Per le cartelle locali calcola SHA-256, EXIF, GPS; per tutte pHash, CLIP, volti, eventi e **duplicati tra sorgenti**. Flickr è in sola lettura (il write-back è dietro un flag, spento) |
| Originali di Flickr | **Non sono in locale**: in `memoryloom/data` ci sono solo il database (≈1 GB) e 11 GB di miniature e volti |
| Mondrop | Ha già API key per utente e dispositivo, trasferimenti in background (gli MP3), la distinzione casa/internet (`/api/mondrop/net`) e la schermata «Spazio» con doppia conferma e registro dettagliato |
| Disco di geekom | 937 GB, **199 GB liberi** (78 % usato) |
| Chiavetta del Fritz | 120 GB e **è anche il drive della Tesla**: non adatta alle foto |
| Tunnel Cloudflare | Limita la dimensione di una singola richiesta (100 MB sui piani gratuiti): un video grosso non passa in un colpo solo da fuori casa |

## 4. Decisioni da prendere (default proposti, da correggere se non vanno)

| # | Decisione | Default proposto |
|---|-----------|------------------|
| P1 | **Dove vivono gli originali** | **Da decidere dopo aver misurato.** L'ordine di grandezza dell'archivio Flickr (≈84.000 foto × 3–5 MB) è di centinaia di GB e geekom ne ha 199 liberi, più il rullino del telefono. Va misurato il peso reale (dimensioni degli originali via API o esportazione dell'account) e poi scelto un disco: nuovo su geekom, altro disco di casa, o esterno. Lo spazio decide tutto il resto |
| P2 | **Chi è la galleria** | **MemoryLoom.** Le foto caricate da Mondrop finiscono in una cartella che MemoryLoom legge come sorgente locale, e il suo rilevamento dei duplicati tra sorgenti toglie i doppioni con Flickr. SoundReel **riceve** soltanto: endpoint di upload e client iOS, nessuna galleria (ADR-0014) |
| P3 | **Come si carica** | A pezzi riprendibili (richieste di ≤ ~50 MB con offset), verifica SHA-256 alla fine, trasferimenti in background di iOS. **Solo dal Wi-Fi di casa** di default (stessa logica di `/api/mondrop/net`); da internet solo se attivato dall'utente |
| P4 | **Cosa si carica** | Foto e video; una Live Photo è una coppia (immagine + filmato); scelta degli album da sincronizzare; da quale data in poi. Screenshot esclusi su richiesta |
| P5 | **Doppioni** | Il telefono calcola lo SHA-256 del contenuto e lo manda per primo; se il server lo ha già risponde «presente» e **il file non viaggia**. L'identificatore del rullino serve solo come aiuto locale |
| P6 | **Liberare spazio sul telefono** | **Mai in automatico.** Come «Spazio» per la musica: solo dopo che il server ha confermato lo stesso hash sul suo disco, con doppia conferma e un registro dettagliato che non si cancella (ADR-0009) |
| P7 | **Privacy** | Le foto sono dati personali: tutto resta in casa, nessun servizio esterno, EXIF e GPS non escono mai da casa. Una cartella per utente della famiglia, privata di default |
| P8 | **Uscita da Flickr** | Fase a sé, **in MemoryLoom** (ha già il client OAuth e i metadati): scarico degli originali e di album, titoli, descrizioni e tag, con verifica dell'hash. Non si cancella niente su Flickr finché la copia non è verificata |
| P9 | **Ordine di lavoro** | Misure e spazio → archivio Flickr in salvo → sync dal telefono. L'archivio ha tempi lunghi (limiti dell'API e banda) e una scadenza: parte per primo |

## 5. Fasi proposte

- **F0 (questa):** spec + ADR-0014 proposto.
- **F1 — Misure e spazio (P1):** peso reale dell'archivio Flickr e del rullino; scelta del disco.
- **F2 — Flickr in salvo (P8):** in MemoryLoom, non qui. Nessuna cancellazione.
- **F3 — Backend SoundReel:** upload a pezzi riprendibile e idempotente per SHA-256, cartella di destinazione, voce nel registro di attività.
- **F4 — Mondrop iOS:** permesso di lettura del rullino, coda di upload in background, stato per foto (spinner, percentuale, «presente», errore), impostazioni (solo Wi-Fi, album, video), «Spazio foto» con doppia conferma.
- **F5 — Galleria e ricerca:** è MemoryLoom, già esistente; una vista veloce in SoundReel solo se serve.
- **F6 — Condivisione e album:** da decidere.

## 6. Test (alto livello)

- **Backend:** ripresa dopo un'interruzione; pezzo con hash sbagliato rifiutato; doppione riconosciuto senza trasferire il file; un percorso non esce mai dalla cartella di destinazione; scrittura atomica (`.part` poi rename); nessuna chiamata a servizi esterni nei test.
- **iOS:** coda e ripresa; nessun upload fuori dal Wi-Fi di casa se non abilitato; nessuna cancellazione dal telefono senza conferma e senza hash verificato.
- **Prova reale** (non nei test automatici): 3 foto, 1 video e 1 Live Photo dal telefono di Michele.

## 7. Rischi

- **Spazio:** vedi P1.
- **iCloud:** se l'iPhone usa «Ottimizza spazio», l'originale può stare solo su iCloud e va scaricato prima di poterlo caricare (lento e grosso).
- **iOS in background** non garantisce di finire in una sessione: l'upload deve poter riprendere ovunque si fermi.
- **Formati:** HEIC, Live Photo, RAW, video lunghi.
- **Flickr:** limiti dell'API (richieste all'ora) e della banda in download; verificare la data esatta di chiusura dell'accesso.
- **Privacy:** EXIF/GPS nei file; backup della cartella foto (oggi non c'è una seconda copia fuori da geekom).

## 8. Domande aperte per Michele

1. Entro che mese va spento Flickr?
2. Il sync serve solo per le foto nuove del telefono, o anche per il vecchio archivio (io direi sì, F2)?
3. Anche i video?
4. Dove mettiamo qualche centinaio di GB?
5. Chi altro in famiglia carica foto (cartelle separate per utente)?
