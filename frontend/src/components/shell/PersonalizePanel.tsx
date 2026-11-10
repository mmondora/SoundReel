import { useId, useRef, useState } from 'react';
import { SegmentedControl } from '../SegmentedControl';
import { SaveError } from '../views/SaveError';
import { useSheetFocus } from '../../hooks/useSheetFocus';
import { useUiPrefs } from '../../hooks/useUiPrefs';
import { interpolate, useLanguage } from '../../i18n';
import { HOME_SECTION_TITLE } from '../../utils/homeSectionTitles';
import type { PlayerDock, UiPrefs } from '../../types';

// «Personalizza» (look and feel P4, spec 2026-11-10-web-look-and-feel-rethink-design.md L1, L3, L4): the user chooses where the Player is, which
// sections the Home has and in what order, sees what view every page remembers, and sees that the colours are fixed (Michele: «Il colore non si
// cambia»). Every control writes its part of the configuration on the server (docs/ui-prefs.md) and shows at once; the server decides the rest.

export interface PersonalizePanelProps {
  onClose: () => void;
}

export function PersonalizePanel({ onClose }: PersonalizePanelProps) {
  const { t } = useLanguage();
  const { prefs, loading, update, reset } = useUiPrefs();
  const root = useRef<HTMLElement>(null);
  const onKeyDown = useSheetFocus(root, true, onClose);
  const titleId = useId();
  const [asking, setAsking] = useState(false);

  const docks: Array<{ value: PlayerDock; label: string }> = [
    { value: 'bottom', label: t.playerDockBottom },
    { value: 'float', label: t.playerDockFloat },
    { value: 'side', label: t.playerDockSide },
    { value: 'hidden', label: t.playerDockHidden },
  ];
  const viewNames: Record<UiPrefs['views'][keyof UiPrefs['views']], string> = { home: t.viewHome, studio: t.viewStudio, wall: t.viewWall };

  /** The sections are written ALL together (the order and the switches): a change makes the new list and sends it. */
  const writeSections = (next: UiPrefs['home']['sections']) => { void update({ home: { sections: next } }); };

  const body = (current: UiPrefs) => {
    const list = current.home.sections;
    const toggle = (i: number) => writeSections(list.map((s, j) => (j === i ? { ...s, visible: !s.visible } : s)));
    const move = (i: number, by: -1 | 1) => {
      const j = i + by;
      if (j < 0 || j >= list.length) return;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      writeSections(next);
    };
    return (
      <>
        <section className="personalize-section">
          <h3>{t.personalizePlayer}</h3>
          <SegmentedControl<PlayerDock>
            label={t.personalizePlayerWhere}
            value={current.player.dock}
            options={docks}
            onChange={(dock) => { void update({ player: { dock } }); }}
          />
        </section>

        <section className="personalize-section">
          <h3>{t.personalizeHome}</h3>
          <p className="personalize-hint">{t.personalizeHomeHint}</p>
          <ol className="personalize-sections" aria-label={t.personalizeHome}>
            {list.map((section, i) => {
              const name = t[HOME_SECTION_TITLE[section.id]];
              return (
                <li key={section.id} className="personalize-row">
                  <label className="personalize-row-name">
                    <input type="checkbox" role="switch" checked={section.visible} onChange={() => toggle(i)} />
                    <span>{name}</span>
                  </label>
                  <span className="personalize-arrows">
                    <button type="button" aria-label={interpolate(t.personalizeMoveUp, { name })} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                    <button type="button" aria-label={interpolate(t.personalizeMoveDown, { name })} disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</button>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>

        <section className="personalize-section">
          <h3>{t.personalizeViews}</h3>
          <ul className="personalize-views" aria-label={t.personalizeViews}>
            <li><span>{t.navInbox}</span><b>{viewNames[current.views.inbox]}</b></li>
            <li><span>{t.personalizePageLinks}</span><b>{viewNames[current.views.links]}</b></li>
          </ul>
          <p className="personalize-hint">{t.personalizeViewsHint}</p>
        </section>

        <section className="personalize-section">
          <h3>{t.personalizeColours}</h3>
          <p className="personalize-locked"><span aria-hidden="true">🔒</span> {t.personalizeColoursLocked}</p>
        </section>

        <footer className="personalize-footer">
          {asking ? (
            <>
              <p>{t.personalizeResetAsk}</p>
              <span className="personalize-ask">
                <button type="button" className="personalize-danger" onClick={() => { void reset().then(() => setAsking(false)); }}>{t.personalizeResetYes}</button>
                <button type="button" onClick={() => setAsking(false)}>{t.personalizeResetNo}</button>
              </span>
            </>
          ) : (
            <button type="button" onClick={() => setAsking(true)}>{t.personalizeReset}</button>
          )}
        </footer>
      </>
    );
  };

  return (
    <div className="personalize-scrim" onClick={onClose}>
      <aside
        ref={root}
        className="personalize"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="personalize-head">
          <h2 id={titleId}>{t.personalizeTitle}</h2>
          <button type="button" className="personalize-close" aria-label={t.dismiss} onClick={onClose}>×</button>
        </header>
        <SaveError />
        {prefs ? body(prefs) : loading ? (
          <div className="journal-loading"><span className="spinner" /></div>
        ) : (
          <p className="personalize-hint">{t.personalizeUnavailable}</p>
        )}
      </aside>
    </div>
  );
}
