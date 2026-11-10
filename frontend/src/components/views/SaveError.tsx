import { useUiPrefs } from '../../hooks/useUiPrefs';
import { useLanguage } from '../../i18n';

/** The message of a configuration change the server refused (the view went back), with a × to dismiss it. Nothing when there is none. */
export function SaveError() {
  const { t } = useLanguage();
  const { saveError, clearSaveError } = useUiPrefs();
  if (!saveError) return null;
  return (
    <p className="save-error" role="alert">
      <span>{t.prefsSaveError}</span>
      <button type="button" onClick={clearSaveError} aria-label={t.dismiss}>×</button>
    </p>
  );
}
