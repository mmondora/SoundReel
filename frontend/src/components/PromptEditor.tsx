import { useState, useMemo } from 'react';
import Handlebars from 'handlebars';
import type { PromptTemplate } from '../types';
import { useLanguage } from '../i18n';

interface PromptEditorProps {
  promptId: string;
  prompt: PromptTemplate;
  onSave: (template: string, name: string, description: string) => Promise<void>;
  onReset: () => Promise<void>;
  saving: boolean;
}

function validateTemplate(tmpl: string): { valid: boolean; error: string | null } {
  try {
    Handlebars.precompile(tmpl);
    return { valid: true, error: null };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function PromptEditor({ promptId, prompt, onSave, onReset, saving }: PromptEditorProps) {
  const { t, language } = useLanguage();
  const [template, setTemplate] = useState(prompt.template);
  const [name, setName] = useState(prompt.name);
  const [description, setDescription] = useState(prompt.description);
  const [hasChanges, setHasChanges] = useState(false);
  const dateLocale = language === 'it' ? 'it-IT' : 'en-US';

  const validation = useMemo(() => validateTemplate(template), [template]);

  const handleTemplateChange = (value: string) => {
    setTemplate(value);
    setHasChanges(true);
  };

  const handleSave = async () => {
    await onSave(template, name, description);
    setHasChanges(false);
  };

  const handleReset = async () => {
    if (confirm(t.resetConfirm)) {
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
          placeholder={t.promptName}
        />
        <span className="prompt-id">{promptId}</span>
      </div>

      <input
        type="text"
        value={description}
        onChange={(e) => { setDescription(e.target.value); setHasChanges(true); }}
        className="prompt-description-input"
        placeholder={t.promptDescription}
      />

      <div className="prompt-variables">
        <span className="variables-label">{t.availableVariables}:</span>
        {prompt.variables.map((v) => (
          <code key={v} className="variable-tag">{'{{' + v + '}}'}</code>
        ))}
      </div>

      <textarea
        value={template}
        onChange={(e) => handleTemplateChange(e.target.value)}
        className={`prompt-textarea ${!validation.valid ? 'template-invalid' : ''}`}
        rows={20}
        spellCheck={false}
      />

      {!validation.valid && (
        <div className="template-validation template-validation-error">
          {t.templateError}: {validation.error}
        </div>
      )}

      <div className="prompt-actions">
        <button
          onClick={handleSave}
          disabled={saving || !hasChanges || !validation.valid}
          className="save-btn"
        >
          {saving ? t.saving : t.save}
        </button>
        <button
          onClick={handleReset}
          disabled={saving}
          className="reset-btn"
        >
          {t.resetDefault}
        </button>
      </div>

      {prompt.updatedAt && (
        <p className="prompt-updated">
          {t.lastUpdated}: {new Date(prompt.updatedAt).toLocaleString(dateLocale)}
        </p>
      )}
    </div>
  );
}
