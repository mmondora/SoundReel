import { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useLogs } from '../hooks/useLogs';
import { LogEntry } from '../components/LogEntry';
import { LogFilters } from '../components/LogFilters';
import type { LogFilters as LogFiltersType } from '../types';

export function Console() {
  const [filters, setFilters] = useState<LogFiltersType>({
    level: 'all',
    function: 'all',
    entryId: null,
    search: ''
  });

  const { logs, loading, error, availableFunctions, clearLogs } = useLogs(filters);

  const handleClearLogs = useCallback(async () => {
    if (!confirm('Sei sicuro di voler cancellare tutti i log?')) {
      return;
    }

    try {
      await clearLogs();
    } catch (err) {
      alert('Errore durante la cancellazione dei log');
    }
  }, [clearLogs]);

  return (
    <div className="console-page">
      <div className="console-header">
        <div className="console-header-left">
          <Link to="/" className="back-link">← Home</Link>
          <h1>Debug Console</h1>
        </div>
        <div className="console-stats">
          <span className="log-count">{logs.length} log</span>
          <span className="live-indicator">LIVE</span>
        </div>
      </div>

      <LogFilters
        filters={filters}
        availableFunctions={availableFunctions}
        onFiltersChange={setFilters}
        onClearLogs={handleClearLogs}
      />

      {error && <div className="console-error">{error}</div>}

      <div className="log-list">
        {loading ? (
          <div className="console-loading">Caricamento log...</div>
        ) : logs.length === 0 ? (
          <div className="console-empty">Nessun log trovato</div>
        ) : (
          logs.map((log) => <LogEntry key={log.id} log={log} />)
        )}
      </div>
    </div>
  );
}
