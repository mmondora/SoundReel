import { useId } from 'react';
import '../styles/controls.css';

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
  /** Extra hint read by screen readers and shown as a tooltip. */
  title?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string | number> {
  /** Accessible name of the group (read aloud; also shown when `showLabel`). */
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  showLabel?: boolean;
  className?: string;
  /** Said after the label, e.g. "now playing from Media server". */
  describedBy?: string;
}

/**
 * A row of mutually exclusive choices built on real radio inputs: arrow keys, one tab stop, form semantics and the
 * `radio` role come for free, so there is no ARIA to get wrong. Looks like a segmented button.
 */
export function SegmentedControl<T extends string | number>({
  label,
  value,
  options,
  onChange,
  showLabel = false,
  className,
  describedBy,
}: SegmentedControlProps<T>) {
  const name = useId();
  return (
    <fieldset className={`seg${className ? ` ${className}` : ''}`} aria-describedby={describedBy}>
      <legend className={showLabel ? 'seg-legend' : 'sr-only'}>{label}</legend>
      <div className="seg-row">
        {options.map((opt) => (
          <label key={String(opt.value)} className="seg-opt" title={opt.title}>
            <input
              type="radio"
              name={name}
              value={String(opt.value)}
              checked={opt.value === value}
              disabled={opt.disabled}
              onChange={() => onChange(opt.value)}
            />
            <span>{opt.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
