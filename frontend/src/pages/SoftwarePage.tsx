import { useEffect, useMemo, useState } from 'react';
import { PostLinks } from '../components/PostLinks';
import { postLabel } from '../utils/postLinks';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { FilterPanel } from '../components/FilterPanel';
import type { FilterSection } from '../components/FilterPanel';
import { DateGroupedList } from '../components/DateGroupedList';
import { fetchSoftware } from '../services/api';
import { filterSoftware, collectSoftwareTags, sortSoftware } from '../utils/softwareFilters';
import type { SoftwareSortMode } from '../utils/softwareFilters';
import { useLanguage } from '../i18n';
import type { AggregatedSoftware, SoftwareTag } from '../types';
import type { Translations } from '../i18n/translations';

const TAG_ICONS: Record<SoftwareTag, string> = {
  repo: '📦',
  product: '🛠',
  article: '📄',
  other: '💻',
};

function tagLabel(tag: SoftwareTag, t: Translations): string {
  const map: Record<SoftwareTag, string> = {
    repo: t.softwareTagRepo,
    product: t.softwareTagProduct,
    article: t.softwareTagArticle,
    other: t.softwareTagOther,
  };
  return map[tag];
}

function formatPublishedAt(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

function SoftwareRow({ item }: { item: AggregatedSoftware }) {
  const { t, language } = useLanguage();
  const locale = language === 'it' ? 'it-IT' : 'en-US';
  return (
    <div className="list-item-row">
      <div className="list-item-icon">{TAG_ICONS[item.tag]}</div>
      <div className="list-item-content">
        <div className="list-item-title">
          {item.url ? (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="film-title-play-link"
            >
              {item.title}
            </a>
          ) : (
            item.title
          )}
        </div>
        {item.description && (
          <div className="list-item-subtitle">{item.description}</div>
        )}
        <div className="list-item-badges">
          <span className="note-category-badge">
            {TAG_ICONS[item.tag]} {tagLabel(item.tag, t)}
          </span>
          {item.publishedAt && (
            <span className="list-item-muted" title={item.publishedAt}>
              {t.softwarePublished} {formatPublishedAt(item.publishedAt, locale)}
            </span>
          )}
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="badge-link"
            >
              {t.softwareOpenLink}
            </a>
          )}
          {item.mentions.length > 1 && (
            <span className="list-item-muted">
              {item.mentions.length} {t.filmsMentions}
            </span>
          )}
        </div>
        {item.otherUrls && item.otherUrls.length > 0 && (
          <div className="post-links" data-testid="software-other-links">
            <span>{t.softwareOtherLinks}</span>
            {item.otherUrls.map((url) => (
              <a key={url} href={url} target="_blank" rel="noopener noreferrer" title={url}>
                {postLabel(url)}
              </a>
            ))}
          </div>
        )}
        <PostLinks mentions={item.mentions} />
      </div>
    </div>
  );
}

export function SoftwarePage() {
  const { t } = useLanguage();

  const [items, setItems] = useState<AggregatedSoftware[]>([]);
  const [loading, setLoading] = useState(true);
  const [textFilter, setTextFilter] = useState('');
  const [tagFilter, setTagFilter] = useState<SoftwareTag[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [sortMode, setSortMode] = useState<SoftwareSortMode>('date');

  useEffect(() => {
    let cancelled = false;
    fetchSoftware()
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        // Forge enrichment runs in the background on the server; refresh once
        // so description + publishedAt appear without a manual reload.
        const needsMeta = list.some((i) => i.tag === 'repo' && i.url && !i.publishedAt);
        if (!needsMeta) return;
        window.setTimeout(() => {
          if (cancelled) return;
          fetchSoftware().then((again) => { if (!cancelled) setItems(again); }).catch(() => undefined);
        }, 4000);
      })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const sorted = useMemo(() => sortSoftware(items, sortMode), [items, sortMode]);
  const tags = useMemo(() => collectSoftwareTags(sorted), [sorted]);
  const visible = useMemo(
    () => filterSoftware(sorted, { tags: tagFilter, text: textFilter }),
    [sorted, tagFilter, textFilter]
  );

  function toggleTag(tag: SoftwareTag) {
    setTagFilter((prev) => (prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag]));
  }

  const activeFilterCount = tagFilter.length;
  const filterSections: FilterSection[] = [
    {
      kind: 'chips',
      label: t.softwareTagSection,
      options: tags.map((tag) => tagLabel(tag, t)),
      selected: tagFilter.map((tag) => tagLabel(tag, t)),
      onToggle: (label) => {
        const tag = tags.find((x) => tagLabel(x, t) === label);
        if (tag) toggleTag(tag);
      },
    },
  ];

  return (
    <div className="list-page">
      <Header />
      <div className="list-page-content">
        <div className="list-page-header">
          <Link to="/" className="list-page-back">{t.back}</Link>
          <h1>{t.allSoftware}</h1>
        </div>

        {!loading && (
          <>
            <div className="platform-shelf-bar" role="tablist" aria-label={t.softwareTagSection}>
              <button
                type="button"
                className={`filter-chip ${tagFilter.length === 0 ? 'active' : ''}`}
                onClick={() => setTagFilter([])}
              >
                {t.filmsFilterAll}
              </button>
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={`filter-chip ${tagFilter.includes(tag) ? 'active' : ''}`}
                  onClick={() => toggleTag(tag)}
                >
                  {TAG_ICONS[tag]} {tagLabel(tag, t)}
                </button>
              ))}
            </div>

            <div className="filter-topbar">
              <input
                type="text"
                className="filter-search"
                placeholder={`🔍 ${t.searchPlaceholder}`}
                value={textFilter}
                onChange={(e) => setTextFilter(e.target.value)}
              />
              <span className="filter-result-count">{visible.length}</span>
              <select
                className="sort-select"
                value={sortMode}
                aria-label={t.sortLabel}
                onChange={(e) => setSortMode(e.target.value as SoftwareSortMode)}
              >
                <option value="date">{t.sortByDate}</option>
                <option value="mentions">{t.sortByMentions}</option>
                <option value="title">{t.sortByTitle}</option>
              </select>
              <button type="button" className="filter-open-btn" onClick={() => setPanelOpen(true)}>
                {t.filtersButton}{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
              </button>
            </div>

            <FilterPanel
              open={panelOpen}
              onClose={() => setPanelOpen(false)}
              title={t.filtersTitle}
              onReset={() => setTagFilter([])}
              resetLabel={t.filtersReset}
              sections={filterSections}
            />
          </>
        )}

        {loading ? (
          <div className="journal-loading">
            <span className="spinner" />
            <p>{t.loading}</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="list-page-empty">{t.noSoftwareYet}</div>
        ) : sortMode === 'date' ? (
          <DateGroupedList
            items={visible}
            pageSize={50}
            getDate={(item) => (item.mentions[0] ? new Date(item.mentions[0].createdAt) : null)}
            renderItem={(item) => <SoftwareRow key={item.softwareKey} item={item} />}
          />
        ) : (
          visible.map((item) => <SoftwareRow key={item.softwareKey} item={item} />)
        )}
      </div>
    </div>
  );
}
