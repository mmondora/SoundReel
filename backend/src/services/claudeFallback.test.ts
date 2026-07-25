import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { spawn } from 'node:child_process';
import { runClaudePrompt } from './claudeFallback';

/** Minimal stand-in for the spawned CLI process. */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

function cliPayload(result: string, isError = false) {
  return JSON.stringify({ is_error: isError, subtype: isError ? 'error' : 'success', result });
}

describe('runClaudePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
    process.env.CLAUDE_FALLBACK_ENABLED = 'true';
    delete process.env.CLAUDE_FALLBACK_MODEL;
    delete process.env.CLAUDE_FALLBACK_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns disabled when the kill switch is off', async () => {
    process.env.CLAUDE_FALLBACK_ENABLED = 'false';
    const res = await runClaudePrompt('any prompt');
    expect(res.status).toBe('disabled');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns disabled when the token is missing', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const res = await runClaudePrompt('any prompt');
    expect(res.status).toBe('disabled');
    expect(res.reason).toMatch(/token/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns the model text on success', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runClaudePrompt('extract this');
    child.stdout.emit('data', Buffer.from(cliPayload('{"songs":[]}')));
    child.emit('close', 0);

    const res = await promise;
    expect(res.status).toBe('ok');
    expect(res.text).toBe('{"songs":[]}');
  });

  it('writes the prompt to stdin rather than argv', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const prompt = 'a very long untrusted caption';
    const promise = runClaudePrompt(prompt);
    child.stdout.emit('data', Buffer.from(cliPayload('{}')));
    child.emit('close', 0);
    await promise;

    expect(child.stdin.write).toHaveBeenCalledWith(prompt);
    expect(child.stdin.end).toHaveBeenCalled();
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args.join(' ')).not.toContain(prompt);
  });

  it('spawns without a shell and disables all tools', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runClaudePrompt('x');
    child.stdout.emit('data', Buffer.from(cliPayload('{}')));
    child.emit('close', 0);
    await promise;

    const [cmd, args, opts] = vi.mocked(spawn).mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('claude');
    expect(opts.shell).toBeFalsy();
    expect(args).toContain('--disallowedTools');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('dontAsk');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
  });

  it('passes only an allowlisted env to the subprocess', async () => {
    process.env.DB_PASSWORD = 'super-secret';
    process.env.TELEGRAM_BOT_TOKEN = 'tg-secret';
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runClaudePrompt('x');
    child.stdout.emit('data', Buffer.from(cliPayload('{}')));
    child.emit('close', 0);
    await promise;

    const opts = vi.mocked(spawn).mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-test');
    expect(opts.env.DB_PASSWORD).toBeUndefined();
    expect(opts.env.TELEGRAM_BOT_TOKEN).toBeUndefined();

    delete process.env.DB_PASSWORD;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('uses the configured model, defaulting to opus 4.8', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runClaudePrompt('x');
    child.stdout.emit('data', Buffer.from(cliPayload('{}')));
    child.emit('close', 0);
    const res = await promise;

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-8');
    expect(res.model).toBe('claude-opus-4-8');
  });

  it('honours CLAUDE_FALLBACK_MODEL override', async () => {
    process.env.CLAUDE_FALLBACK_MODEL = 'claude-sonnet-5';
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runClaudePrompt('x');
    child.stdout.emit('data', Buffer.from(cliPayload('{}')));
    child.emit('close', 0);
    await promise;

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5');
  });

  it('returns error on non-zero exit', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runClaudePrompt('x');
    child.stderr.emit('data', Buffer.from('boom'));
    child.emit('close', 1);

    const res = await promise;
    expect(res.status).toBe('error');
    expect(res.text).toBeNull();
    expect(res.reason).toContain('boom');
  });

  it('returns error when the CLI reports is_error', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runClaudePrompt('x');
    child.stdout.emit('data', Buffer.from(cliPayload('nope', true)));
    child.emit('close', 0);

    const res = await promise;
    expect(res.status).toBe('error');
  });

  it('returns error on unparseable stdout', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runClaudePrompt('x');
    child.stdout.emit('data', Buffer.from('not json at all'));
    child.emit('close', 0);

    const res = await promise;
    expect(res.status).toBe('error');
  });

  it('kills the child and reports timeout', async () => {
    vi.useFakeTimers();
    process.env.CLAUDE_FALLBACK_TIMEOUT_MS = '5000';
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runClaudePrompt('x');
    await vi.advanceTimersByTimeAsync(5001);

    const res = await promise;
    expect(res.status).toBe('timeout');
    expect(child.kill).toHaveBeenCalled();
  });

  it('never throws when spawn itself fails', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runClaudePrompt('x');
    child.emit('error', new Error('ENOENT: claude not found'));

    const res = await promise;
    expect(res.status).toBe('error');
    expect(res.reason).toContain('ENOENT');
  });
});
