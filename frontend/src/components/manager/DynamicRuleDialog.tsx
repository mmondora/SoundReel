import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { fetchDynamicPresets } from '../../services/api';
import { interpolate, useLanguage } from '../../i18n';
import type { DynamicOrder, DynamicPreset, DynamicRule } from '../../types';
import {
  LIMIT_MAX,
  LIMIT_MIN,
  NAME_MAX,
  ORDERS,
  crossesMidnight,
  describeRule,
  formToRule,
  ignoresListening,
  ignoresWindow,
  periodOptions,
  ruleToForm,
  validateForm,
} from '../../utils/dynamicRule';
import type { RuleForm, RuleIssueCode } from '../../utils/dynamicRule';
import { useRuleLabels } from '../../hooks/useRuleLabels';
import { DialogFrame } from './DialogFrame';

export interface DynamicRuleDialogProps {
  /** `create` = F2 (a name and a rule); `edit` = F4 on a dynamic playlist (the rule only: the name cannot change). */
  mode: 'create' | 'edit';
  initialName: string;
  initialRule: DynamicRule | null;
  /** Genres of the library with their song counts, for the "Tipo (genere)" chips. */
  genres: ReadonlyArray<{ name: string; count: number }>;
  onSubmit: (name: string, rule: DynamicRule) => Promise<boolean>;
  onClose: () => void;
}

const toggled = <T,>(list: readonly T[], value: T): T[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

/**
 * Rule editor of a dynamic playlist (docs/mondrop-stats.md §4): name, whose listening, period, time window (local
 * time, may cross midnight), days, genres, order, limit, minimum plays, downloaded only, with presets from the
 * backend. All the rules live in utils/dynamicRule (unit-tested); this is the form around them.
 */
export function DynamicRuleDialog({ mode, initialName, initialRule, genres, onSubmit, onClose }: DynamicRuleDialogProps) {
  const { t } = useLanguage();
  const uid = useId();
  const [form, setForm] = useState<RuleForm>(() => ruleToForm(initialRule, initialName));
  const [presets, setPresets] = useState<DynamicPreset[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchDynamicPresets()
      .then((list) => { if (!cancelled) setPresets(Array.isArray(list) ? list : []); })
      .catch(() => { /* presets are a convenience: the editor works without them */ });
    return () => { cancelled = true; };
  }, []);

  const set = (patch: Partial<RuleForm>) => setForm((f) => ({ ...f, ...patch }));

  const labels = useRuleLabels();

  const issues = validateForm(form, { needsName: mode === 'create' });
  const issueText: Record<RuleIssueCode, string> = {
    nameRequired: t.dynIssueNameRequired,
    nameTooLong: t.dynIssueNameLong,
    limitRange: t.dynIssueLimit,
    minPlaysRange: t.dynIssueMinPlays,
    windowTime: t.dynIssueWindowTime,
    windowEmpty: t.dynIssueWindowEmpty,
  };
  const neverPlayed = form.order === 'never_played';
  // "newest" looks at the library and "liked" at the likes of the person, not at the listening: period, family, window and the minimum of plays do not count
  const newest = ignoresListening(form.order);
  const windowIgnored = ignoresWindow(form.order);
  const midnight = form.windowEnabled && !windowIgnored && crossesMidnight(form.from, form.to);
  const summary = issues.length === 0 ? describeRule(formToRule(form), labels) : null;

  function applyPreset(id: string) {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    // The preset fills the rule; the name is only suggested when nothing was typed yet.
    setForm((f) => ({ ...ruleToForm(preset.rule, f.name.trim() ? f.name : preset.label) }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (issues.length > 0 || busy) return;
    setBusy(true);
    try {
      const ok = await onSubmit(form.name.trim(), formToRule(form));
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  }

  const orderLabel: Record<DynamicOrder, string> = {
    most_played: t.dynOrderMost,
    least_played: t.dynOrderLeast,
    recent: t.dynOrderRecent,
    never_played: t.dynOrderNever,
    newest: t.dynOrderNewest,
    liked: t.dynOrderLiked,
  };

  return (
    <DialogFrame
      title={mode === 'create' ? t.dynTitleNew : interpolate(t.dynTitleEdit, { name: initialName })}
      onClose={onClose}
      locked={busy}
      className="mgr-dialog-wide"
    >
      <form className="mgr-form dyn-form" onSubmit={(e) => void submit(e)}>
        <p className="mgr-help">{t.dynIntro}</p>

        {presets.length > 0 && (
          <label className="mgr-field">
            <span>{t.dynPreset}</span>
            <select className="mgr-select" value="" onChange={(e) => applyPreset(e.target.value)}>
              <option value="">{t.dynPresetNone}</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
        )}

        {mode === 'create' ? (
          <label className="mgr-field">
            <span>{t.dynName}</span>
            <input
              className="mgr-input"
              type="text"
              value={form.name}
              maxLength={NAME_MAX + 20}
              data-autofocus
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
        ) : (
          <p className="mgr-help">{t.dynName}: <strong>{initialName}</strong> — {t.dynNameFixed}</p>
        )}

        <fieldset className="mgr-facet">
          <legend>{t.dynScope}</legend>
          <div className="mgr-radios">
            {(['me', 'family'] as const).map((scope) => (
              <label key={scope} className="mgr-radio">
                <input type="radio" name={`${uid}-scope`} checked={form.scope === scope} disabled={newest} onChange={() => set({ scope })} />
                <span>{scope === 'me' ? t.dynScopeMe : t.dynScopeFamily}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mgr-filter-row">
          <label className="mgr-field">
            <span>{t.dynOrder}</span>
            <select className="mgr-select" value={form.order} onChange={(e) => set({ order: e.target.value as DynamicOrder })}>
              {ORDERS.map((o) => (
                <option key={o} value={o}>{orderLabel[o]}</option>
              ))}
            </select>
          </label>
          <label className="mgr-field">
            <span>{t.dynPeriod}</span>
            <select className="mgr-select" value={form.period} disabled={newest} onChange={(e) => set({ period: e.target.value })}>
              {periodOptions(form.period).map((p) => (
                <option key={p} value={p}>{p === 'all' ? t.dynPeriodAll : interpolate(t.dynPeriodDays, { n: p })}</option>
              ))}
            </select>
          </label>
          <label className="mgr-field">
            <span>{t.dynLimit}</span>
            <input
              className="mgr-input"
              type="number"
              inputMode="numeric"
              min={LIMIT_MIN}
              max={LIMIT_MAX}
              value={form.limit}
              onChange={(e) => set({ limit: e.target.value })}
            />
          </label>
          <label className="mgr-field">
            <span>{t.dynMinPlays}</span>
            <input
              className="mgr-input"
              type="number"
              inputMode="numeric"
              min={0}
              value={form.minPlays}
              disabled={neverPlayed || newest}
              onChange={(e) => set({ minPlays: e.target.value })}
            />
          </label>
        </div>

        {newest && <p className="mgr-help">{form.order === 'liked' ? t.dynLikedNote : t.dynNewestNote}</p>}

        <fieldset className="mgr-facet" disabled={windowIgnored}>
          <legend>{t.dynWindowEnable}</legend>
          <label className="mgr-check">
            <input type="checkbox" checked={form.windowEnabled && !windowIgnored} onChange={(e) => set({ windowEnabled: e.target.checked })} />
            <span>{t.dynWindowEnable}</span>
          </label>
          {neverPlayed && <p className="mgr-help">{t.dynWindowIgnored}</p>}
          {form.windowEnabled && !windowIgnored && (
            <>
              <div className="mgr-filter-row">
                <label className="mgr-field">
                  <span>{t.dynFrom}</span>
                  <input className="mgr-input" type="time" value={form.from} onChange={(e) => set({ from: e.target.value })} />
                </label>
                <label className="mgr-field">
                  <span>{t.dynTo}</span>
                  <input className="mgr-input" type="time" value={form.to} onChange={(e) => set({ to: e.target.value })} />
                </label>
              </div>
              <p className="mgr-help">{t.dynWindowLocal}</p>
              {midnight && (
                <p className="mgr-help dyn-midnight" role="note">
                  {interpolate(t.dynCrossesMidnight, { from: form.from, to: form.to })}
                </p>
              )}
              <div className="dyn-days" role="group" aria-label={t.dynDays}>
                {t.dynDaysShort.map((short, i) => {
                  const day = i + 1;
                  const on = form.days.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      className={`mgr-chip${on ? ' on' : ''}`}
                      aria-pressed={on}
                      aria-label={t.dynDaysLong[i]}
                      onClick={() => set({ days: toggled(form.days, day).sort((a, b) => a - b) })}
                    >
                      {short}
                    </button>
                  );
                })}
              </div>
              <p className="mgr-help">{t.dynDaysAll}</p>
            </>
          )}
        </fieldset>

        {genres.length > 0 && (
          <fieldset className="mgr-facet">
            <legend>{t.dynGenres}</legend>
            <div className="mgr-chips">
              {genres.map((g) => {
                const on = form.genres.includes(g.name);
                return (
                  <button
                    key={g.name}
                    type="button"
                    className={`mgr-chip${on ? ' on' : ''}`}
                    aria-pressed={on}
                    onClick={() => set({ genres: toggled(form.genres, g.name) })}
                  >
                    {g.name} <span className="mgr-chip-count">{g.count}</span>
                  </button>
                );
              })}
            </div>
            <p className="mgr-help">{t.dynGenresHint}</p>
          </fieldset>
        )}

        <label className="mgr-check">
          <input type="checkbox" checked={form.downloadedOnly} onChange={(e) => set({ downloadedOnly: e.target.checked })} />
          <span>{t.dynDownloadedOnly}</span>
        </label>

        {summary && (
          <p className="dyn-summary" data-testid="rule-summary">
            <strong>{t.dynSummary}:</strong> {summary}
          </p>
        )}
        {issues.length > 0 && (
          <ul className="mgr-error dyn-issues" role="alert">
            {issues.map((i) => (
              <li key={i.code}>{issueText[i.code]}</li>
            ))}
          </ul>
        )}

        <div className="mgr-dialog-foot-inline">
          <button type="button" className="mgr-btn" onClick={onClose} disabled={busy}>{t.playlistCancel}</button>
          <button type="submit" className="mgr-btn mgr-btn-primary" disabled={busy || issues.length > 0}>
            {mode === 'create' ? t.dynCreate : t.dynSave}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}
