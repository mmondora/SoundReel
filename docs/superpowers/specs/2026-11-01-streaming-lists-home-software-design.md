# Streaming lists, Home recenti, sezione Software

**Date**: 2026-11-01  
**Status**: Approved (chat brainstorming)

## Intent

Tre miglioramenti indipendenti, in quest’ordine:

1. Home veloce (ultime 50 entry).
2. Liste film su SoundReel per Netflix / Prime / RaiPlay con click → player/titolo corretto.
3. Sezione dedicata Software (vita professionale): repo, prodotti, articoli con tag.

## Goals

- Aprire la home senza scaricare il journal intero.
- Dalla pagina Film (o sotto-liste), filtrare i titoli disponibili su Netflix, Prime o RaiPlay e aprire il deep link della piattaforma.
- Raccogliere riferimenti a software/GitHub/articoli in una sezione di primo livello, non mescolati alle note generiche.

## Non-goals / anti-goals

- **Non** sincronizzare automaticamente la “Mia lista” nativa di Netflix / Prime / RaiPlay in questo passo (resta desiderio futuro per la TV).
- **Non** riscrivere Songs/Notes/Entries per forzare il limite 50: il limite 50 vale per la home/journal feed.
- **Non** inventare API ufficiali inesistenti delle piattaforme streaming.

## 1. Home — ultime 50

- `useJournal` richiede `limit=50` a `GET /api/entries` (oggi `FETCH_LIMIT = 1000`).
- Paginazione client sulla sola finestra delle 50.
- Deep link `?entry=<id>` resta supportato via `getEntry` (già presente).
- I totali Header sulla home possono riflettere solo le 50 caricate; i totali “veri” restano sulle pagine Songs/Films/Notes (API aggregate). Opzionale futuro: endpoint stats leggero.

## 2. Liste streaming su SoundReel

- Fonte dati: `film_meta.streaming_options` (già popolata da Watchmode / MotN) + fallback `streamingUrls` di ricerca se manca il deep link.
- UI: sulla Films page, filtri/tab **Netflix | Prime | RaiPlay** che mostrano solo film con opzione (o URL) per quella piattaforma.
- Click sul badge/piattaforma apre `option.url` (deep link) quando presente; altrimenti l’URL di ricerca esistente.
- Wishlist nativa piattaforme: fuori scope; documentata come follow-up.

## 3. Sezione Software

- Nuova route `/software` + voce in Header (accanto a Notes).
- Entità aggregate (come songs/films/notes): titolo, url primario, tag (`repo` | `product` | `article` | …), mention da entry.
- Estrazione in pipeline AI: quando caption/transcript/link citano GitHub, tool o articoli tecnici, produrre item software (non solo note `other`).
- Persistenza: JSONB sull’entry (`results.software` o equivalente) + aggregazione `GET /api/software`; schema tipizzato in `types/index.ts`.
- Tag nella stessa lista; filtri per tag.

## Builder calls

- Limite home fisso a 50 (non configurabile UI in v1).
- Piattaforme lista v1: Netflix, Prime Video, RaiPlay sole.
- Tag software v1: `repo`, `product`, `article`, `other`.
- Ordine implementazione: Home → liste streaming → Software.
