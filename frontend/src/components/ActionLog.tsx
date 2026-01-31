import { useState } from 'react';
import type { ActionLogItem } from '../types';
import { useLanguage } from '../i18n';

interface ActionLogProps {
  log: ActionLogItem[];
}

export function ActionLog({ log }: ActionLogProps) {
  const [expanded, setExpanded] = useState(false);
  const { t, language } = useLanguage();
  const timeLocale = language === 'it' ? 'it-IT' : 'en-US';

  if (log.length === 0) return null;

  return (
    <div className="action-log">
      <button
        className="action-log-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? t.hideLog : t.showLog} ({log.length} step)
      </button>
      {expanded && (
        <ul className="action-log-list">
          {log.map((item, index) => (
            <li key={index} className="action-log-item">
              <span className="action-name">{item.action}</span>
              <span className="action-time">
                {new Date(item.timestamp).toLocaleTimeString(timeLocale)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
