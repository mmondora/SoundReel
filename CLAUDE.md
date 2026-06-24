# CLAUDE.md — SoundReel Project

## Cos'è questo progetto

SoundReel è una web app personale (single user) che analizza contenuti social (Instagram Reels, TikTok, post) per estrarre canzoni e film menzionati. Le canzoni vengono aggiunte automaticamente a una playlist Spotify. Tutto viene loggato in un journal cronologico.

## Stack tecnologico

- **Frontend**: React + Vite + TypeScript, SPA statica servita da Fastify
- **Backend**: Node.js 20 + Fastify + TypeScript, in `backend/`
- **Database**: PostgreSQL 17 (container Docker `soundreel-db`)
- **AI**: Ollama self-hosted — `qwen2.5:3b` (testo/analisi), `moondream:latest` (vision/frame video) via `ollamaClient.ts`
- **Music Recognition**: AudD API + Shazam (`shazamClient.ts` → instaloader) + Whisper (trascrizione)
- **Film DB**: TMDb API
- **Spotify**: Spotify Web API con OAuth 2.0 PKCE
- **Telegram**: Bot API con webhook su endpoint Fastify — link Spotify inviati a Spooty (`http://spooty:3000/api/playlist`)
- **Spooty**: servizio Docker (`raiper34/spooty`) per download MP3 da Spotify via yt-dlp, su rete `web`
- **Video extraction**: cobalt.tools API + Instaloader (container dedicato) con fallback su OG meta scraping
- **OCR**: servizio OCR dedicato (container `soundreel-ocr`)
- **Deploy**: Docker Compose su GEEKOM A8 Max, `soundreel.casamon.dev`

## Struttura progetto

```
soundreel/
├── CLAUDE.md
├── README.md
├── Dockerfile               # multi-stage: frontend-build + backend-build + runtime
├── docker-compose.yml       # soundreel, soundreel-db, instaloader, whisper, ocr (ollama via gpu-router su rete web esterna)
├── .env                     # secrets (non committare)
├── scripts/
│   ├── build.sh             # docker compose build con GIT_REVISION e BUILD_DATE
│   ├── bump-version.sh      # incrementa patch version in package.json
│   └── telegram-set-webhook.sh
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts        # entry point Fastify
│       ├── db/
│       │   └── init.sql
│       ├── routes/
│       ├── services/
│       └── types/
├── frontend/
│   ├── package.json
│   ├── vite.config.js
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── components/
│       ├── pages/
│       ├── services/
│       │   ├── api.ts
│       │   └── spotify.ts
│       ├── hooks/
│       ├── types/
│       └── styles/
├── instaloader/             # servizio Python per Instagram
│   └── Dockerfile
└── ocr/                     # servizio OCR
    └── Dockerfile
```

## Convenzioni di sviluppo

### Linguaggio e stile
- TypeScript strict mode ovunque (frontend e backend)
- Nessun `any` — definire sempre i tipi in `types/index.ts`
- Preferire `async/await` su `.then()` chains
- Gestire SEMPRE gli errori: ogni step della pipeline è indipendente, se uno fallisce gli altri continuano
- Loggare ogni azione nell'`actionLog` dell'entry in Postgres

### Database (PostgreSQL)
- Schema definito in `backend/src/db/init.sql`
- MAI usare ORM — query SQL dirette con `pg`
- Secrets DB via env vars (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`)

### Backend (Fastify)
- Entry point: `backend/src/server.ts`
- Secrets letti da env vars, MAI hardcodati
- L'endpoint `analyzeUrl` è chiamato sia dal frontend che dal bot Telegram — unica implementazione
- Timeout pipeline: 120s

### Frontend React
- Componenti funzionali con hooks
- Stato globale minimo: usare hooks custom
- Polling o WebSocket per aggiornamenti real-time (no Firestore)
- React Router per navigazione
- CSS semplice — no component library
- Dark mode come default e unico tema

### API esterne
- **Whisper**: HTTP verso `soundreel-whisper:9000`
- **Instaloader**: HTTP verso `soundreel-instaloader:5000` (include endpoint `/shazam/recognize`, `/shazam/scan-full`, `/yt/url`)
- **OCR**: HTTP verso `soundreel-ocr:5001`
- **Ollama**: HTTP verso `gpu-router:9000` (env `OLLAMA_URL`) — gpu-router fa load balancing tra archi-PC (`192.168.178.23:11434`) e ollama locale GEEKOM. Modelli: `OLLAMA_TEXT_MODEL` (default `qwen2.5:3b`), `OLLAMA_VISION_MODEL` (default `moondream:latest`)
- **Spooty**: HTTP verso `spooty:3000/api/playlist` per aggiungere link Spotify (env `SPOOTY_URL`, default `http://spooty:3000`; env `SPOOTY_FRONTEND_URL`, default `https://spooty.casamon.dev`)
- **Spotify**: OAuth PKCE, token refresh automatico prima di ogni operazione
- **TMDb**: GET a `https://api.themoviedb.org/3/search/movie`
- **Telegram**: webhook, risposta inline nel messaggio
- **cobalt.tools**: POST a `https://api.cobalt.tools/` per estrazione video — implementare SEMPRE fallback su OG scraping se cobalt fallisce

### Resilienza della pipeline
La pipeline è progettata per essere resiliente:
1. Se cobalt fallisce → usa OG meta scraping (solo caption + thumbnail)
2. Se AudD/Shazam/Whisper non trovano nulla → si usa solo il risultato AI (Ollama)
3. Se Ollama fallisce → si usa solo il risultato AudD/Shazam/Whisper
4. Se Spotify non trova la canzone → logga nel journal, non bloccare
5. Se TMDb non trova il film → logga titolo/regista senza link IMDb
6. OGNI fallimento va loggato nell'actionLog con dettagli dell'errore

### YouTube links
NON usare YouTube Data API. Generare link di ricerca:
`https://youtube.com/results?search_query=${encodeURIComponent(artist + " " + title)}`

### Idempotenza
Prima di processare un URL, cercare `sourceUrl` in Postgres. Se esiste, restituire i risultati esistenti senza riprocessare.

## Deploy

Deploy su GEEKOM via file sentinel (sistema `deploy-watcher`):

```bash
# Trigger rebuild + redeploy
touch /home/mike/works/Soundreel/.rebuild

# Verifica risultato (dopo ~60s)
cat /home/mike/works/Soundreel/.rebuild-log

# Oppure via API
curl -X POST https://console.casamon.dev/rebuild/soundreel
curl https://console.casamon.dev/deploy-status/soundreel
```

## Comandi utili

```bash
# Build Docker locale
./scripts/build.sh

# Dev locale frontend
cd frontend && npm run dev

# Dev locale backend
cd backend && npm run dev

# Logs container in produzione
docker compose logs -f soundreel

# Restart container
docker compose restart soundreel
```

## Cose da NON fare

- NON usare Firebase, Firestore, o Firebase Cloud Functions
- NON usare Next.js o altri framework backend — solo Fastify
- NON usare YouTube Data API
- NON hardcodare API keys o secrets nel codice
- NON creare un sistema di autenticazione multi-utente — è un'app personale
- NON aggiungere dipendenze frontend pesanti (Material UI, Chakra, etc.)
- Test automatici: unit test e integration test con mock sono benvenuti. NON usare chiamate reali a sorgenti esterne nei test (Instagram, TikTok, YouTube, Spotify, Ollama, cobalt, instaloader) — usare sempre mock/stub per evitare ban/rate-limit degli account. Stack test consigliato: Vitest (frontend), Node test runner o Vitest (backend).

<!-- claude-skills:begin -->
## Installed Skills

The following Claude Code skills are installed in `.claude/skills/`. Claude will auto-load them based on context, or you can invoke them with `/<skill-name>`.

### Foundations
| Skill | Description |
|-------|-------------|
| `architecture-decision-records` | Architecture Decision Records governance and format. |
| `ask-questions-if-underspecified` | description: Clarify underspecified requirements before implementation. |
| `prompt-architect` | Analyzes and transforms prompts using 8 research-backed frameworks (CO-STAR, RISEN, RISE-IE, RISE-IX, TIDD-EC, RTF, Chain of Thought, Chain of Density). |
| `skill-clusters` | Skill cluster index and loader. |

### Cloud & Infrastructure
| Skill | Description |
|-------|-------------|
| `containerization` | Docker best practices for cloud-native applications. |
| `finops` | Cloud cost management as an architectural discipline. |
| `infrastructure-as-code` | Infrastructure as Code with Terraform and Pulumi. |
| `observability` | Logging, metrics, and tracing with OpenTelemetry. |
| `terraform-style-guide` | description: Generate Terraform HCL code following HashiCorp's official style conventions and best practices. |
| `terraform-test` | description: Comprehensive guide for writing and running Terraform tests. |

### Security & Compliance
| Skill | Description |
|-------|-------------|
| `authn-authz` | Authentication and authorization patterns for multi-tenant applications. |
| `compliance-privacy` | GDPR compliance and privacy as architectural constraints. |
| `differential-review` | description: > |
| `owasp-security` | description: Use when reviewing code for security vulnerabilities, implementing authentication/authorization, handling user input, or discussing web application security. |
| `security-by-design` | Security as a design property, not an added layer. |

### Testing & Quality
| Skill | Description |
|-------|-------------|
| `performance-testing` | Performance testing with k6 for SLO validation. |
| `property-based-testing` | description: Provides guidance for property-based testing across multiple languages and smart contracts. |
| `quality-gates` | Formal quality gates that block releases. |
| `security-testing` | Automated security testing in CI. |
| `testing-implementation` | Concrete test tooling and patterns for TypeScript and Swift. |
| `testing-strategy` | Testing strategy that produces real confidence. |
| `verification-before-completion` | description: No completion claims without fresh verification evidence. |

### Delivery & Release
| Skill | Description |
|-------|-------------|
| `chaos-engineer` | description: Use when designing chaos experiments, implementing failure injection frameworks, or conducting game day exercises. |
| `cicd-pipeline` | CI/CD pipeline design with GitHub Actions. |
| `executing-plans` | description: Execute implementation plans in batches with feedback checkpoints. |
| `feature-management` | Feature flags, progressive rollout, A/B testing, and kill switches. |
| `finishing-a-development-branch` | description: Complete feature branches safely with structured options. |
| `incident-management` | Incident response process from detection to postmortem. |
| `production-readiness-review` | Production readiness GO/NO-GO framework. |
| `release-management` | Release management with automated SemVer, changelog generation, release notes, rollback strategies, and hotfix workflow. |
| `using-git-worktrees` | description: Set up isolated git worktree workspaces for feature development. |
| `writing-plans` | description: Break requirements into TDD-based micro-task implementation plans. |

### Documentation & Diagrams
| Skill | Description |
|-------|-------------|
| `architecture-communication` | Communicating architectural decisions to stakeholders. |
| `diagrams` | Architectural diagrams as code using Mermaid and C4 model. |
| `technical-documentation` | Documentation as a living artifact. |

### Data Architecture
| Skill | Description |
|-------|-------------|
| `caching-search` | Distributed caching and full-text search patterns. |
| `data-modeling` | Schema design, multi-tenant data isolation, and migration management. |
| `database-optimizer` | description: Use when investigating slow queries, analyzing execution plans, or optimizing database performance. |
| `event-driven-architecture` | Event-driven systems with CloudEvents and GCP Pub/Sub. |

### Architecture & Patterns
| Skill | Description |
|-------|-------------|
| `api-design` | API design conventions for REST and GraphQL. |
| `error-handling-resilience` | Error handling and resilience patterns for distributed systems. |
| `legacy-modernizer` | description: Use when modernizing legacy systems, implementing incremental migration strategies, or reducing technical debt. |
| `microservices-architect` | description: Use when designing distributed systems, decomposing monoliths, or implementing microservices patterns. |
| `microservices-patterns` | Microservices patterns for service decomposition, inter-service communication, and operational concerns. |

### AI & Applications
| Skill | Description |
|-------|-------------|
| `rag-architect` | description: Use when building RAG systems, vector databases, or knowledge-grounded AI applications requiring semantic search, document retrieval, or context augmentation. |

### Green Software & Sustainability
| Skill | Description |
|-------|-------------|
| `carbon-aware-architecture` | Carbon-aware design patterns from the Green Software Foundation. |
| `green-software-principles` | Green Software Foundation principles as an architectural discipline. |
| `sci-measurement` | Software Carbon Intensity (SCI) measurement per ISO/IEC 21031:2024. |
| `sustainability-impact-assessment` | Sustainability governance council for software projects. |

### Other Skills
| Skill | Description |
|-------|-------------|
| `apple-compliance-audit` | Apple App Store compliance audit for iOS apps covering Info.plist, entitlements, privacy manifests, App Store Review Guidelines, HIG, security, and submission readiness. |
| `graphql-architect` | GraphQL schema design, Apollo Federation, DataLoader patterns, and query optimization. |
| `insecure-defaults` | Detects fail-open insecure defaults — hardcoded secrets, weak auth, permissive security — that allow apps to run insecurely in production. |
| `ios-app-audit` | Comprehensive production audit for iOS apps covering security, App Store compliance, privacy, reliability, performance, accessibility, and code quality. |
| `ios-gui-assessment` | Audit iOS SwiftUI/UIKit projects for GUI consistency, native Apple control usage, HIG conformance, deprecated API detection, OS version compatibility, and accessibility. |
| `kubernetes-specialist` | Kubernetes workloads, networking, security hardening, Helm, and GitOps. |
| `pypict-claude-skill` | Pairwise and combinatorial test case design using PICT models. |
| `sharp-edges` | Identifies error-prone APIs, dangerous configurations, and footgun designs that enable security mistakes through poor developer ergonomics. |
| `systematic-debugging` | Root-cause-first debugging methodology with four-phase investigation process. |
| `websocket-engineer` | Real-time communication with WebSocket and Socket.IO, scaling, and presence patterns. |
<!-- claude-skills:end -->
