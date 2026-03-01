# SoundReel

**SoundReel** is a personal web application that analyzes social media content (Instagram Reels, TikTok videos, YouTube clips, and more) to extract songs and movies mentioned in posts. Identified songs are automatically added to a Spotify playlist, and everything is logged in a real-time chronological journal.

![Version](https://img.shields.io/badge/version-1.4.18-blue)
![Firebase](https://img.shields.io/badge/Firebase-Cloud%20Functions-orange)
![React](https://img.shields.io/badge/React-18-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue)

## Features

- **Multi-Platform Support**: Works with Instagram, TikTok, YouTube, Facebook, Twitter/X, Reddit, Vimeo, Spotify, SoundCloud, and any URL with OG meta tags
- **AI-Powered Analysis**: Uses Google Gemini Flash to analyze captions and thumbnails for song/movie mentions
- **Audio Fingerprinting**: Optional integration with AudD API for audio recognition
- **Spotify Integration**: Automatically adds discovered songs to your Spotify playlist via OAuth PKCE
- **Movie Database**: Searches TMDb for mentioned films with IMDb links
- **Real-time Journal**: Live updates via Firestore with processing status
- **Telegram Bot**: Submit URLs directly from Telegram
- **Debug Console**: Full logging system with filters for troubleshooting
- **Customizable Prompts**: Edit AI prompts directly from the UI

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND                                 │
│  React + Vite + TypeScript (Firebase Hosting)                   │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐               │
│  │  Home   │ │ Console │ │ Prompts │ │Settings │               │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘               │
│       │           │           │           │                     │
│       └───────────┴───────────┴───────────┘                     │
│                         │                                        │
│                    Firestore                                     │
│                   (Real-time)                                    │
└─────────────────────────┬───────────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────────┐
│                    CLOUD FUNCTIONS                               │
│  Firebase Functions 2nd Gen (Node.js 20)                        │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    analyzeUrl                             │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │   │
│  │  │   Content   │  │    Audio    │  │     AI      │       │   │
│  │  │  Extractor  │  │ Recognition │  │  Analysis   │       │   │
│  │  │  (oEmbed/OG)│  │   (AudD)    │  │  (Gemini)   │       │   │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘       │   │
│  │         │                │                │               │   │
│  │         └────────────────┴────────────────┘               │   │
│  │                          │                                │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │   │
│  │  │   Spotify   │  │    TMDb     │  │   Result    │       │   │
│  │  │  (Playlist) │  │  (Movies)   │  │   Merger    │       │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌────────────────┐  ┌────────────────┐                         │
│  │telegramWebhook │  │ Other Functions│                         │
│  └────────────────┘  └────────────────┘                         │
└──────────────────────────────────────────────────────────────────┘
```

## Tech Stack

### Frontend
- **React 18** with functional components and hooks
- **Vite** for fast development and optimized builds
- **TypeScript** in strict mode
- **React Router** for SPA navigation
- **Firebase SDK** for Firestore real-time listeners
- **CSS Variables** for theming (Apple-style light theme)

### Backend
- **Firebase Cloud Functions 2nd Gen** (Node.js 20)
- **Cloud Firestore** for data persistence
- **Firebase Secret Manager** for API keys
- **Firebase Hosting** for static assets

### External APIs
| Service | Purpose |
|---------|---------|
| **Google Gemini Flash** | AI analysis of captions and images |
| **AudD** | Audio fingerprinting (optional) |
| **Spotify Web API** | Playlist management via OAuth PKCE |
| **TMDb** | Movie search and metadata |
| **Telegram Bot API** | Webhook for bot commands |
| **Cobalt.tools** | Audio extraction (optional, requires auth) |

### Supported Platforms
| Platform | oEmbed | Badge |
|----------|--------|-------|
| Instagram | ✓ | IG |
| TikTok | ✓ | TT |
| YouTube | ✓ | YT |
| Facebook | ✓ | FB |
| Twitter/X | ✓ | X |
| Reddit | ✓ | RD |
| Vimeo | ✓ | VM |
| Spotify | ✓ | SP |
| SoundCloud | ✓ | SND |
| Threads | OG only | TH |
| Snapchat | OG only | SC |
| Pinterest | OG only | PIN |
| LinkedIn | OG only | LI |
| Twitch | OG only | TW |

## Project Structure

```
soundreel/
├── frontend/
│   ├── src/
│   │   ├── components/    # React components
│   │   ├── pages/         # Route pages
│   │   ├── hooks/         # Custom React hooks
│   │   ├── services/      # API and Firebase services
│   │   ├── types/         # TypeScript definitions
│   │   └── styles/        # CSS
│   └── package.json
├── functions/
│   ├── src/
│   │   ├── services/      # External API integrations
│   │   ├── utils/         # Firestore helpers, logging
│   │   ├── types/         # Shared TypeScript types
│   │   ├── analyzeUrl.ts  # Main analysis endpoint
│   │   └── index.ts       # Function exports
│   └── package.json
├── scripts/               # Deployment scripts
├── firebase.json          # Firebase configuration
├── firestore.rules        # Security rules
└── CHANGELOG.md
```

## Data Model

### Firestore Collections

**`entries`** - Analyzed content
```typescript
{
  id: string;
  sourceUrl: string;
  sourcePlatform: SocialPlatform;
  inputChannel: 'web' | 'telegram';
  caption: string | null;
  thumbnailUrl: string | null;
  status: 'processing' | 'completed' | 'error';
  results: {
    songs: Song[];
    films: Film[];
  };
  actionLog: ActionLogItem[];
  createdAt: Timestamp;
}
```

**`config/spotify`** - OAuth tokens
**`config/features`** - Feature toggles
**`config/prompts`** - AI prompt templates
**`logs`** - Debug logs

## Pipeline Flow

1. **URL Received** → Idempotency check (skip if duplicate, unless disabled)
2. **Content Extraction** → oEmbed (if supported) → OG meta scraping (fallback)
3. **Audio Recognition** → Cobalt audio extraction → AudD fingerprinting (if enabled)
4. **AI Analysis** → Gemini analyzes caption + thumbnail for songs/films
5. **Result Merging** → Combine audio + AI results, deduplicate
6. **Spotify** → Search tracks → Add to playlist
7. **TMDb** → Search films → Get IMDb links
8. **Save** → Update Firestore entry with results

## Configuration

### Environment Variables

Frontend (`.env.production`):
```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FUNCTIONS_URL=https://europe-west1-PROJECT.cloudfunctions.net
```

### Firebase Secrets
```bash
firebase functions:secrets:set GEMINI_API_KEY
firebase functions:secrets:set AUDD_API_KEY
firebase functions:secrets:set SPOTIFY_CLIENT_ID
firebase functions:secrets:set SPOTIFY_CLIENT_SECRET
firebase functions:secrets:set TMDB_API_KEY
firebase functions:secrets:set TELEGRAM_BOT_TOKEN
```

## Deployment

```bash
# Full deploy (frontend + functions)
./scripts/deploy.sh

# Frontend only
./scripts/deploy-hosting.sh

# Functions only
./scripts/deploy-functions.sh
```

## Development

```bash
# Frontend dev server
cd frontend && npm run dev

# Functions emulator
firebase emulators:start --only functions,firestore
```

## Feature Toggles

Available in Settings:
- **Cobalt.tools**: Enable audio extraction (requires JWT auth)
- **Allow Duplicate URLs**: Disable idempotency for testing

## License

Private project - All rights reserved.

---

Built with Claude Code
