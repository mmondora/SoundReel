import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DetailPanel } from './DetailPanel';
import { LanguageProvider } from '../../i18n';
import { translations } from '../../i18n/translations';

// The detail of a post next to the wall (look and feel P3): a panel that closes. The × and Escape close it; the focus goes into it when it
// opens and goes back to the card that opened it when it closes.

const t = translations.en;

function open(onClose = vi.fn()) {
  return render(
    <LanguageProvider>
      <DetailPanel onClose={onClose}><p>the post</p><input aria-label="inside" /></DetailPanel>
    </LanguageProvider>,
  );
}

describe('the closable detail panel', () => {
  it('is a labelled region with its content and a close button', () => {
    open();
    expect(screen.getByRole('complementary', { name: t.detailLabel })).toHaveTextContent('the post');
    expect(screen.getByRole('button', { name: t.detailClose })).toBeInTheDocument();
  });

  it('the × closes it', async () => {
    const onClose = vi.fn();
    open(onClose);
    await userEvent.click(screen.getByRole('button', { name: t.detailClose }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes it when the focus is inside (also from a field inside)', async () => {
    const onClose = vi.fn();
    open(onClose);
    await userEvent.click(screen.getByLabelText('inside'));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the panel and stops there: whatever surrounds the panel does not also see it', async () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    render(
      <LanguageProvider>
        <div onKeyDown={outer}><DetailPanel onClose={onClose}><input aria-label="inside" /></DetailPanel></div>
      </LanguageProvider>,
    );
    await userEvent.click(screen.getByLabelText('inside'));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('another key does not close it', async () => {
    const onClose = vi.fn();
    open(onClose);
    await userEvent.click(screen.getByLabelText('inside'));
    await userEvent.keyboard('{Enter}a');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape does not close it when the focus is elsewhere on the page', async () => {
    const onClose = vi.fn();
    render(
      <LanguageProvider>
        <button type="button">outside</button>
        <DetailPanel onClose={onClose}><p>the post</p></DetailPanel>
      </LanguageProvider>,
    );
    screen.getByRole('button', { name: 'outside' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the focus goes into the panel when it opens, and back to the card that opened it when it closes', async () => {
    function Page() {
      const [shown, setShown] = useState(false);
      return (
        <LanguageProvider>
          <button type="button" onClick={() => setShown(true)}>card</button>
          {shown && <DetailPanel onClose={() => setShown(false)}><p>the post</p></DetailPanel>}
        </LanguageProvider>
      );
    }
    render(<Page />);
    const card = screen.getByRole('button', { name: 'card' });
    await userEvent.click(card);
    expect(screen.getByRole('button', { name: t.detailClose })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(card).toHaveFocus();
  });

  it('closing does not steal the focus when the card is gone from the page', async () => {
    function Page() {
      const [shown, setShown] = useState(true);
      return (
        <LanguageProvider>
          {shown && <DetailPanel onClose={() => setShown(false)}><p>the post</p></DetailPanel>}
          <button type="button">elsewhere</button>
        </LanguageProvider>
      );
    }
    render(<Page />);
    await userEvent.click(screen.getByRole('button', { name: t.detailClose }));
    expect(screen.queryByRole('complementary')).toBeNull();
  });
});
