import { useMemo, useState } from 'react';
import { Pagination } from './Pagination';
import { useLanguage } from '../i18n';

interface DateGroupedListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  getDate: (item: T) => Date | null;
  pageSize?: number;
  emptyMessage?: string;
}

function formatMonthHeader(date: Date, lang: string, todayLabel: string, yesterdayLabel: string): string {
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) return todayLabel;
  if (isYesterday) return yesterdayLabel;

  return date.toLocaleDateString(lang === 'it' ? 'it-IT' : 'en-US', {
    month: 'long',
    year: 'numeric',
  });
}

function getMonthKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}`;
}

function getDayKey(date: Date): string {
  return date.toDateString();
}

export function DateGroupedList<T>({
  items,
  renderItem,
  getDate,
  pageSize = 20,
  emptyMessage,
}: DateGroupedListProps<T>) {
  const { t, language } = useLanguage();
  const [currentPage, setCurrentPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);

  const pagedItems = useMemo(() => {
    const start = (safeCurrentPage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, safeCurrentPage, pageSize]);

  const grouped = useMemo(() => {
    const groups: { key: string; label: string; items: { item: T; index: number }[] }[] = [];
    let lastDayKey = '';
    let lastMonthKey = '';

    pagedItems.forEach((item, idx) => {
      const date = getDate(item);
      if (!date) {
        if (groups.length === 0) {
          groups.push({ key: 'unknown', label: '', items: [] });
        }
        groups[groups.length - 1].items.push({ item, index: idx });
        return;
      }

      const dayKey = getDayKey(date);
      const monthKey = getMonthKey(date);
      const now = new Date();
      const isRecent = (now.getTime() - date.getTime()) < 7 * 86400000;

      const groupKey = isRecent ? dayKey : monthKey;

      if (groupKey !== (isRecent ? lastDayKey : lastMonthKey)) {
        const label = formatMonthHeader(date, language, t.today, t.yesterday);
        groups.push({ key: groupKey, label, items: [] });
        if (isRecent) lastDayKey = dayKey;
        else lastMonthKey = monthKey;
      }

      groups[groups.length - 1].items.push({ item, index: idx });
    });

    return groups;
  }, [pagedItems, getDate, language, t.today, t.yesterday]);

  if (items.length === 0 && emptyMessage) {
    return <div className="list-page-empty">{emptyMessage}</div>;
  }

  return (
    <div className="date-grouped-list">
      {grouped.map((group) => (
        <div key={group.key} className="date-group">
          {group.label && (
            <div className="date-group-header">{group.label}</div>
          )}
          {group.items.map(({ item, index }) => (
            <div key={index}>{renderItem(item, index)}</div>
          ))}
        </div>
      ))}
      <Pagination
        currentPage={safeCurrentPage}
        totalPages={totalPages}
        onPrev={() => setCurrentPage(p => Math.max(1, p - 1))}
        onNext={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
      />
    </div>
  );
}
