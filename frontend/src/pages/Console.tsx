import { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useLogs } from '../hooks/useLogs';
import { LogEntry } from '../components/LogEntry';
import { LogFilters } from '../components/LogFilters';
import { useLanguage } from '../i18n';
import type { LogFilters as LogFiltersType } from '../types';

export function Console() {
  const { t } = useLanguage();
  const [filters, setFilters] = useState<LogFiltersType>({
    level: 'all',
    function: 'all',
    entryId: null,
    search: ''
  });

  const { logs, loading, error, availableFunctions, clearLogs } = useLogs(filters);

  const handleClearLogs = useCallback(async () => {
    if (!confirm(t.confirmClearLogs)) {
      return;
    }

    try {
      await clearLogs();
    } catch (err) {
      alert(t.clearLogsError);
    }
  }, [clearLogs, t]);

  return (
    <div className="console-page">
      <div className="console-header">
        <div className="console-header-left">
          <Link to="/" className="back-link">← {t.home}</Link>
          <h1>{t.debugConsole}</h1>
        </div>
        <div className="console-stats">
          <span className="log-count">{logs.length} {t.logs}</span>
          <span className="live-indicator">{t.live}</span>
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
          <div className="console-loading">{t.loadingLogs}</div>
        ) : logs.length === 0 ? (
          <div className="console-empty">{t.noLogsFound}</div>
        ) : (
          logs.map((log) => <LogEntry key={log.id} log={log} />)
        )}
      </div>
    </div>
  );
}
