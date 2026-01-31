import { useState } from 'react';
import type { ActionLogItem } from '../types';

interface ActionLogProps {
  log: ActionLogItem[];
}

export function ActionLog({ log }: ActionLogProps) {
  const [expanded, setExpanded] = useState(false);

  if (log.length === 0) return null;

  return (
    <div className="action-log">
      <button
        className="action-log-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? 'Nascondi' : 'Mostra'} dettagli pipeline ({log.length} step)
      </button>
      {expanded && (
        <ul className="action-log-list">
          {log.map((item, index) => (
            <li key={index} className="action-log-item">
              <span className="action-name">{item.action}</span>
              <span className="action-time">
                {new Date(item.timestamp).toLocaleTimeString('it-IT')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
