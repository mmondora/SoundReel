import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../services/firebase';
import { initiateSpotifyAuth, exchangeCodeForTokens } from '../services/spotify';
import { getFeatures, updateFeatures, FeaturesConfig } from '../services/api';
import { useLanguage, Language } from '../i18n';
import type { SpotifyConfig } from '../types';

export function Settings() {
  const [searchParams] = useSearchParams();
  const [spotifyConfig, setSpotifyConfig] = useState<SpotifyConfig | null>(null);
  const [featuresConfig, setFeaturesConfig] = useState<FeaturesConfig | null>(null);
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
      </main>
    </div>
  );
}
