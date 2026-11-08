import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { LanguageProvider } from '../../i18n';
import { setStoredLanguage } from '../../i18n/translations';
import { SegmentedControl } from '../SegmentedControl';
import { Heatmap } from './Heatmap';
import { PlaysPerDayChart } from './PlaysPerDayChart';
import { RankList } from './RankList';

const wrap = (ui: React.ReactElement) => render(<LanguageProvider>{ui}</LanguageProvider>);
const ZERO = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

beforeEach(() => {
  setStoredLanguage('en');
});

describe('Heatmap', () => {
  it('says there is no listening instead of inventing a peak', () => {
    wrap(<Heatmap grid={ZERO} />);
    expect(screen.getByRole('img', { name: 'Plays by weekday and local hour: no plays.' })).toBeInTheDocument();
  });

  it('shades only the cells with plays, stronger for more', () => {
    const grid = ZERO.map((r) => [...r]);
    grid[0][7] = 2;
    grid[0][8] = 4;
    const { container } = wrap(<Heatmap grid={grid} />);
    const on = Array.from(container.querySelectorAll('rect.stats-cell.on'));
    expect(on).toHaveLength(2);
    const opacities = on.map((r) => Number(r.getAttribute('fill-opacity')));
    expect(opacities[0]).toBeCloseTo(0.5);
    expect(opacities[1]).toBe(1);
    expect(container.querySelectorAll('rect.stats-cell:not(.on)')).toHaveLength(7 * 24 - 2);
  });
});

describe('PlaysPerDayChart', () => {
  it('draws one bar per day with plays and none for the empty days in between', () => {
    const { container } = wrap(
      <PlaysPerDayChart days={[
        { day: '2026-11-01', plays: 2, listenedMs: 60_000 },
        { day: '2026-11-04', plays: 4, listenedMs: 120_000 },
      ]} />,
    );
    expect(container.querySelectorAll('rect.stats-bar-rect')).toHaveLength(2);
    expect(screen.getByRole('img', { name: /4 days, 6 plays in total, the busiest day has 4/ })).toBeInTheDocument();
    // The listing keeps only what the server sent.
    expect(within(screen.getByRole('table', { name: 'Plays per day' })).getAllByRole('row')).toHaveLength(3);
  });

  it('copes with no data at all', () => {
    const { container } = wrap(<PlaysPerDayChart days={[]} />);
    expect(container.querySelectorAll('rect.stats-bar-rect')).toHaveLength(0);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });
});

describe('RankList', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, label: `Song ${i}`, sublabel: i === 0 ? 'Air' : null, plays: 12 - i, listenedMs: null }));

  it('shows the top 10 as an ordered list with bars relative to the first', () => {
    const { container } = wrap(<RankList title="Top" items={items} />);
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText('Song 0')).toBeInTheDocument();
    expect(screen.getByText(/— Air/)).toBeInTheDocument();
    expect(screen.queryByText('Song 10')).toBeNull();
    const bars = Array.from(container.querySelectorAll('.stats-rank-bar > span')).map((b) => (b as HTMLElement).style.width);
    expect(bars[0]).toBe('100%');
    expect(parseFloat(bars[9])).toBeCloseTo((3 / 12) * 100, 0);
  });

  it('uses the singular for one play and the label function for raw ids', () => {
    wrap(<RankList title="Origins" items={[{ key: 'web', label: 'web', sublabel: null, plays: 1, listenedMs: 90_000 }]} labelOf={() => 'Web player'} />);
    expect(screen.getByText('Web player')).toBeInTheDocument();
    expect(screen.getByText(/1 play · 1 min/)).toBeInTheDocument();
  });

  it('says so when there is nothing', () => {
    wrap(<RankList title="Top" items={[]} />);
    expect(screen.getByText('No data in this period')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('SegmentedControl', () => {
  it('is a labelled group of radios and reports the chosen value once', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl<'a' | 'b' | 'c'>
        label="Source"
        value="a"
        options={[{ value: 'a', label: 'Auto' }, { value: 'b', label: 'Internet' }, { value: 'c', label: 'Media server', disabled: true }]}
        onChange={onChange}
      />,
    );
    const group = screen.getByRole('group', { name: 'Source' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'Auto' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Media server' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Internet' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('b');
    fireEvent.click(screen.getByRole('radio', { name: 'Auto' })); // already chosen: no change event
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
