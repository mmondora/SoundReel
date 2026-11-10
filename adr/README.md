# Architecture Decision Records

| # | Title | Status | Date |
|---|-------|--------|------|
| 0001 | Postgres FTS over pgvector for search | Accepted | 2026-06-23 |
| 0002 | simple FTS dictionary for mixed IT/EN | Accepted | 2026-06-23 |
| 0003 | Reuse qwen2.5:3b for query expansion | Accepted | 2026-06-23 |
| 0004 | Single-call self-classifying enrichment (context-aware Arricchisci) | Accepted | 2026-07-24 |
| 0005 | Reference architecture: SoundReel + Mondrop (stack, data, identity, mobile) | Accepted (D1–D3 Proposed) | 2026-11-07 |
| 0006 | MP3 origin on geekom, replica and media server on the FRITZ!Box | Accepted | 2026-11-07 |
| 0007 | Listening statistics: clients send raw sessions, the server decides what counts | Accepted | 2026-11-07 |
| 0008 | Dynamic playlists are rules evaluated at read time | Accepted | 2026-11-07 |
| 0009 | Activity trail in the existing log, durable audit for device deletions | Accepted | 2026-11-07 |
| 0010 | A song can BE a file of the media server; the web plays it from there and never copies it | Accepted | 2026-11-07 |
| 0011 | Library search over the journal, the media server and configurable music folders | Accepted | 2026-11-07 |
| 0012 | The Mac imports its music straight onto the box, into `Music/SoundReel/_MacMusic/` only | Accepted | 2026-11-07 |
| 0013 | Release year per song, and a library endpoint for Mondrop | Accepted (implemented in 2.9.0) | 2026-11-08 |
| 0014 | Phone photos go to home storage and are ingested by MemoryLoom; SoundReel only receives them | Proposed | 2026-11-08 |
| 0015 | The Mondrop inbox lives on the server; push is only the doorbell | Accepted (implemented in 2.10.0; push dormant until the APNs key exists) | 2026-11-08 |
| 0016 | Mondrop reaches the family through TestFlight, uploaded and managed with an App Store Connect API key | Accepted (build pipeline ready; first upload waits for the API key) | 2026-11-08 |
| 0017 | One identity per thing, and every card links back to the post it came from | Accepted (song versions D5 proposed) | 2026-11-08 |
| 0018 | One search across the journal, the library and the NAS, and tracks that exist only as files can be played | Accepted (2.13.0 + 2.13.1 in production; Mondrop 1.7.0 built, TestFlight pending) | 2026-11-08 |
| 0019 | The server finds the covers (in the file, or on the Internet) and serves them; the clients only ask SoundReel | Accepted (2.14.0 in production; Mondrop 1.7.0 built, TestFlight pending; the lyrics on the Internet are a release of their own) | 2026-11-08 |
| 0020 | The server decides what the Mondrop Home shows, in one route; the app draws it | Accepted (2.18.0 in production; Mondrop 1.7.0 build 9 on TestFlight) | 2026-11-08 |
| 0021 | The server finds the lyrics on the Internet when a song has none, keeps them and serves them; the clients only ask SoundReel | Accepted (2.19.1 in production) | 2026-11-08 |
| 0022 | The server discovers the collections of the library by itself, names and keeps them; the clients only draw them | Accepted (Michele's choices of 10 November; built in phases after ADR-0023, nothing built yet) | 2026-11-09 |
| 0023 | The server builds playlists from the posts that talk about music (one per specific title, one rolling playlist per generic theme); the list of playlists is searched, filtered, sorted and paged by the server | Accepted (2.20.0 in production; Mondrop build 12 on TestFlight) | 2026-11-10 |
| 0024 | An automatic playlist has at least two songs, and a theme that names a genre is a rule on the genre, not a list of songs | Accepted (2.20.2 in production; the 56 playlists already made repaired) | 2026-11-10 |
| 0025 | The site and Mondrop share one set of design tokens, and a test keeps them aligned | Accepted (built in 2.21.0, P1 of the look and feel; deploy waits for Michele's OK) | 2026-11-10 |
| 0026 | The configuration of the site belongs to the user and lives on the server | Accepted (built in 2.21.0, P2 of the look and feel; deploy waits for Michele's OK) | 2026-11-10 |
