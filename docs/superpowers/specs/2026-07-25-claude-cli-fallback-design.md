# Claude CLI Fallback for Content Analysis Design

**Date:** 2026-07-25
**Status:** Approved
**Scope:** Add a cascading fallback to the content-analysis step: when the local Ollama model returns an empty result despite having real source text, retry the same prompt through the Claude Code CLI (`claude -p`) running as a subprocess inside the backend container, authenticated with a long-lived subscription token.

---

## Problem

Measured on 606 production entries: **256 of 553 completed entries (46%) are entirely empty** — no summary, no songs, no films, no notes. Investigation of the action logs shows this is not an extraction failure: the pipeline successfully downloads media, transcribes audio (Whisper), and runs OCR, then hands Ollama a full payload (one sampled entry: 1879 chars of OCR text plus caption plus transcript) and `qwen2.5:3b` returns nothing at all — `ai_analyzed {tags: 0, films: 0, links: 0, notes: 0, songs: 0}` with a null summary.

The model, not the data, is the bottleneck. Scaling Ollama up is currently blocked (see Rejected Alternatives).

## Goal

Recover the content lost to local-model failures, without changing the pipeline's cost profile or its behavior on the ~54% of entries where Ollama already works.

## Approach

**Cascade: Ollama first, Claude only on failure.** After the existing Ollama call and JSON parse, if the parsed result is empty *and* there was meaningful source text to analyze, re-run the identical prompt through `claude -p` and use that result instead.

Claude is invoked through the **Claude Code CLI as a subprocess**, not the Anthropic HTTP API, so the call draws on the user's existing Claude Max subscription rather than billing per token.

### Rejected alternative: bigger Ollama model (`qwen2.5:7b`)
Measured on the deployment host (GEEKOM A8 Max):
- The second gpu-router node (`archi-PC`, 192.168.178.23) is **offline** — 100% packet loss, so all Ollama load runs on the GEEKOM.
- The GEEKOM has **no NVIDIA GPU** (`nvidia-smi` absent) — inference is CPU-only.
- RAM: 6.4 GB available of 14 GB, with **swap fully exhausted (4/4 GB)**.
- `qwen2.5:7b` needs ~4.7 GB, risking the OOM killer terminating `soundreel` or `postgres`; CPU-only inference would also be ~2.3× slower.

Deferred until archi-PC (which has the GPU) is back online, at which point it becomes nearly free. `OLLAMA_TEXT_MODEL` is already an env var, so that switch needs no code change.

### Rejected alternative: Anthropic HTTP API (`fetch`)
Would need no Dockerfile change and no CLI, matching the existing `openaiEnrich.ts` pattern — but bills per token instead of using the already-paid-for Max subscription. Rejected on cost.

### Rejected alternative: mounting `~/.claude/.credentials.json` into the container
Verified against the installed CLI (2.1.220): `--bare` mode states *"Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper (OAuth and keychain reads skipped)"*, and the OAuth access token expires roughly every 8 hours with unattended refresh documented as unreliable. Replaced by `claude setup-token`, which issues a **one-year subscription-backed token** passed as `CLAUDE_CODE_OAUTH_TOKEN` — no mount, no expiry churn, no host/container refresh race.

---

## Verified CLI Contract

Validated live against CLI 2.1.220 before design (including one run with a clean `HOME` and no host credentials, simulating the container):

```
echo "<prompt>" | CLAUDE_CODE_OAUTH_TOKEN=<token> claude -p \
  --model <model> \
  --output-format json \
  --disallowedTools "Bash,Read,Write,Edit,Grep,Glob,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite" \
  --permission-mode dontAsk \
  --no-session-persistence \
  --strict-mcp-config
```

Returns a single JSON object on stdout; the fields this design depends on:
- `result` — the model's text output (observed wrapped in ```` ```json ```` fences, so fence-stripping is required)
- `is_error` — boolean
- `subtype` — `"success"` on the happy path

---

## Changes

### New: `backend/src/services/claudeFallback.ts`

```ts
export interface ClaudeFallbackResult {
  status: 'ok' | 'disabled' | 'error' | 'timeout';
  text: string | null;
  reason: string | null;
  durationMs: number;
  model: string;
}

export async function runClaudePrompt(prompt: string): Promise<ClaudeFallbackResult>
```

- Spawns via `child_process.spawn` with an **argument array** (never a shell string) — the prompt is untrusted scraped text, so no shell interpolation is possible.
- Prompt is written to the child's **stdin**, not passed as argv: captions + OCR + transcript routinely reach several KB and would risk `E2BIG`.
- `cwd` is a dedicated empty directory (`/tmp/claude-fallback`) so the CLI's project auto-discovery finds no `CLAUDE.md`, no `.claude/`, and no MCP config to load from the app's source tree.
- `env` passes only `CLAUDE_CODE_OAUTH_TOKEN`, `HOME`, and `PATH` — the rest of the backend environment (DB password, Telegram token, OpenAI key) is **not** inherited by the subprocess.
- Kills the child on timeout (`CLAUDE_FALLBACK_TIMEOUT_MS`, default 120000) and returns `status: 'timeout'`.
- Returns `status: 'disabled'` when `CLAUDE_FALLBACK_ENABLED` is false or the token is missing — never throws.

### Modified: `backend/src/services/aiAnalysis.ts`

After the existing Ollama parse and `baseResult` construction, add a fallback branch:

```ts
const isEmpty = !baseResult.summary
  && baseResult.songs.length === 0
  && baseResult.films.length === 0
  && baseResult.notes.length === 0;
```

Tags and links alone do not count as success — an entry with only hashtags extracted and no summary is the exact failure mode being fixed.

The fallback runs only when `isEmpty` **and** the joined source text (`caption` + `ocrText` + `transcript`) is non-trivial (≥ 40 characters after trimming), so entries that are genuinely empty (a story with no caption, no speech, no on-screen text) do not burn subscription quota.

On fallback success, the Claude output is parsed with the **same** JSON-extraction and link-verification logic already applied to the Ollama output (fence strip → `{...}` match → `JSON.parse` → source-text link verification), so a hallucinated link from Claude is rejected exactly as one from Ollama would be. The refactor extracts that logic into a local helper used by both paths rather than duplicating it.

Prompt reuse: the fallback sends the **identical** rendered `contentAnalysis` template. It stays editable from `/api/prompts` and cannot drift between the two providers.

### Modified: `backend/src/routes/analyze.ts`

Log a `claude_fallback` action so the outcome is visible in the Activity timeline, matching the transparency added for `whisper_asr`:

```
{ status, reason, model, durationMs, recovered: { songs, films, notes, hasSummary } }
```

`analyzeWithAi` returns the fallback outcome alongside its result so the route can log it without the service reaching into the DB layer.

### Modified: `frontend/src/components/ActivityTimeline.tsx`

Add `claude_fallback` to `ACTION_LABELS` (IT: "Fallback Claude", EN: "Claude fallback") and a `getSubtitle` case rendering skipped/error reasons or the recovered counts.

### Modified: `Dockerfile`

In the runtime stage, alongside the existing chromium install:

```dockerfile
RUN npm install -g @anthropic-ai/claude-code
```

### Modified: `docker-compose.yml`

Pass the new variables through to the `soundreel` service:
`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_FALLBACK_MODEL`, `CLAUDE_FALLBACK_ENABLED`, `CLAUDE_FALLBACK_TIMEOUT_MS`.

### Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | *(required)* | Long-lived subscription token from `claude setup-token` |
| `CLAUDE_FALLBACK_MODEL` | `claude-opus-4-8` | Fallback model, swappable without a code change |
| `CLAUDE_FALLBACK_ENABLED` | `true` | Kill switch |
| `CLAUDE_FALLBACK_TIMEOUT_MS` | `120000` | Subprocess timeout |

`OLLAMA_TEXT_MODEL` remains the knob for the primary model, unchanged.

---

## Error Handling

Follows the project's pipeline-resilience convention (CLAUDE.md § Resilienza della pipeline): every fallback failure mode — disabled, missing token, non-zero exit, timeout, unparseable stdout, `is_error: true` — degrades to the original empty Ollama result and is logged to `actionLog`. The fallback can never fail the analysis; the worst case is the status quo before this change.

## Security

- No shell: `spawn` with an argument array, so untrusted caption text cannot inject commands.
- All CLI tools disabled (`--disallowedTools`) plus `--permission-mode dontAsk`, so a prompt-injection payload hidden in a scraped caption cannot make the CLI read files, write files, or reach the network.
- `--strict-mcp-config` prevents loading any MCP server.
- Isolated empty `cwd` so no project config is auto-discovered.
- Minimal `env` allowlist so the subprocess never sees unrelated secrets.

## Testing

`backend/src/services/claudeFallback.test.ts` — `child_process.spawn` mocked (no real CLI invocation, no subscription quota consumed, per the CLAUDE.md rule against real external calls in tests): success path, non-zero exit, timeout kill, malformed stdout, disabled/missing-token short-circuit, and confirmation that the prompt goes to stdin and the env allowlist excludes unrelated secrets.

`backend/src/services/aiAnalysis.test.ts` — extend the existing suite with the cascade logic: fallback triggers when Ollama returns empty with sufficient source text; does not trigger when Ollama succeeds; does not trigger when source text is trivial; Claude output passes through the same link verification.
