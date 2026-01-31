import { useState, FormEvent } from 'react';

interface UrlInputProps {
  onSubmit: (url: string) => void;
  loading: boolean;
  error: string | null;
  success: string | null;
}

export function UrlInput({ onSubmit, loading, error, success }: UrlInputProps) {
  const [url, setUrl] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim() && !loading) {
      onSubmit(url.trim());
      setUrl('');
    }
  };

  return (
    <form className="url-input-form" onSubmit={handleSubmit}>
      <div className="input-wrapper">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Incolla un link da Instagram, TikTok..."
          disabled={loading}
          className="url-input"
        />
        <button type="submit" disabled={loading || !url.trim()} className="submit-btn">
          {loading ? (
            <span className="spinner" />
          ) : (
            'Analizza'
          )}
        </button>
      </div>
      {error && <p className="error-message">{error}</p>}
      {success && <p className="success-message">{success}</p>}
    </form>
  );
}
