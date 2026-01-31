import type { ActionLogItem } from '../types';

export function createActionLog(
  action: string,
  details: Record<string, unknown> = {}
): ActionLogItem {
  return {
    action,
    details,
    timestamp: new Date().toISOString()
  };
}

export function logInfo(message: string, data?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'INFO', message, ...data }));
}

export function logError(message: string, error?: unknown): void {
  const errorDetails = error instanceof Error
    ? { errorMessage: error.message, stack: error.stack }
    : { error };
  console.error(JSON.stringify({ level: 'ERROR', message, ...errorDetails }));
}

export function logWarning(message: string, data?: Record<string, unknown>): void {
  console.warn(JSON.stringify({ level: 'WARNING', message, ...data }));
}
