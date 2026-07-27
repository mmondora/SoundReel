import { useEffect } from 'react';

export type FilterSection =
  | {
      kind: 'chips';
      label: string;
      options: string[];
      selected: string[];
      onToggle: (value: string) => void;
    }
  | {
      kind: 'radio';
      label: string;
      options: Array<{ key: string; label: string }>;
      value: string;
      onChange: (value: string) => void;
    }
  | {
      kind: 'toggle';
      label: string;
      value: boolean;
      onChange: (value: boolean) => void;
    };

interface FilterPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  onReset: () => void;
  resetLabel: string;
  sections: FilterSection[];
}

/**
 * Presentational, generic overlay drawer for filter sections. Filters apply
 * live on change (no Applica button) — this component only owns open/close
 * and reset wiring; all filter state lives in the calling page.
 */
export function FilterPanel({ open, onClose, title, onReset, resetLabel, sections }: FilterPanelProps) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="filter-panel-backdrop" onClick={onClose} />
      <div className="filter-panel" role="dialog" aria-label={title} aria-modal="true">
        <div className="filter-panel-header">
          <h2>{title}</h2>
          <button type="button" className="filter-panel-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="filter-panel-body">
          {sections.map((section, i) => {
            if (section.kind === 'toggle') {
              return (
                <div key={i} className="filter-section filter-section-toggle">
                  <span className="filter-section-label">{section.label}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={section.value}
                    className={`filter-switch ${section.value ? 'active' : ''}`}
                    onClick={() => section.onChange(!section.value)}
                  >
                    <span className="filter-switch-thumb" />
                  </button>
                </div>
              );
            }

            return (
              <div key={i} className="filter-section">
                <div className="filter-section-label">{section.label}</div>
                {section.kind === 'chips' && (
                  <div className="filter-section-chips">
                    {section.options.map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        className={`genre-chip ${section.selected.includes(opt) ? 'active' : ''}`}
                        onClick={() => section.onToggle(opt)}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                )}
                {section.kind === 'radio' && (
                  <div className="filter-segment">
                    {section.options.map((opt) => (
                      <button
                        key={opt.key}
                        type="button"
                        className={section.value === opt.key ? 'active' : ''}
                        onClick={() => section.onChange(opt.key)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="filter-panel-footer">
          <button type="button" className="filter-panel-reset" onClick={onReset}>
            {resetLabel}
          </button>
        </div>
      </div>
    </>
  );
}
