import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PromptEditor } from '../components/PromptEditor';
import { useLanguage } from '../i18n';
import type { PromptsConfig, PromptTemplate } from '../types';

const FUNCTIONS_URL = import.meta.env.VITE_FUNCTIONS_URL || '';

type PromptId = keyof PromptsConfig;

export function Prompts() {
  const { t } = useLanguage();
  const [prompts, setPrompts] = useState<PromptsConfig | null>(null);
  const [selectedPrompt, setSelectedPrompt] = useState<PromptId>('contentAnalysis');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const promptLabels: Record<PromptId, { icon: string; label: string }> = {
    contentAnalysis: { icon: 'AI', label: t.contentAnalysis },
    telegramResponse: { icon: 'TG', label: t.telegramResponse }
  };

  useEffect(() => {
    loadPrompts();
  }, []);

  async function loadPrompts() {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`${FUNCTIONS_URL}/getPrompts`);
      if (!response.ok) {
        throw new Error(t.loadError);
      }

      const data = await response.json();
      setPrompts(data.prompts);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errorGeneric);
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
        throw new Error(t.saveError);
      }

      const data = await response.json();

      setPrompts(prev => prev ? {
        ...prev,
        [selectedPrompt]: data.prompt
      } : null);

      setSuccessMessage(t.promptSaved);
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.saveError);
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
        throw new Error(t.resetError);
      }

      const data = await response.json();

      setPrompts(prev => prev ? {
        ...prev,
        [selectedPrompt]: data.prompt
      } : null);

      setSuccessMessage(t.promptReset);
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.resetError);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="prompts-page">
        <header className="settings-header">
          <Link to="/" className="back-link">{t.backToJournal}</Link>
          <h1>{t.promptsTitle}</h1>
        </header>
        <main className="prompts-content">
          <p>{t.loading}</p>
        </main>
      </div>
    );
  }

  return (
    <div className="prompts-page">
      <header className="settings-header">
        <Link to="/" className="back-link">{t.backToJournal}</Link>
        <h1>{t.promptsTitle}</h1>
      </header>

      <main className="prompts-content">
        {error && <div className="error-banner">{error}</div>}
        {successMessage && <div className="success-banner">{successMessage}</div>}

        <div className="prompts-layout">
          <aside className="prompts-sidebar">
            {(Object.keys(promptLabels) as PromptId[]).map((id) => (
              <button
                key={id}
                className={`prompt-tab ${selectedPrompt === id ? 'active' : ''}`}
                onClick={() => setSelectedPrompt(id)}
              >
                <span className="prompt-tab-icon">{promptLabels[id].icon}</span>
                <span className="prompt-tab-label">{promptLabels[id].label}</span>
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
