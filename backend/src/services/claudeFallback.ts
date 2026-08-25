import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { logInfo, logWarning } from '../utils/logger';

export interface ClaudeFallbackResult {
  status: 'ok' | 'disabled' | 'error' | 'timeout';
  text: string | null;
  reason: string | null;
  durationMs: number;
  model: string;
}

const DEFAULT_MODEL = 'claude-opus-4-8';
/**
 * Second passes fall back on a light model.
 *
 * A reanalyse makes this fallback *more* likely, not less: it fires when Ollama
 * comes back empty on a source text above a length threshold, and the whole
 * point of the pass is that it adds a transcript — which pushes entries that
 * previously fell under that threshold over it. An 83-entry backfill of
 * claude-opus-4-8 at roughly thirteen seconds a call is still tens of minutes
 * of a subscription quota the user also needs for their own work — the count
 * was corrected down from 488 (that figure counted every media dir with audio,
 * not the ones actually missing a transcript) and the decision is unchanged,
 * because the cheap model costs nothing to prefer and the backfill is not the
 * only thing that fires this path.
 *
 * The fallback stays, because an entry where the local model stays silent is
 * exactly the one a transcript was supposed to rescue. It just gets cheap.
 */
const DEFAULT_REANALYZE_MODEL = 'haiku';
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Working directory for the CLI subprocess. Deliberately a dedicated empty dir:
 * the CLI auto-discovers CLAUDE.md / .claude/ / MCP config from its cwd, and the
 * app's source tree contains all three. Running from here means it finds none.
 */
const CLI_CWD = '/tmp/claude-fallback';

/**
 * Every tool the CLI can invoke. The prompt carries untrusted scraped text
 * (Instagram captions, OCR output), so a prompt-injection payload must not be
 * able to make the CLI touch the filesystem or the network.
 */
const DISALLOWED_TOOLS = 'Bash,Read,Write,Edit,Grep,Glob,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite';

interface ClaudeCliEnvelope {
  is_error?: boolean;
  result?: string;
  subtype?: string;
}

function isEnabled(): boolean {
  return (process.env.CLAUDE_FALLBACK_ENABLED ?? 'true') !== 'false';
}

function getModel(): string {
  return process.env.CLAUDE_FALLBACK_MODEL || DEFAULT_MODEL;
}

function getReanalyzeModel(): string {
  return process.env.REANALYZE_FALLBACK_MODEL || DEFAULT_REANALYZE_MODEL;
}

export interface ClaudePromptOptions {
  /**
   * This prompt belongs to a second analysis pass, so it runs on the light
   * model. Callers say why rather than which: the choice of model lives here,
   * where both env vars are read, so no call site can pick the wrong one.
   */
  reanalyze?: boolean;
}

function getTimeoutMs(): number {
  const raw = Number(process.env.CLAUDE_FALLBACK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Run a prompt through the Claude Code CLI and return its raw text output.
 *
 * Never throws: every failure path (disabled, missing token, spawn failure,
 * non-zero exit, timeout, unparseable output) resolves to a non-'ok' status so
 * callers can fall back to whatever they already had.
 */
export async function runClaudePrompt(
  prompt: string,
  opts: ClaudePromptOptions = {}
): Promise<ClaudeFallbackResult> {
  const model = opts.reanalyze ? getReanalyzeModel() : getModel();
  const started = Date.now();

  if (!isEnabled()) {
    return { status: 'disabled', text: null, reason: 'CLAUDE_FALLBACK_ENABLED=false', durationMs: 0, model };
  }

  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    return { status: 'disabled', text: null, reason: 'CLAUDE_CODE_OAUTH_TOKEN non configurato', durationMs: 0, model };
  }

  const args = [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--disallowedTools', DISALLOWED_TOOLS,
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--strict-mcp-config',
  ];

  // spawn() fails with ENOENT if cwd is missing, and /tmp can be wiped between
  // container restarts — create it every time rather than relying on the image.
  try {
    mkdirSync(CLI_CWD, { recursive: true });
  } catch (err) {
    return { status: 'error', text: null, reason: `cwd non creabile: ${String(err)}`, durationMs: 0, model };
  }

  return new Promise<ClaudeFallbackResult>((resolve) => {
    let settled = false;
    const finish = (res: Omit<ClaudeFallbackResult, 'durationMs' | 'model'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...res, durationMs: Date.now() - started, model });
    };

    // Allowlist, not inheritance: the backend env holds the DB password, the
    // Telegram bot token and the OpenAI key, none of which the CLI needs.
    const child = spawn('claude', args, {
      cwd: CLI_CWD,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: CLI_CWD,
        CLAUDE_CODE_OAUTH_TOKEN: token,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ status: 'timeout', text: null, reason: `timeout dopo ${getTimeoutMs()}ms` });
    }, getTimeoutMs());

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });

    child.on('error', (err) => {
      finish({ status: 'error', text: null, reason: String(err) });
    });

    child.on('close', (code) => {
      if (code !== 0) {
        finish({ status: 'error', text: null, reason: stderr.trim() || `exit code ${code}` });
        return;
      }

      let envelope: ClaudeCliEnvelope;
      try {
        envelope = JSON.parse(stdout) as ClaudeCliEnvelope;
      } catch {
        finish({ status: 'error', text: null, reason: `stdout non parsabile: ${stdout.slice(0, 200)}` });
        return;
      }

      if (envelope.is_error || typeof envelope.result !== 'string') {
        finish({ status: 'error', text: null, reason: `CLI ha riportato un errore (subtype=${envelope.subtype})` });
        return;
      }

      finish({ status: 'ok', text: envelope.result, reason: null });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export function logFallbackOutcome(res: ClaudeFallbackResult): void {
  if (res.status === 'ok') {
    logInfo('Fallback Claude riuscito', { model: res.model, durationMs: res.durationMs });
  } else {
    logWarning('Fallback Claude non utilizzabile', { status: res.status, reason: res.reason, model: res.model });
  }
}
