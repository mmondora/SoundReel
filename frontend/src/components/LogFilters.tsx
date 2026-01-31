import type { LogFilters as LogFiltersType, LogLevel } from '../types';

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
  const levels: Array<LogLevel | 'all'> = ['all', 'debug', 'info', 'warn', 'error'];

  return (
    <div className="log-filters">
      <div className="log-filters-row">
        <div className="filter-group">
          <label>Level</label>
          <select
            value={filters.level}
            onChange={(e) =>
              onFiltersChange({ ...filters, level: e.target.value as LogLevel | 'all' })
            }
          >
            {levels.map((level) => (
              <option key={level} value={level}>
                {level === 'all' ? 'Tutti' : level.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label>Function</label>
          <select
            value={filters.function}
            onChange={(e) =>
              onFiltersChange({ ...filters, function: e.target.value })
            }
          >
            <option value="all">Tutte</option>
            {availableFunctions.map((fn) => (
              <option key={fn} value={fn}>
                {fn}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-group filter-group-search">
          <label>Cerca</label>
          <input
            type="text"
            placeholder="Cerca nei log..."
            value={filters.search}
            onChange={(e) =>
              onFiltersChange({ ...filters, search: e.target.value })
            }
          />
        </div>

        <div className="filter-group">
          <label>Entry ID</label>
          <input
            type="text"
            placeholder="ID entry..."
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
          Cancella Log
        </button>
      </div>
    </div>
  );
}
