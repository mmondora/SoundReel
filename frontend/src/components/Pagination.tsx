import { useLanguage, interpolate } from '../i18n';

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
}

export function Pagination({ currentPage, totalPages, onPrev, onNext }: PaginationProps) {
  const { t } = useLanguage();

  if (totalPages <= 1) return null;

  return (
    <div className="pagination-bar">
      <button
        className="pagination-btn"
        onClick={onPrev}
        disabled={currentPage <= 1}
      >
        {t.previousPage}
      </button>
      <span className="pagination-info">
        {interpolate(t.pageOf, { page: currentPage, total: totalPages })}
      </span>
      <button
        className="pagination-btn"
        onClick={onNext}
        disabled={currentPage >= totalPages}
      >
        {t.nextPage}
      </button>
    </div>
  );
}
