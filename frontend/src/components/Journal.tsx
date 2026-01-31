import type { Entry } from '../types';
import { EntryCard } from './EntryCard';

interface JournalProps {
  entries: Entry[];
  loading: boolean;
}

export function Journal({ entries, loading }: JournalProps) {
  if (loading) {
    return (
      <div className="journal-loading">
        <span className="spinner" />
        <p>Caricamento journal...</p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="journal-empty">
        <p>Nessuna entry ancora.</p>
        <p>Incolla un link qui sopra per iniziare!</p>
      </div>
    );
  }

  return (
    <div className="journal">
      {entries.map((entry) => (
        <EntryCard key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
