import { SegmentedControl } from '../SegmentedControl';
import { PAGE_VIEWS, usePageView, type PageWithViews } from '../../hooks/useUiPrefs';
import { useLanguage } from '../../i18n';
import type { UiPrefs } from '../../types';
import { SaveError } from './SaveError';

// Look and feel P3 (spec 2026-11-10-web-look-and-feel-rethink-design.md, L1): every page that has views shows the same switch at the top:
// Home (the sections), Studio (list and detail, the default) and Bacheca (the wall of cards). The Link page has no Home. A choice is drawn at
// once and saved for the user on the server; a refusal puts the view back and says so.

export function ViewSwitch<P extends PageWithViews>({ page }: { page: P }) {
  const { t } = useLanguage();
  const { view, ready, setView } = usePageView(page);
  // no first frame with the wrong view: the page waits for the first answer, so does the switch
  if (!ready) return null;
  const names: Record<UiPrefs['views'][PageWithViews], string> = { home: t.viewHome, studio: t.viewStudio, wall: t.viewWall };
  const options = PAGE_VIEWS[page].map((value) => ({ value, label: names[value] }));
  return (
    <div className="view-switch">
      <SegmentedControl<UiPrefs['views'][P]>
        label={t.viewSwitchLabel}
        value={view}
        options={options}
        onChange={setView}
        className="view-switch-seg"
      />
      <SaveError />
    </div>
  );
}
