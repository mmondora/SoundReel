import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../services/firebase';
import { initiateSpotifyAuth, exchangeCodeForTokens } from '../services/spotify';
import { getFeatures, updateFeatures, FeaturesConfig, getInstagramConfig, updateInstagramConfig, InstagramConfigResponse, getPerplexityConfig, updatePerplexityConfig, PerplexityConfigResponse } from '../services/api';
import { useLanguage, Language } from '../i18n';
import type { SpotifyConfig } from '../types';

export function Settings() {
  const [searchParams] = useSearchParams();
  const [spotifyConfig, setSpotifyConfig] = useState<SpotifyConfig | null>(null);
  const [featuresConfig, setFeaturesConfig] = useState<FeaturesConfig | null>(null);
  const [pplxConfig, setPplxConfig] = useState<PerplexityConfigResponse | null>(null);
  const [pplxApiKey, setPplxApiKey] = useState('');
  const [pplxEnabled, setPplxEnabled] = useState(false);
  const [savingPplx, setSavingPplx] = useState(false);
  const [pplxMessage, setPplxMessage] = useState<string | null>(null);
  const [igConfig, setIgConfig] = useState<InstagramConfigResponse | null>(null);
  const [igSessionId, setIgSessionId] = useState('');
  const [igCsrfToken, setIgCsrfToken] = useState('');
  const [igDsUserId, setIgDsUserId] = useState('');
  const [igEnabled, setIgEnabled] = useState(false);
  const [savingIg, setSavingIg] = useState(false);
  const [igMessage, setIgMessage] = useState<string | null>(null);
  const [showIgHowTo, setShowIgHowTo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [savingFeatures, setSavingFeatures] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t, language, setLanguage } = useLanguage();

  useEffect(() => {
    loadConfigs();
  }, []);

  useEffect(() => {
    const code = searchParams.get('code');
    if (code) {
      handleSpotifyCallback(code);
    }
  }, [searchParams]);

  async function loadConfigs() {
    try {
      // Load Spotify config
      const docRef = doc(db, 'config', 'spotify');
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        setSpotifyConfig(docSnap.data() as SpotifyConfig);
      } else {
        setSpotifyConfig({
          accessToken: null,
          refreshToken: null,
          expiresAt: null,
          playlistId: null,
          playlistName: null,
          connected: false
        });
      }

      // Load Features config
      try {
        const features = await getFeatures();
        setFeaturesConfig(features);
      } catch (err) {
        console.error('Error loading features:', err);
        setFeaturesConfig({ cobaltEnabled: false, allowDuplicateUrls: false });
      }

      // Load Perplexity config
      try {
        const pplx = await getPerplexityConfig();
        setPplxConfig(pplx);
        setPplxEnabled(pplx.enabled);
      } catch (err) {
        console.error('Error loading Perplexity config:', err);
      }

      // Load Instagram config
      try {
        const ig = await getInstagramConfig();
        setIgConfig(ig);
        setIgDsUserId(ig.dsUserId || '');
        setIgEnabled(ig.enabled);
      } catch (err) {
        console.error('Error loading Instagram config:', err);
      }
    } catch (err) {
      console.error('Error loading config:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleCobalt() {
    if (!featuresConfig) return;

    setSavingFeatures(true);
    try {
      const newValue = !featuresConfig.cobaltEnabled;
      const result = await updateFeatures({ cobaltEnabled: newValue });
      setFeaturesConfig(result.config);
    } catch (err) {
      console.error('Error updating features:', err);
      setError(t.errorSettings);
    } finally {
      setSavingFeatures(false);
    }
  }

  async function handleToggleDuplicateUrls() {
    if (!featuresConfig) return;

    setSavingFeatures(true);
    try {
      const newValue = !featuresConfig.allowDuplicateUrls;
      const result = await updateFeatures({ allowDuplicateUrls: newValue });
      setFeaturesConfig(result.config);
    } catch (err) {
      console.error('Error updating features:', err);
      setError(t.errorSettings);
    } finally {
      setSavingFeatures(false);
    }
  }

  async function handleSavePerplexity() {
    setSavingPplx(true);
    setPplxMessage(null);
    try {
      const updates: Record<string, string | boolean> = { enabled: pplxEnabled };
      if (pplxApiKey) updates.apiKey = pplxApiKey;

      const result = await updatePerplexityConfig(updates);
      setPplxConfig(result.config);
      setPplxApiKey('');
      setPplxEnabled(result.config.enabled);
      setPplxMessage(t.perplexitySaveSuccess);
    } catch (err) {
      console.error('Error saving Perplexity config:', err);
      setPplxMessage(t.perplexitySaveError);
    } finally {
      setSavingPplx(false);
    }
  }

  async function handleSaveInstagram() {
    setSavingIg(true);
    setIgMessage(null);
    try {
      const updates: Record<string, string | boolean> = { enabled: igEnabled };
      if (igSessionId) updates.sessionId = igSessionId;
      if (igCsrfToken) updates.csrfToken = igCsrfToken;
      if (igDsUserId) updates.dsUserId = igDsUserId;

      const result = await updateInstagramConfig(updates);
      setIgConfig(result.config);
      setIgSessionId('');
      setIgCsrfToken('');
      setIgDsUserId(result.config.dsUserId || '');
      setIgEnabled(result.config.enabled);
      setIgMessage(t.instagramSaveSuccess);
    } catch (err) {
      console.error('Error saving Instagram config:', err);
      setIgMessage(t.instagramSaveError);
    } finally {
      setSavingIg(false);
    }
  }

  async function handleSpotifyCallback(code: string) {
    setConnecting(true);
    setError(null);
    try {
      const tokens = await exchangeCodeForTokens(code);
      const expiresAt = Date.now() + tokens.expiresIn * 1000;

      const config: SpotifyConfig = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt,
        playlistId: null,
        playlistName: 'SoundReel',
        connected: true
      };

      await setDoc(doc(db, 'config', 'spotify'), config);
      setSpotifyConfig(config);

      window.history.replaceState({}, '', '/settings');
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errorGeneric);
    } finally {
      setConnecting(false);
    }
  }

  async function handleConnect() {
    await initiateSpotifyAuth();
  }

  function handleLanguageChange(newLang: Language) {
    setLanguage(newLang);
  }

  if (loading) {
    return (
      <div className="settings">
        <header className="settings-header">
          <Link to="/" className="back-link">{t.backToJournal}</Link>
          <h1>{t.settingsTitle}</h1>
        </header>
        <main className="settings-content">
          <p>{t.loading}</p>
        </main>
      </div>
    );
  }

  return (
    <div className="settings">
      <header className="settings-header">
        <Link to="/" className="back-link">{t.backToJournal}</Link>
        <h1>{t.settingsTitle}</h1>
      </header>
      <main className="settings-content">
        {/* Language Section */}
        <section className="settings-section">
          <h2>{t.language}</h2>
          <div className="feature-toggle">
            <div className="feature-info">
              <p className="feature-description">{t.languageDescription}</p>
            </div>
            <div className="language-selector">
              <button
                className={`lang-btn ${language === 'it' ? 'active' : ''}`}
                onClick={() => handleLanguageChange('it')}
              >
                {t.italian}
              </button>
              <button
                className={`lang-btn ${language === 'en' ? 'active' : ''}`}
                onClick={() => handleLanguageChange('en')}
              >
                {t.english}
              </button>
            </div>
          </div>
        </section>

        {/* Spotify Section */}
        <section className="settings-section">
          <h2>{t.spotify}</h2>
          {spotifyConfig?.connected ? (
            <div className="spotify-connected">
              <p className="status connected">{t.spotifyConnected}</p>
              {spotifyConfig.playlistName && (
                <p>{t.playlist}: {spotifyConfig.playlistName}</p>
              )}
            </div>
          ) : (
            <div className="spotify-disconnected">
              <p>{t.spotifyHint}</p>
              <button
                onClick={handleConnect}
                disabled={connecting}
                className="connect-btn"
              >
                {connecting ? t.connecting : t.connectSpotify}
              </button>
              {error && <p className="error-message">{error}</p>}
            </div>
          )}
        </section>

        {/* Audio Extraction Section */}
        <section className="settings-section">
          <h2>{t.audioExtraction}</h2>
          <div className="feature-toggle">
            <div className="feature-info">
              <h3>{t.cobaltTitle}</h3>
              <p className="feature-description">{t.cobaltDescription}</p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={featuresConfig?.cobaltEnabled ?? false}
                onChange={handleToggleCobalt}
                disabled={savingFeatures}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>
          {featuresConfig?.cobaltEnabled && (
            <p className="feature-warning">{t.cobaltWarning}</p>
          )}

          <div className="feature-toggle" style={{ marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-light)' }}>
            <div className="feature-info">
              <h3>{t.allowDuplicates}</h3>
              <p className="feature-description">{t.allowDuplicatesDescription}</p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={featuresConfig?.allowDuplicateUrls ?? false}
                onChange={handleToggleDuplicateUrls}
                disabled={savingFeatures}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>
        </section>

        {/* Perplexity Section */}
        <section className="settings-section">
          <h2>{t.perplexitySection}</h2>
          <p className="feature-description">{t.perplexityDescription}</p>

          <div className="feature-toggle" style={{ marginTop: '1rem' }}>
            <div className="feature-info">
              <h3>{t.perplexitySection}</h3>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={pplxEnabled}
                onChange={(e) => setPplxEnabled(e.target.checked)}
                disabled={savingPplx}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div style={{ marginTop: '1rem' }}>
            <label className="field-label" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              {t.perplexityApiKey}
            </label>
            <input
              type="password"
              value={pplxApiKey}
              onChange={(e) => setPplxApiKey(e.target.value)}
              placeholder={pplxConfig?.apiKey || ''}
              className="settings-input"
              style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--border-light)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
              disabled={savingPplx}
            />
          </div>

          <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <button
              onClick={handleSavePerplexity}
              disabled={savingPplx}
              className="connect-btn"
            >
              {savingPplx ? t.saving : t.save}
            </button>
            {pplxMessage && (
              <span style={{ fontSize: '0.85rem', color: pplxMessage === t.perplexitySaveSuccess ? 'var(--success)' : 'var(--error)' }}>
                {pplxMessage}
              </span>
            )}
          </div>

          <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            {t.perplexityHowTo}
          </p>

          {pplxConfig?.hasKey && (
            <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--success)' }}>
              {pplxConfig.enabled ? '●' : '○'} API Key: {pplxConfig.apiKey}
            </p>
          )}
        </section>

        {/* Instagram Cookies Section */}
        <section className="settings-section">
          <h2>{t.instagramCookies}</h2>
          <p className="feature-description">{t.instagramCookiesDescription}</p>

          <div className="feature-toggle" style={{ marginTop: '1rem' }}>
            <div className="feature-info">
              <h3>{t.instagramCookies}</h3>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={igEnabled}
                onChange={(e) => setIgEnabled(e.target.checked)}
                disabled={savingIg}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="instagram-fields" style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div>
              <label className="field-label" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {t.instagramSessionId}
              </label>
              <input
                type="password"
                value={igSessionId}
                onChange={(e) => setIgSessionId(e.target.value)}
                placeholder={igConfig?.sessionId || ''}
                className="settings-input"
                style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--border-light)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                disabled={savingIg}
              />
            </div>
            <div>
              <label className="field-label" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {t.instagramCsrfToken}
              </label>
              <input
                type="password"
                value={igCsrfToken}
                onChange={(e) => setIgCsrfToken(e.target.value)}
                placeholder={igConfig?.csrfToken || ''}
                className="settings-input"
                style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--border-light)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                disabled={savingIg}
              />
            </div>
            <div>
              <label className="field-label" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {t.instagramDsUserId}
              </label>
              <input
                type="text"
                value={igDsUserId}
                onChange={(e) => setIgDsUserId(e.target.value)}
                placeholder={igConfig?.dsUserId || ''}
                className="settings-input"
                style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--border-light)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                disabled={savingIg}
              />
            </div>
          </div>

          <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <button
              onClick={handleSaveInstagram}
              disabled={savingIg}
              className="connect-btn"
            >
              {savingIg ? t.saving : t.save}
            </button>
            {igMessage && (
              <span style={{ fontSize: '0.85rem', color: igMessage === t.instagramSaveSuccess ? 'var(--success)' : 'var(--error)' }}>
                {igMessage}
              </span>
            )}
          </div>

          {igConfig?.hasCredentials && (
            <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--success)' }}>
              {igConfig.enabled ? '● ' : '○ '}
              {t.instagramSessionId}: {igConfig.sessionId}
            </p>
          )}

          <div style={{ marginTop: '1rem' }}>
            <button
              onClick={() => setShowIgHowTo(!showIgHowTo)}
              style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.85rem', textDecoration: 'underline', padding: 0 }}
            >
              {t.instagramHowTo}
            </button>
            {showIgHowTo && (
              <pre style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                {t.instagramHowToSteps}
              </pre>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
