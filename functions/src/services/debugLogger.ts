import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  function: string;
  message: string;
  data: Record<string, unknown> | null;
  entryId: string | null;
  durationMs: number | null;
  error: string | null;
}

// Campi sensibili da non loggare mai
const SENSITIVE_FIELDS = [
  'token', 'apiKey', 'api_key', 'secret', 'password', 'accessToken',
  'refreshToken', 'access_token', 'refresh_token', 'authorization',
  'TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'AUDD_API_KEY', 'TMDB_API_KEY',
  'SPOTIFY_CLIENT_SECRET', 'code_verifier'
];

function sanitizeData(data: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!data) return null;

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    // Skip undefined values (Firestore doesn't accept them)
    if (value === undefined) {
      continue;
    }

    const lowerKey = key.toLowerCase();

    // Salta campi sensibili
    if (SENSITIVE_FIELDS.some(field => lowerKey.includes(field.toLowerCase()))) {
      sanitized[key] = '[REDACTED]';
      continue;
    }

    // Ricorsione per oggetti nested
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sanitizedValue = sanitizeData(value as Record<string, unknown>);
      if (sanitizedValue !== null) {
        sanitized[key] = sanitizedValue;
      }
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

  private async writeLog(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
    error?: Error
  ): Promise<void> {
    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      function: this.functionName,
      message,
      data: sanitizeData(data),
      entryId: this.entryId,
      durationMs: this.getDuration(),
      error: error ? `${error.name}: ${error.message}\n${error.stack}` : null
    };

    // Fire-and-forget: non aspettiamo la scrittura
    db.collection('logs').add({
      ...logEntry,
      createdAt: FieldValue.serverTimestamp()
    }).catch(err => {
      // Log solo su console in caso di errore di scrittura
      console.error('Failed to write log to Firestore:', err);
    });

    // Log anche su console per Cloud Logging
    const consoleLog = {
      severity: level.toUpperCase(),
      function: this.functionName,
      message,
      ...(data && { data: sanitizeData(data) }),
      ...(this.entryId && { entryId: this.entryId }),
      ...(error && { error: error.message })
    };
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
