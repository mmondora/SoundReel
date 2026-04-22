import { query } from '../utils/db';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SENSITIVE_FIELDS = [
  'token', 'apiKey', 'api_key', 'secret', 'password', 'accessToken',
  'refreshToken', 'access_token', 'refresh_token', 'authorization',
  'TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'AUDD_API_KEY', 'TMDB_API_KEY',
  'SPOTIFY_CLIENT_SECRET', 'code_verifier',
];

function sanitizeData(data: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!data) return null;
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_FIELDS.some((f) => lowerKey.includes(f.toLowerCase()))) {
      sanitized[key] = '[REDACTED]';
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const v = sanitizeData(value as Record<string, unknown>);
      if (v !== null) sanitized[key] = v;
    } else {
      sanitized[key] = value;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

export class Logger {
  private functionName: string;
  private entryId: string | null = null;
  private startTime: number | null = null;

  constructor(functionName: string) {
    this.functionName = functionName;
  }

  setEntryId(id: string): void {
    this.entryId = id;
  }

  startTimer(): void {
    this.startTime = Date.now();
  }

  private getDuration(): number | null {
    if (!this.startTime) return null;
    return Date.now() - this.startTime;
  }

  private writeLog(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
    error?: Error
  ): void {
    const sanitized = sanitizeData(data);
    const payload = {
      function: this.functionName,
      durationMs: this.getDuration(),
      data: sanitized,
      error: error ? `${error.name}: ${error.message}\n${error.stack}` : null,
    };

    query(
      `INSERT INTO logs (level, category, entry_id, message, data)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [level, this.functionName, this.entryId, message, JSON.stringify(payload)]
    ).catch((err) => {
      console.error('Failed to write log to Postgres:', err);
    });

    const consoleLog: Record<string, unknown> = {
      severity: level.toUpperCase(),
      function: this.functionName,
      message,
    };
    if (sanitized) consoleLog.data = sanitized;
    if (this.entryId) consoleLog.entryId = this.entryId;
    if (error) consoleLog.error = error.message;
    console.log(JSON.stringify(consoleLog));
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.writeLog('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.writeLog('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.writeLog('warn', message, data);
  }

  error(message: string, error?: Error, data?: Record<string, unknown>): void {
    this.writeLog('error', message, data, error);
  }
}
