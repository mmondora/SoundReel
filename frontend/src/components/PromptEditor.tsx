import { useState } from 'react';
import type { PromptTemplate } from '../types';

interface PromptEditorProps {
  promptId: string;
  prompt: PromptTemplate;
  onSave: (template: string, name: string, description: string) => Promise<void>;
  onReset: () => Promise<void>;
  saving: boolean;
}

export function PromptEditor({ promptId, prompt, onSave, onReset, saving }: PromptEditorProps) {
  const [template, setTemplate] = useState(prompt.template);
  const [name, setName] = useState(prompt.name);
  const [description, setDescription] = useState(prompt.description);
  const [hasChanges, setHasChanges] = useState(false);

  const handleTemplateChange = (value: string) => {
    setTemplate(value);
    setHasChanges(true);
  };

  const handleSave = async () => {
    await onSave(template, name, description);
    setHasChanges(false);
  };

  const handleReset = async () => {
    if (confirm('Sei sicuro di voler ripristinare il template di default?')) {
      await onReset();
      setHasChanges(false);
    }
  };

  return (
    <div className="prompt-editor">
      <div className="prompt-header">
        <input
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setHasChanges(true); }}
          className="prompt-name-input"
          placeholder="Nome del prompt"
        />
        <span className="prompt-id">{promptId}</span>
      </div>

      <input
        type="text"
        value={description}
        onChange={(e) => { setDescription(e.target.value); setHasChanges(true); }}
        className="prompt-description-input"
        placeholder="Descrizione"
      />

      <div className="prompt-variables">
        <span className="variables-label">Variabili disponibili:</span>
        {prompt.variables.map((v) => (
          <code key={v} className="variable-tag">{'{{' + v + '}}'}</code>
        ))}
      </div>

      <textarea
        value={template}
        onChange={(e) => handleTemplateChange(e.target.value)}
        className="prompt-textarea"
        rows={20}
        spellCheck={false}
      />

      <div className="prompt-actions">
        <button
          onClick={handleSave}
          disabled={saving || !hasChanges}
          className="save-btn"
        >
          {saving ? 'Salvataggio...' : 'Salva'}
        </button>
        <button
          onClick={handleReset}
          disabled={saving}
          className="reset-btn"
        >
          Ripristina default
        </button>
      </div>

      {prompt.updatedAt && (
        <p className="prompt-updated">
          Ultimo aggiornamento: {new Date(prompt.updatedAt).toLocaleString('it-IT')}
        </p>
      )}
    </div>
  );
}
