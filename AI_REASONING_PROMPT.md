# SoundReel - AI Technology Reasoning Prompt

Use this prompt with Claude, GPT-4, or other LLMs to analyze, reason about, and suggest improvements for the SoundReel application.

---

## System Context

You are a senior software architect analyzing a real-world application called **SoundReel**. Your role is to understand the architecture, identify strengths and weaknesses, and provide actionable recommendations.

---

## Application Overview

**SoundReel** is a personal web application that analyzes social media content to extract songs and movies mentioned in posts. Key capabilities:

- Accepts URLs from 14+ social platforms (Instagram, TikTok, YouTube, Facebook, Twitter/X, etc.)
- Extracts metadata via oEmbed APIs and OG meta tag scraping
- Uses AI (Google Gemini Flash) to identify songs and films from captions and thumbnails
- Optional audio fingerprinting via AudD API
- Automatically adds discovered songs to a Spotify playlist
- Searches TMDb for movie information
- Provides a real-time journal with Firestore
- Includes a Telegram bot for URL submission
- Features a debug console with filterable logs

---

## Technology Stack

### Frontend
- **Framework**: React 18 with functional components and hooks
- **Build Tool**: Vite
- **Language**: TypeScript (strict mode)
- **Routing**: React Router v6
- **State Management**: React hooks (useState, useEffect, useCallback) + Firestore real-time listeners
- **Styling**: CSS with CSS Variables (no component library)
- **Hosting**: Firebase Hosting (static SPA)

### Backend
- **Runtime**: Firebase Cloud Functions 2nd Generation
- **Node Version**: 20
- **Language**: TypeScript
- **Database**: Cloud Firestore (NoSQL)
- **Secrets**: Firebase Secret Manager
- **Region**: europe-west1

### External Integrations
| Service | SDK/API | Purpose |
|---------|---------|---------|
| Google Gemini | `@google/generative-ai` | AI content analysis |
| AudD | REST API | Audio fingerprinting |
| Spotify | Web API + OAuth PKCE | Playlist management |
| TMDb | REST API | Movie database |
| Telegram | Bot API (webhooks) | Bot interface |
| Cobalt.tools | REST API | Video/audio extraction |

### Data Flow
```
URL Input → Platform Detection → Content Extraction (oEmbed/OG)
    → [Audio Extraction → AudD] (optional)
    → AI Analysis (Gemini)
    → Result Merging
    → Spotify Search + Playlist Add
    → TMDb Search
    → Firestore Update
```

---

## Architecture Decisions

### Why Firebase?
- Single-user personal app (no complex auth needed)
- Real-time updates via Firestore listeners
- Serverless functions scale to zero
- Integrated hosting, functions, and database
- Secret management built-in

### Why Cloud Functions 2nd Gen?
- 120-second timeout (vs 60s in 1st gen)
- Better cold start performance
- Cloud Run under the hood
- Concurrency support

### Why No Express/Next.js?
- Project guidelines explicitly prohibit additional frameworks
- Cloud Functions provide sufficient HTTP handling
- Keeps deployment simple (single `firebase deploy`)

### Why oEmbed + OG Scraping?
- oEmbed is the standard for social platform metadata
- OG meta tags provide universal fallback
- No platform-specific APIs needed (which often require auth)

### Why Gemini Flash?
- Fast inference for real-time UX
- Multimodal (can analyze images)
- Cost-effective for personal use
- Good at structured extraction tasks

---

## Code Patterns

### Resilient Pipeline
Each step in the analysis pipeline is independent:
- If Cobalt fails → continue with OG scraping only
- If AudD finds nothing → rely on AI analysis
- If Gemini fails → use audio results only
- If Spotify search fails → log but don't block
- Every failure is logged to actionLog for debugging

### Feature Toggles
Runtime configuration stored in Firestore:
```typescript
interface FeaturesConfig {
  cobaltEnabled: boolean;      // Audio extraction
  allowDuplicateUrls: boolean; // Disable idempotency
}
```

### Platform Configuration
Declarative platform definitions:
```typescript
const PLATFORMS: PlatformConfig[] = [
  { name: 'instagram', patterns: ['instagram.com'], oEmbedUrl: '...', label: 'IG' },
  { name: 'youtube', patterns: ['youtube.com', 'youtu.be'], oEmbedUrl: '...', label: 'YT' },
  // ...
];
```

### Logging Strategy
- Module-level Logger instances (per-request in functions)
- Writes to Firestore `logs` collection + console (Cloud Logging)
- Sensitive data automatically redacted
- Structured JSON format with levels (debug/info/warn/error)

---

## Known Limitations

1. **Instagram oEmbed**: Returns login page HTML instead of JSON (requires auth)
2. **Cobalt.tools**: Now requires JWT authentication
3. **Single User**: No multi-tenancy or authentication
4. **Cold Starts**: First request after idle may be slow
5. **Rate Limits**: External APIs have rate limits (AudD, Spotify, TMDb)

---

## Questions for Analysis

Please analyze SoundReel and provide insights on:

### Architecture
1. Is the serverless architecture appropriate for this use case?
2. What are the tradeoffs of using Firestore vs. a relational database?
3. How would you scale this to multi-user?

### Performance
1. Where are the performance bottlenecks?
2. How could cold starts be mitigated?
3. Should any processing be moved client-side?

### Reliability
1. How robust is the error handling?
2. What failure modes aren't covered?
3. How would you add retry logic?

### Security
1. What security concerns exist?
2. How should secrets be rotated?
3. What input validation is missing?

### Extensibility
1. How easy is it to add a new social platform?
2. How would you add a new AI provider?
3. What abstraction layers are missing?

### Cost Optimization
1. What are the cost drivers?
2. How could costs be reduced?
3. Is the current caching strategy sufficient?

### Code Quality
1. What refactoring would you suggest?
2. Are there any anti-patterns?
3. How could testability be improved?

---

## Sample Analysis Request

"Analyze the SoundReel architecture and suggest 3 high-impact improvements that would:
1. Improve reliability of content extraction
2. Reduce Cloud Functions cold start times
3. Add better observability for debugging production issues

For each suggestion, explain the tradeoffs and implementation complexity."

---

## Alternative Prompt: Technology Migration

"If you were to rebuild SoundReel with a different stack, what would you choose and why? Consider:
- A fully serverless approach (AWS Lambda, Vercel, Cloudflare Workers)
- A containerized approach (Cloud Run, ECS, Kubernetes)
- A traditional server approach (Node.js on VM/VPS)

Compare the tradeoffs for a single-user personal project vs. a multi-tenant SaaS."

---

## Alternative Prompt: AI Enhancement

"How could the AI analysis be improved? Consider:
- Using multiple AI providers (Gemini + GPT + Claude) with consensus
- Fine-tuning a model on song/movie extraction
- Adding confidence scores to results
- Implementing human-in-the-loop verification

What would be the implementation complexity and expected accuracy improvement?"
