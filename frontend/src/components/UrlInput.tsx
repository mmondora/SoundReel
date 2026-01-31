import { useState, FormEvent } from 'react';
import { useLanguage } from '../i18n';
import type { SuccessStatus } from '../hooks/useAnalyze';

interface UrlInputProps {
  onSubmit: (url: string) => void;
  loading: boolean;
  error: string | null;
  successStatus: SuccessStatus;
}

export function UrlInput({ onSubmit, loading, error, successStatus }: UrlInputProps) {
  const [url, setUrl] = useState('');
  const { t } = useLanguage();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim() && !loading) {
      onSubmit(url.trim());
      setUrl('');
    }
  };

  // Translate success status to message
  const successMessage = successStatus === 'existing'
    ? t.urlAlreadyAnalyzed
    : successStatus === 'completed'
      ? t.analysisComplete
      : null;

  // Translate generic error codes
  const errorMessage = error === 'GENERIC_ERROR'
    ? t.errorAnalysis
    : error;

  return (
    <form className="url-input-form" onSubmit={handleSubmit}>
      <div className="input-wrapper">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t.inputPlaceholder}
          disabled={loading}
          className="url-input"
        />
        <button type="submit" disabled={loading || !url.trim()} className="submit-btn">
          {loading ? (
            <span className="spinner" />
          ) : (
            t.analyze
          )}
        </button>
      </div>
      {errorMessage && <p className="error-message">{errorMessage}</p>}
      {successMessage && <p className="success-message">{successMessage}</p>}
    </form>
  );
}
