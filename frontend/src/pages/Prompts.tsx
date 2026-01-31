import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PromptEditor } from '../components/PromptEditor';
import type { PromptsConfig, PromptTemplate } from '../types';

const FUNCTIONS_URL = import.meta.env.VITE_FUNCTIONS_URL || '';

type PromptId = keyof PromptsConfig;

const PROMPT_LABELS: Record<PromptId, { icon: string; label: string }> = {
  contentAnalysis: { icon: 'AI', label: 'Analisi Contenuto' },
  telegramResponse: { icon: 'TG', label: 'Risposta Telegram' }
};

export function Prompts() {
  const [prompts, setPrompts] = useState<PromptsConfig | null>(null);
  const [selectedPrompt, setSelectedPrompt] = useState<PromptId>('contentAnalysis');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    loadPrompts();
  }, []);

  async function loadPrompts() {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`${FUNCTIONS_URL}/getPrompts`);
      if (!response.ok) {
        throw new Error('Errore nel caricamento dei prompt');
      }

      const data = await response.json();
      setPrompts(data.prompts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore sconosciuto');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(template: string, name: string, description: string) {
    try {
      setSaving(true);
      setError(null);
      setSuccessMessage(null);

      const response = await fetch(`${FUNCTIONS_URL}/updatePrompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          promptId: selectedPrompt,
          template,
          name,
          description
        })
      });

      if (!response.ok) {
        throw new Error('Errore nel salvataggio');
      }

      const data = await response.json();

      setPrompts(prev => prev ? {
        ...prev,
        [selectedPrompt]: data.prompt
      } : null);

      setSuccessMessage('Prompt salvato con successo!');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore nel salvataggio');
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    try {
      setSaving(true);
      setError(null);

      const response = await fetch(`${FUNCTIONS_URL}/resetPrompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId: selectedPrompt })
      });

      if (!response.ok) {
        throw new Error('Errore nel reset');
      }

      const data = await response.json();

      setPrompts(prev => prev ? {
        ...prev,
        [selectedPrompt]: data.prompt
      } : null);

      setSuccessMessage('Prompt ripristinato!');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore nel reset');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="prompts-page">
        <header className="settings-header">
          <Link to="/" className="back-link">← Torna al Journal</Link>
          <h1>Prompt Templates</h1>
        </header>
        <main className="prompts-content">
          <p>Caricamento...</p>
        </main>
      </div>
    );
  }

  return (
    <div className="prompts-page">
      <header className="settings-header">
        <Link to="/" className="back-link">← Torna al Journal</Link>
        <h1>Prompt Templates</h1>
      </header>

      <main className="prompts-content">
        {error && <div className="error-banner">{error}</div>}
        {successMessage && <div className="success-banner">{successMessage}</div>}

        <div className="prompts-layout">
          <aside className="prompts-sidebar">
            {(Object.keys(PROMPT_LABELS) as PromptId[]).map((id) => (
              <button
                key={id}
                className={`prompt-tab ${selectedPrompt === id ? 'active' : ''}`}
                onClick={() => setSelectedPrompt(id)}
              >
                <span className="prompt-tab-icon">{PROMPT_LABELS[id].icon}</span>
                <span className="prompt-tab-label">{PROMPT_LABELS[id].label}</span>
              </button>
            ))}
          </aside>

          <div className="prompts-main">
            {prompts && prompts[selectedPrompt] && (
              <PromptEditor
                key={selectedPrompt}
                promptId={selectedPrompt}
                prompt={prompts[selectedPrompt] as PromptTemplate}
                onSave={handleSave}
                onReset={handleReset}
                saving={saving}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
