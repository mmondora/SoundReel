import { useState, FormEvent } from 'react';
import { useLanguage } from '../i18n';
import type { SuccessStatus } from '../hooks/useAnalyze';

interface UrlInputProps {
  onSubmit: (url: string) => void;
  loading: boolean;
  error: string | null;
  successStatus: SuccessStatus;
  /** Larger hero layout for the Home inbox. */
  hero?: boolean;
}

export function UrlInput({ onSubmit, loading, error, successStatus, hero = false }: UrlInputProps) {
  const [url, setUrl] = useState('');
  const { t } = useLanguage();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim() && !loading) {
      onSubmit(url.trim());
      setUrl('');
    }
  };

  const successMessage = successStatus === 'existing'
    ? t.urlAlreadyAnalyzed
    : successStatus === 'completed'
      ? t.analysisComplete
      : null;

  const errorMessage = error === 'GENERIC_ERROR'
    ? t.errorAnalysis
    : error;

  return (
    <form className={`url-input-form${hero ? ' url-input-form--hero' : ''}`} onSubmit={handleSubmit}>
      {hero && (
        <div className="analyze-hero-copy">
          <h1 className="analyze-hero-title">{t.analyzeHeroTitle}</h1>
          <p className="analyze-hero-sub">{t.analyzeHeroSub}</p>
        </div>
      )}
      <div className={`input-wrapper${hero ? ' input-wrapper--hero' : ''}`}>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t.inputPlaceholder}
          disabled={loading}
          className="url-input"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" disabled={loading || !url.trim()} className="submit-btn">
          {loading ? (
            <span className="spinner" />
          ) : (
            t.analyze
          )}
        </button>
      </div>
      {hero && (
        <p className="analyze-hero-platforms">{t.analyzeHeroPlatforms}</p>
      )}
      {errorMessage && <p className="error-message">{errorMessage}</p>}
      {successMessage && <p className="success-message">{successMessage}</p>}
    </form>
  );
}
