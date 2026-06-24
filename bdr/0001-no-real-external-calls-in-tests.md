# BDR-0001: No Real External Calls in Tests

## Status
Accepted

## Date
2026-06-23

## Owners
Michele Mondora

## Related
- `docker-compose.yml` (instaloader, whisper, ocr service definitions)
- `backend/src/services/` (Spotify, Ollama, AudD, Shazam, cobalt clients)
- BDR-0002: Graceful search degradation on Ollama timeout

---

## 1. Context
SoundReel integrates with multiple external services: Instagram/TikTok via instaloader and cobalt.tools, Spotify Web API with OAuth PKCE, AudD music recognition API, Shazam via the instaloader container, Ollama (self-hosted but external to the test process), Whisper, and Telegram. All credentials used in production belong to a single personal account — there are no test accounts, sandbox environments, or separate API keys for testing. Any automated test that makes real network calls risks rate-limiting or permanent bans on these personal accounts. A ban on the Spotify account, for example, would break the entire music-adding feature of the app permanently.

## 2. Decision
No automated test makes real network calls to any external service. All external dependencies — Spotify, Ollama, AudD, Shazam, cobalt.tools, Telegram, instaloader, Whisper, OCR — are mocked in tests.

## 3. Drivers
- Single personal account — no test account isolation possible for Instagram/TikTok
- Instagram's automated access detection can result in permanent account bans
- Spotify rate-limiting and Terms of Service prohibit automated scraping
- cobalt.tools is a third-party open service with no official test environment
- Account bans on a personal app mean zero mitigation — there is no "restore account" process available

## 4. Options Considered

### Option A: Mock all external calls (chosen)
- **Pros**: no account ban risk; tests run offline and fast; CI does not need real credentials; deterministic results; covers error and timeout scenarios easily
- **Cons**: mocks can drift from real API behavior; integration bugs may slip through; requires maintaining mock implementations
- **Product impact**: full test coverage without putting the user's accounts at risk

### Option B: Real calls with dedicated test accounts
- **Pros**: catches real API integration issues; no mock drift
- **Cons**: Instagram does not permit multiple accounts for the same purpose (ToS); creating fake accounts risks banning the real one by association; Spotify developer accounts require app review for extended quota; cobalt.tools has no test mode; maintenance overhead of keeping test accounts active
- **Product impact**: risk of losing the service entirely; ongoing maintenance burden for a personal app

### Option C: No integration tests at all
- **Pros**: zero risk, zero maintenance
- **Cons**: no confidence that pipeline stages work together; regressions in URL parsing, Spotify token refresh, or Ollama prompt format go undetected until production
- **Product impact**: lower confidence in deployments; silent regressions more likely

## 5. Decision Rationale
For a personal single-user app where the service IS the personal account, account safety is an absolute constraint. Option B is not viable because the risk/reward ratio is inverted: test accounts provide modest coverage improvement at the cost of potentially losing the production service. Option C provides no coverage. Option A provides meaningful coverage (pipeline logic, error handling, fallback chains) without risk. The mock drift concern is mitigated by keeping mocks thin and interface-focused rather than behavior-duplicating.

## 6. Consequences

### Positive
- No risk to personal Instagram, Spotify, or Telegram accounts
- Tests run fast (no network latency) and work offline
- CI pipeline (if added) needs zero real credentials
- Error scenarios (Spotify token expiry, Ollama timeout, cobalt failure) easily testable via mocks

### Negative
- Mock drift is a real risk — if Spotify changes their API response format, tests may pass while production fails
- True end-to-end confidence requires manual testing after each external API change
- Mocks require maintenance when external service contracts change

### Follow-ups
- Add contract snapshot tests for critical external APIs (Spotify track search, Ollama completion format) to detect drift early
- Document manual test checklist for post-deploy verification of external integrations

## 7. Guardrails
- CI environment (if configured) must not contain `SPOTIFY_CLIENT_SECRET`, `INSTAGRAM_SESSION`, `AUDD_API_KEY`, or any other real credentials
- Test files importing real HTTP clients must be flagged in code review
- Any test using `fetch`, `axios`, or `http` directly must be reviewed for external call risk

## 8. Migration Plan
Applicable when tests are written. For each service under test:
1. Extract HTTP client behind an interface (e.g., `ISpotifyClient`)
2. Inject real client in production, mock client in tests
3. Mock client returns fixtures captured from real API responses

## 9. Rollback
This decision has no rollback — it is a permanent constraint driven by account safety. If isolated test accounts become available for any service (e.g., Spotify provides a sandbox), the constraint can be relaxed for that specific service only via a new BDR.
