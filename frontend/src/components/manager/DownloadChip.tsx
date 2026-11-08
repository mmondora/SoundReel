import { useLanguage } from '../../i18n';
import type { DownloadUiState } from '../../player/songDownload';
import '../../styles/manager.css';

/** Small "scaricando… / scaricata / errore" state of the first-play download (web player). */
export function DownloadChip({ state, compact = false }: { state: DownloadUiState | undefined; compact?: boolean }) {
  const { t } = useLanguage();
  if (!state) return null;
  const text =
    state.phase === 'requesting' ? t.playerDlRequesting
      : state.phase === 'downloading' ? t.playerDlDownloading
        : state.phase === 'ready' ? t.playerDlReady
          : state.phase === 'unavailable' ? t.playerDlUnavailable
            : state.phase === 'timeout' ? t.playerDlTimeout
              : t.playerDlFailed;
  const icon = state.phase === 'ready' ? '✓' : state.phase === 'requesting' || state.phase === 'downloading' ? '⬇' : '⚠';
  return (
    <span
      className={`dl-chip dl-chip-${state.phase}`}
      role="status"
      aria-live="polite"
      title={state.error ? `${text}: ${state.error}` : text}
    >
      <span aria-hidden>{icon}</span>
      {compact ? <span className="sr-only">{text}</span> : <> {text}</>}
    </span>
  );
}
