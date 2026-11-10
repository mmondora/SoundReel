import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchLibrary } from '../services/api';
import type { LibraryItem } from '../services/api';
import { useLanguage } from '../i18n';

export function LibraryPage() {
  const { t, language } = useLanguage();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchLibrary(80)
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  const dateLocale = language === 'it' ? 'it-IT' : 'en-US';

  return (
    <div className="list-page">
      <div className="list-page-content">
        <div className="list-page-header">
          <Link to="/" className="list-page-back">{t.back}</Link>
          <h1>{t.libraryTitle}</h1>
        </div>
        <p className="list-page-hint">{t.libraryHint}</p>

        {loading ? (
          <div className="journal-loading">
            <span className="spinner" />
            <p>{t.loading}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="list-page-empty">{t.libraryEmpty}</div>
        ) : (
          <div className="library-grid">
            {items.map((item) => (
              <Link
                key={item.entryId}
                to={`/?entry=${encodeURIComponent(item.entryId)}`}
                className="library-card"
              >
                {item.thumbnailUrl ? (
                  <img
                    src={item.thumbnailUrl}
                    alt=""
                    className="library-card-thumb"
                    loading="lazy"
                  />
                ) : (
                  <div className="library-card-thumb-empty">{item.videoUrl ? '🎬' : '📄'}</div>
                )}
                <div className="library-card-meta">
                  <div>{item.sourcePlatform}</div>
                  <div>
                    {new Date(item.createdAt).toLocaleDateString(dateLocale, {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </div>
                  <div className="library-card-badges">
                    {item.videoUrl && <span className="library-card-badge">video</span>}
                    {item.audioUrl && <span className="library-card-badge">audio</span>}
                    {item.frameCount > 0 && (
                      <span className="library-card-badge">{item.frameCount} frame</span>
                    )}
                    {item.slideCount > 0 && (
                      <span className="library-card-badge">{item.slideCount} slide</span>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
