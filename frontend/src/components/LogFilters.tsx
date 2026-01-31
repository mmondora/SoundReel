import type { LogFilters as LogFiltersType, LogLevel } from '../types';
import { useLanguage } from '../i18n';

interface LogFiltersProps {
  filters: LogFiltersType;
  availableFunctions: string[];
  onFiltersChange: (filters: LogFiltersType) => void;
  onClearLogs: () => void;
}

export function LogFilters({
  filters,
  availableFunctions,
  onFiltersChange,
  onClearLogs
}: LogFiltersProps) {
  const { t } = useLanguage();
  const levels: Array<LogLevel | 'all'> = ['all', 'debug', 'info', 'warn', 'error'];

  return (
    <div className="log-filters">
      <div className="log-filters-row">
        <div className="filter-group">
          <label>{t.level}</label>
          <select
            value={filters.level}
            onChange={(e) =>
              onFiltersChange({ ...filters, level: e.target.value as LogLevel | 'all' })
            }
          >
            {levels.map((level) => (
              <option key={level} value={level}>
                {level === 'all' ? t.allLevels : level.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label>{t.function}</label>
          <select
            value={filters.function}
            onChange={(e) =>
              onFiltersChange({ ...filters, function: e.target.value })
            }
          >
            <option value="all">{t.allFunctions}</option>
            {availableFunctions.map((fn) => (
              <option key={fn} value={fn}>
                {fn}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-group filter-group-search">
          <label>{t.search}</label>
          <input
            type="text"
            placeholder={t.searchLogs}
            value={filters.search}
            onChange={(e) =>
              onFiltersChange({ ...filters, search: e.target.value })
            }
          />
        </div>

        <div className="filter-group">
          <label>{t.entryId}</label>
          <input
            type="text"
            placeholder="ID..."
            value={filters.entryId || ''}
            onChange={(e) =>
              onFiltersChange({
                ...filters,
                entryId: e.target.value || null
              })
            }
          />
        </div>

        <button className="btn-clear-logs" onClick={onClearLogs}>
          {t.clearLogs}
        </button>
      </div>
    </div>
  );
}
