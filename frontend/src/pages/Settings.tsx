import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../services/firebase';
import { initiateSpotifyAuth, exchangeCodeForTokens } from '../services/spotify';
import { getFeatures, updateFeatures, FeaturesConfig } from '../services/api';
import type { SpotifyConfig } from '../types';

export function Settings() {
  const [searchParams] = useSearchParams();
  const [spotifyConfig, setSpotifyConfig] = useState<SpotifyConfig | null>(null);
  const [featuresConfig, setFeaturesConfig] = useState<FeaturesConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [savingFeatures, setSavingFeatures] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        console.error('Errore caricamento features:', err);
        setFeaturesConfig({ cobaltEnabled: false, allowDuplicateUrls: false });
      }
    } catch (err) {
      console.error('Errore caricamento config:', err);
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
      console.error('Errore aggiornamento features:', err);
      setError('Errore durante l\'aggiornamento delle impostazioni');
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
      console.error('Errore aggiornamento features:', err);
      setError('Errore durante l\'aggiornamento delle impostazioni');
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
      setError(err instanceof Error ? err.message : 'Errore durante la connessione');
    } finally {
      setConnecting(false);
    }
  }

  async function handleConnect() {
    await initiateSpotifyAuth();
  }

  if (loading) {
    return (
      <div className="settings">
        <header className="settings-header">
          <Link to="/" className="back-link">← Torna al Journal</Link>
          <h1>Impostazioni</h1>
        </header>
        <main className="settings-content">
          <p>Caricamento...</p>
        </main>
      </div>
    );
  }

  return (
    <div className="settings">
      <header className="settings-header">
        <Link to="/" className="back-link">← Torna al Journal</Link>
        <h1>Impostazioni</h1>
      </header>
      <main className="settings-content">
        <section className="settings-section">
          <h2>Spotify</h2>
          {spotifyConfig?.connected ? (
            <div className="spotify-connected">
              <p className="status connected">Connesso</p>
              {spotifyConfig.playlistName && (
                <p>Playlist: {spotifyConfig.playlistName}</p>
              )}
            </div>
          ) : (
            <div className="spotify-disconnected">
              <p>Collega il tuo account Spotify per aggiungere automaticamente le canzoni a una playlist.</p>
              <button
                onClick={handleConnect}
                disabled={connecting}
                className="connect-btn"
              >
                {connecting ? 'Connessione...' : 'Collega Spotify'}
              </button>
              {error && <p className="error-message">{error}</p>}
            </div>
          )}
        </section>

        <section className="settings-section">
          <h2>Estrazione Audio</h2>
          <div className="feature-toggle">
            <div className="feature-info">
              <h3>Cobalt.tools</h3>
              <p className="feature-description">
                Estrae l'audio dai video per il riconoscimento musicale tramite AudD.
                Richiede autenticazione API (attualmente non disponibile con l'istanza pubblica).
              </p>
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
            <p className="feature-warning">
              Cobalt potrebbe non funzionare con l'API pubblica. Considera self-hosting.
            </p>
          )}

          <div className="feature-toggle" style={{ marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-light)' }}>
            <div className="feature-info">
              <h3>Ammetti URL duplicati</h3>
              <p className="feature-description">
                Disabilita il controllo di idempotenza. Permette di analizzare lo stesso URL più volte (utile per test).
              </p>
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
