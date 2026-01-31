import type { Entry } from '../types';
import { EntryCard } from './EntryCard';
import { useLanguage } from '../i18n';

interface JournalProps {
  entries: Entry[];
  loading: boolean;
}

export function Journal({ entries, loading }: JournalProps) {
  const { t } = useLanguage();

  if (loading) {
    return (
      <div className="journal-loading">
        <span className="spinner" />
        <p>{t.loading}</p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="journal-empty">
        <p>{t.noEntries}</p>
        <p>{t.noEntriesHint}</p>
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
