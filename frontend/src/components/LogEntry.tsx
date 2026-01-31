import { useState } from 'react';
import type { LogEntry as LogEntryType } from '../types';

interface LogEntryProps {
  log: LogEntryType;
}

const levelColors: Record<string, string> = {
  debug: '#6b7280',
  info: '#3b82f6',
  warn: '#f59e0b',
  error: '#ef4444'
};

const levelIcons: Record<string, string> = {
  debug: 'D',
  info: 'I',
  warn: 'W',
  error: 'E'
};

export function LogEntry({ log }: LogEntryProps) {
  const [expanded, setExpanded] = useState(false);

  const formatTime = (timestamp: string) => {
    try {
      const date = new Date(timestamp);
      const time = date.toLocaleTimeString('it-IT', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      const ms = date.getMilliseconds().toString().padStart(3, '0');
      return `${time}.${ms}`;
    } catch {
      return timestamp;
    }
  };

  const hasDetails = log.data || log.error || log.durationMs;

  return (
    <div
      className="log-entry"
      style={{ borderLeftColor: levelColors[log.level] }}
      onClick={() => hasDetails && setExpanded(!expanded)}
    >
      <div className="log-entry-header">
        <span
          className="log-level"
          style={{ backgroundColor: levelColors[log.level] }}
        >
          {levelIcons[log.level]}
        </span>
        <span className="log-time">{formatTime(log.timestamp)}</span>
        <span className="log-function">{log.function}</span>
        <span className="log-message">{log.message}</span>
        {log.entryId && (
          <span className="log-entry-id" title={log.entryId}>
            {log.entryId.substring(0, 8)}
          </span>
        )}
        {log.durationMs && (
          <span className="log-duration">{log.durationMs}ms</span>
        )}
        {hasDetails && (
          <span className="log-expand">{expanded ? '-' : '+'}</span>
        )}
      </div>

      {expanded && hasDetails && (
        <div className="log-entry-details">
          {log.data && (
            <div className="log-data">
              <strong>Data:</strong>
              <pre>{JSON.stringify(log.data, null, 2)}</pre>
            </div>
          )}
          {log.error && (
            <div className="log-error">
              <strong>Error:</strong>
              <pre>{log.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
