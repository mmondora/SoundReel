import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { useSheetFocus } from './useSheetFocus';

function Sheet({ active, onClose }: { active: boolean; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const onKeyDown = useSheetFocus(root, active, onClose);
  return (
    <div ref={root} tabIndex={-1} data-testid="sheet" onKeyDown={onKeyDown}>
      <button>first</button>
      <input aria-label="middle" />
      <button disabled>disabled</button>
      <button>last</button>
    </div>
  );
}

function Page({ open, active = true, onClose = vi.fn() }: { open: boolean; active?: boolean; onClose?: () => void }) {
  return (
    <div>
      <button>opener</button>
      {open && <Sheet active={active} onClose={onClose} />}
    </div>
  );
}

describe('useSheetFocus', () => {
  it('moves focus into the sheet when it opens and gives it back when it closes', () => {
    const view = render(<Page open={false} />);
    screen.getByText('opener').focus();
    view.rerender(<Page open />);
    expect(screen.getByTestId('sheet')).toHaveFocus();
    view.rerender(<Page open={false} />);
    expect(screen.getByText('opener')).toHaveFocus();
  });

  it('Escape closes it, and only it', () => {
    const onClose = vi.fn();
    render(<Page open onClose={onClose} />);
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(screen.getByTestId('sheet'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled(); // not passed on to whatever is behind
    document.removeEventListener('keydown', outer);
  });

  it('Tab at the end goes back to the start and Shift+Tab at the start goes to the end (the disabled button is skipped)', () => {
    render(<Page open />);
    const last = screen.getByText('last');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(screen.getByText('first')).toHaveFocus();
    fireEvent.keyDown(screen.getByText('first'), { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('Tab from the sheet itself (where focus lands on open) goes to the first control, Shift+Tab to the last', () => {
    render(<Page open />);
    const sheet = screen.getByTestId('sheet');
    expect(sheet).toHaveFocus();
    fireEvent.keyDown(sheet, { key: 'Tab', shiftKey: true });
    expect(screen.getByText('last')).toHaveFocus();
    sheet.focus();
    fireEvent.keyDown(sheet, { key: 'Tab' });
    expect(screen.getByText('first')).toHaveFocus();
  });

  it('Tab in the middle is left to the browser', () => {
    render(<Page open />);
    const middle = screen.getByLabelText('middle');
    middle.focus();
    const proceeded = fireEvent.keyDown(middle, { key: 'Tab' });
    expect(proceeded).toBe(true); // not prevented
    expect(middle).toHaveFocus();
  });

  it('a panel that is just part of the page (not active) moves nothing and traps nothing', () => {
    const onClose = vi.fn();
    const view = render(<Page open={false} active={false} onClose={onClose} />);
    screen.getByText('opener').focus();
    view.rerender(<Page open active={false} onClose={onClose} />);
    expect(screen.getByText('opener')).toHaveFocus();
  });
});
