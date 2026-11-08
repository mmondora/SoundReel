import { useId } from 'react';
import { useLanguage } from '../../i18n';
import { usePlayer } from '../../player/PlayerContext';
import { SOURCE_MODES } from '../../player/playbackSource';
import type { SourceMode } from '../../player/playbackSource';
import { SegmentedControl } from '../SegmentedControl';
import '../../styles/player.css';

/**
 * The "Sorgente" switch (rule W5): Auto · Internet · Media server. A radio group on the player page, a labelled
 * select in the mini player. The state lives in the player context, so both always agree. The hint says what Auto
 * resolved to and, after a change, that it applies from the next song (a running song is never interrupted).
 */
export function SourceSwitch({ variant = 'full' }: { variant?: 'full' | 'compact' }) {
  const { t } = useLanguage();
  const { sourceMode, setSourceMode, networkStatus, sourceChangePending } = usePlayer();
  const hintId = useId();

  const text: Record<SourceMode, { label: string; title: string }> = {
    auto: { label: t.sourceAuto, title: t.sourceAutoTitle },
    internet: { label: t.sourceInternet, title: t.sourceInternetTitle },
    media: { label: t.sourceMedia, title: t.sourceMediaTitle },
  };

  const autoHint =
    sourceMode !== 'auto' ? null
      : networkStatus === 'internal' ? t.sourceHintInternal
        : networkStatus === 'external' ? t.sourceHintExternal
          : networkStatus === 'failed' ? t.sourceHintFailed
            : null; // no song has asked the server yet: nothing to say
  const hint = [autoHint, sourceChangePending ? t.sourceNextSong : null].filter(Boolean).join(' · ');

  if (variant === 'compact') {
    return (
      <div className="source-switch source-switch-compact">
        <label>
          <span className="sr-only">{t.sourceLabel}</span>
          <select
            value={sourceMode}
            title={`${t.sourceLabel}: ${text[sourceMode].title}`}
            aria-describedby={hintId}
            onChange={(e) => setSourceMode(e.target.value as SourceMode)}
          >
            {SOURCE_MODES.map((mode) => (
              <option key={mode} value={mode}>{text[mode].label}</option>
            ))}
          </select>
        </label>
        <span id={hintId} className="sr-only">{hint}</span>
      </div>
    );
  }

  return (
    <div className="source-switch">
      <SegmentedControl<SourceMode>
        label={t.sourceLabel}
        showLabel
        value={sourceMode}
        describedBy={hintId}
        options={SOURCE_MODES.map((mode) => ({ value: mode, label: text[mode].label, title: text[mode].title }))}
        onChange={setSourceMode}
      />
      <p id={hintId} className="source-switch-hint" role="status">{hint}</p>
    </div>
  );
}
