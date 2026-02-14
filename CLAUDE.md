# CLAUDE.md — SoundReel Project

## Cos'è questo progetto

SoundReel è una web app personale (single user) che analizza contenuti social (Instagram Reels, TikTok, post) per estrarre canzoni e film menzionati. Le canzoni vengono aggiunte automaticamente a una playlist Spotify. Tutto viene loggato in un journal cronologico.

## Stack tecnologico

- **Frontend**: React + Vite + TypeScript, deployato come SPA statica su Firebase Hosting
- **Backend**: Firebase Cloud Functions 2nd gen (Node.js 20, TypeScript)
- **Database**: Cloud Firestore (una collection `entries`, documenti JSON)
- **AI**: Gemini Flash via Google AI Studio (`@google/generative-ai` SDK)
- **Music Recognition**: AudD API (audio fingerprinting)
- **Film DB**: TMDb API
- **Spotify**: Spotify Web API con OAuth 2.0 PKCE
- **Telegram**: Bot API con webhook su Cloud Function
- **Video extraction**: cobalt.tools API con fallback su OG meta scraping

## Struttura progetto

```
soundreel/
├── CLAUDE.md
├── README.md
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
├── .firebaserc
├── .env.example
├── scripts/
│   ├── setup.sh              # setup iniziale progetto Firebase
│   ├── deploy.sh             # deploy completo (functions + hosting)
│   ├── deploy-functions.sh   # deploy solo functions
│   ├── deploy-hosting.sh     # deploy solo hosting
│   └── set-secrets.sh        # configura secrets in Firebase
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   ├── public/
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── components/
│       │   ├── Header.tsx
│       │   ├── UrlInput.tsx
│       │   ├── Journal.tsx
│       │   ├── EntryCard.tsx
│       │   ├── SongItem.tsx
│       │   ├── FilmItem.tsx
│       │   └── ActionLog.tsx
│       ├── pages/
│       │   ├── Home.tsx
│       │   └── Settings.tsx
│       ├── services/
│       │   ├── firebase.ts
│       │   ├── api.ts
│       │   └── spotify.ts
│       ├── hooks/
│       │   ├── useJournal.ts
│       │   └── useAnalyze.ts
│       ├── types/
│       │   └── index.ts
│       └── styles/
│           └── index.css
├── functions/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── analyzeUrl.ts
│       ├── telegramWebhook.ts
│       ├── services/
│       │   ├── contentExtractor.ts
│       │   ├── audioRecognition.ts
│       │   ├── aiAnalysis.ts
│       │   ├── spotify.ts
│       │   ├── filmSearch.ts
│       │   └── resultMerger.ts
│       ├── utils/
│       │   ├── firestore.ts
│       │   └── logger.ts
│       └── types/
│           └── index.ts
```

## Convenzioni di sviluppo

### Linguaggio e stile
- TypeScript strict mode ovunque (frontend e functions)
- Nessun `any` — definire sempre i tipi in `types/index.ts`
- Preferire `async/await` su `.then()` chains
- Gestire SEMPRE gli errori: ogni step della pipeline è indipendente, se uno fallisce gli altri continuano
- Loggare ogni azione nell'`actionLog` dell'entry Firestore

### Firestore
- UNA sola collection: `entries`
- Ogni documento è un'entry processata con `results` (songs + films) e `actionLog` embedded
- Un documento `config/spotify` per i token OAuth Spotify
- MAI creare collection aggiuntive. Se serve un nuovo dato, è un campo nel documento entry o un documento in `config/`
- Usare `serverTimestamp()` per i timestamp nelle Cloud Functions

### Cloud Functions
- Tutte 2nd gen (`onRequest` da `firebase-functions/v2/https`)
- Timeout configurato a 120s per `analyzeUrl`
- Region: `europe-west1` (più vicino all'Italia)
- I secrets vengono letti da Firebase Secret Manager, MAI hardcodati
- L'endpoint `analyzeUrl` è chiamato sia dal frontend che dal bot Telegram — deve essere un'unica implementazione

### Frontend React
- Componenti funzionali con hooks
- Stato globale minimo: usare hooks custom (`useJournal`, `useAnalyze`)
- Firestore `onSnapshot` per aggiornamenti real-time del journal
- React Router per navigazione (`/` e `/settings`)
- CSS semplice o Tailwind utility classes — no component library
- Dark mode come default e unico tema

### API esterne
- **AudD**: POST a `https://api.audd.io/` con file audio o URL
- **Gemini**: usare `@google/generative-ai` SDK, modello `gemini-2.0-flash`
- **Spotify**: OAuth PKCE, token refresh automatico prima di ogni operazione
- **TMDb**: GET a `https://api.themoviedb.org/3/search/movie`
- **Telegram**: webhook, risposta inline nel messaggio
- **cobalt.tools**: POST a `https://api.cobalt.tools/` per estrazione video — implementare SEMPRE fallback su OG scraping se cobalt fallisce

### Resilienza della pipeline
La pipeline è progettata per essere resiliente:
1. Se cobalt fallisce → usa OG meta scraping (solo caption + thumbnail)
2. Se AudD non trova nulla → si usa solo il risultato Gemini
3. Se Gemini fallisce → si usa solo il risultato AudD
4. Se Spotify non trova la canzone → logga nel journal, non bloccare
5. Se TMDb non trova il film → logga titolo/regista senza link IMDb
6. OGNI fallimento va loggato nell'actionLog con dettagli dell'errore

### YouTube links
NON usare YouTube Data API. Generare link di ricerca:
`https://youtube.com/results?search_query=${encodeURIComponent(artist + " " + title)}`

### Idempotenza
Prima di processare un URL, cercare `sourceUrl` in Firestore. Se esiste, restituire i risultati esistenti senza riprocessare.

## Comandi utili

```bash
# Setup iniziale
./scripts/setup.sh

# Deploy completo
./scripts/deploy.sh

# Deploy solo functions
./scripts/deploy-functions.sh

# Deploy solo frontend
./scripts/deploy-hosting.sh

# Configurare secrets
./scripts/set-secrets.sh

# Dev locale frontend
cd frontend && npm run dev

# Dev locale functions (emulatore)
firebase emulators:start --only functions,firestore

# Build frontend
cd frontend && npm run build

# Build functions
cd functions && npm run build
```

## Fase di implementazione

Seguire questo ordine:

1. **Setup**: progetto Firebase, struttura cartelle, configurazione base
2. **Pipeline core**: Cloud Function `analyzeUrl` con tutti gli step
3. **Integrazioni**: Spotify OAuth + playlist, TMDb, YouTube links
4. **Telegram**: webhook bot con comandi
5. **Frontend**: journal con real-time updates, settings page
6. **Polish**: error handling, retry logic, UI responsive

## Cose da NON fare

- NON creare collection Firestore aggiuntive
- NON usare Next.js, Express, o altri framework backend — solo Cloud Functions
- NON usare YouTube Data API
- NON hardcodare API keys o secrets nel codice
- NON creare un sistema di autenticazione multi-utente — è un'app personale
- NON aggiungere dipendenze frontend pesanti (Material UI, Chakra, etc.)
- NON creare test automatici a meno che non venga richiesto esplicitamente

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
