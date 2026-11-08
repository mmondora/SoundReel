import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DynamicRuleDialog } from './DynamicRuleDialog';
import { LanguageProvider } from '../../i18n';
import { setStoredLanguage } from '../../i18n/translations';
import * as api from '../../services/api';
import type { DynamicPreset, DynamicRule } from '../../types';

vi.mock('../../services/api', () => ({ fetchDynamicPresets: vi.fn() }));

const GENRES = [{ name: 'Rock', count: 40 }, { name: 'Jazz', count: 12 }, { name: 'Trap', count: 3 }];

const PRESETS: DynamicPreset[] = [
  { id: 'morning', label: 'Mattina (7–8)', rule: { v: 1, scope: 'me', period: { days: 30 }, window: { from: '07:00', to: '08:00', days: [1, 2, 3, 4, 5] }, order: 'most_played', limit: 30, minPlays: 1, downloadedOnly: false } },
  { id: 'night', label: 'La notte', rule: { v: 1, scope: 'family', period: { days: 14 }, window: { from: '22:00', to: '06:00' }, order: 'most_played', limit: 50, minPlays: 2, genres: ['Jazz'], downloadedOnly: true } },
];

const EDIT_RULE: DynamicRule = { v: 1, scope: 'me', period: { days: 90 }, order: 'least_played', limit: 25, minPlays: 1, downloadedOnly: false };

function renderDialog(over: Partial<React.ComponentProps<typeof DynamicRuleDialog>> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(true);
  const onClose = vi.fn();
  render(
    <LanguageProvider>
      <DynamicRuleDialog mode="create" initialName="" initialRule={null} genres={GENRES} onSubmit={onSubmit} onClose={onClose} {...over} />
    </LanguageProvider>,
  );
  const dialog = screen.getByRole('dialog');
  return { dialog: within(dialog), onSubmit, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  setStoredLanguage('en');
  vi.mocked(api.fetchDynamicPresets).mockResolvedValue(PRESETS);
});

describe('DynamicRuleDialog: creating', () => {
  it('needs a name; the create button stays disabled until the form is valid', async () => {
    const { dialog } = renderDialog();
    const create = dialog.getByRole('button', { name: 'Create the playlist' });
    expect(create).toBeDisabled();
    expect(dialog.getByRole('alert')).toHaveTextContent('A name is required.');
    fireEvent.change(dialog.getByRole('textbox', { name: 'Name' }), { target: { value: 'Road trip' } });
    expect(create).toBeEnabled();
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('submits the wire rule of the contract (name trimmed)', async () => {
    const { dialog, onSubmit, onClose } = renderDialog();
    fireEvent.change(dialog.getByRole('textbox', { name: 'Name' }), { target: { value: '  Mattina  ' } });
    fireEvent.click(dialog.getByRole('radio', { name: 'The whole family' }));
    fireEvent.change(dialog.getByRole('combobox', { name: 'Period' }), { target: { value: '7' } });
    fireEvent.change(dialog.getByRole('combobox', { name: 'Order' }), { target: { value: 'recent' } });
    fireEvent.change(dialog.getByRole('spinbutton', { name: 'Maximum songs (1–200)' }), { target: { value: '30' } });
    fireEvent.change(dialog.getByRole('spinbutton', { name: 'Minimum plays' }), { target: { value: '2' } });
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Only listening within a time window' }));
    fireEvent.change(dialog.getByLabelText('From'), { target: { value: '07:00' } });
    fireEvent.change(dialog.getByLabelText('To'), { target: { value: '08:00' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Monday' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Friday' }));
    fireEvent.click(dialog.getByRole('button', { name: /^Rock/ }));
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Downloaded songs only' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Create the playlist' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith('Mattina', {
      v: 1,
      scope: 'family',
      period: { days: 7 },
      window: { from: '07:00', to: '08:00', days: [1, 5] },
      order: 'recent',
      limit: 30,
      minPlays: 2,
      genres: ['Rock'],
      downloadedOnly: true,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('keeps the dialog open when the backend refuses', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    const { dialog, onClose } = renderDialog({ onSubmit });
    fireEvent.change(dialog.getByRole('textbox', { name: 'Name' }), { target: { value: 'X' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Create the playlist' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('DynamicRuleDialog: presets', () => {
  it('a preset fills the form and suggests its label as the name when none was typed', async () => {
    const { dialog } = renderDialog();
    const select = await dialog.findByRole('combobox', { name: 'Preset' });
    fireEvent.change(select, { target: { value: 'night' } });
    expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('La notte');
    expect(dialog.getByRole('radio', { name: 'The whole family' })).toBeChecked();
    expect(dialog.getByRole('combobox', { name: 'Period' })).toHaveValue('14'); // an unusual period is offered too
    expect(dialog.getByLabelText('From')).toHaveValue('22:00');
    expect(dialog.getByLabelText('To')).toHaveValue('06:00');
    expect(dialog.getByRole('button', { name: /^Jazz/ })).toHaveAttribute('aria-pressed', 'true');
    expect(dialog.getByRole('checkbox', { name: 'Downloaded songs only' })).toBeChecked();
  });

  it('keeps a name that was already typed', async () => {
    const { dialog } = renderDialog();
    fireEvent.change(dialog.getByRole('textbox', { name: 'Name' }), { target: { value: 'My own' } });
    fireEvent.change(await dialog.findByRole('combobox', { name: 'Preset' }), { target: { value: 'morning' } });
    expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('My own');
    expect(dialog.getByLabelText('From')).toHaveValue('07:00');
    expect(dialog.getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'true');
    expect(dialog.getByRole('button', { name: 'Saturday' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('works without presets (backend not there yet)', async () => {
    vi.mocked(api.fetchDynamicPresets).mockRejectedValue(new Error('HTTP 404'));
    const { dialog } = renderDialog();
    await waitFor(() => expect(api.fetchDynamicPresets).toHaveBeenCalled());
    expect(dialog.queryByRole('combobox', { name: 'Preset' })).not.toBeInTheDocument();
    expect(dialog.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
  });
});

describe('DynamicRuleDialog: the time window', () => {
  const enableWindow = (dialog: ReturnType<typeof renderDialog>['dialog']) =>
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Only listening within a time window' }));

  it('says so when the window crosses midnight (from later than to), and not otherwise', () => {
    const { dialog } = renderDialog();
    enableWindow(dialog);
    fireEvent.change(dialog.getByLabelText('From'), { target: { value: '22:00' } });
    fireEvent.change(dialog.getByLabelText('To'), { target: { value: '06:00' } });
    expect(dialog.getByRole('note')).toHaveTextContent('Crosses midnight: from 22:00 in the evening to 06:00 the next day.');
    fireEvent.change(dialog.getByLabelText('To'), { target: { value: '23:30' } });
    expect(dialog.queryByRole('note')).not.toBeInTheDocument();
    expect(dialog.getByText('Local time of the listening (not the server’s).')).toBeInTheDocument();
  });

  it('refuses an empty window (same start and end)', () => {
    const { dialog } = renderDialog({ initialName: 'x' });
    fireEvent.change(dialog.getByRole('textbox', { name: 'Name' }), { target: { value: 'x' } });
    enableWindow(dialog);
    fireEvent.change(dialog.getByLabelText('From'), { target: { value: '08:00' } });
    fireEvent.change(dialog.getByLabelText('To'), { target: { value: '08:00' } });
    expect(dialog.getByRole('alert')).toHaveTextContent('Start and end are the same');
    expect(dialog.getByRole('button', { name: 'Create the playlist' })).toBeDisabled();
  });

  it('"never played" has no time window and no minimum plays', () => {
    const { dialog } = renderDialog();
    enableWindow(dialog);
    fireEvent.change(dialog.getByRole('combobox', { name: 'Order' }), { target: { value: 'never_played' } });
    expect(dialog.getByText('The time window does not apply to never-played songs.')).toBeInTheDocument();
    expect(dialog.getByRole('spinbutton', { name: 'Minimum plays' })).toBeDisabled();
    expect(dialog.queryByLabelText('From')).not.toBeInTheDocument();
  });
});

describe('DynamicRuleDialog: validation and summary', () => {
  it('the limit must be 1–200', () => {
    const { dialog } = renderDialog();
    fireEvent.change(dialog.getByRole('textbox', { name: 'Name' }), { target: { value: 'x' } });
    const limit = dialog.getByRole('spinbutton', { name: 'Maximum songs (1–200)' });
    fireEvent.change(limit, { target: { value: '201' } });
    expect(dialog.getByRole('alert')).toHaveTextContent('1 to 200');
    fireEvent.change(limit, { target: { value: '200' } });
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a readable summary of the rule as it is edited', () => {
    const { dialog } = renderDialog({ initialName: 'x' });
    fireEvent.change(dialog.getByRole('textbox', { name: 'Name' }), { target: { value: 'x' } });
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Only listening within a time window' }));
    expect(dialog.getByTestId('rule-summary')).toHaveTextContent('Most played · 07:00–08:00 · last 30 days · max 50');
    fireEvent.click(dialog.getByRole('button', { name: /^Jazz/ }));
    expect(dialog.getByTestId('rule-summary')).toHaveTextContent('Jazz');
  });
});

describe('DynamicRuleDialog: editing a rule', () => {
  it('fills the form from the rule; the name is shown but cannot be changed', async () => {
    const { dialog, onSubmit } = renderDialog({ mode: 'edit', initialName: 'Notte', initialRule: EDIT_RULE });
    expect(dialog.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    expect(dialog.getByText(/The name of a dynamic playlist cannot be changed/)).toBeInTheDocument();
    expect(dialog.getByRole('combobox', { name: 'Order' })).toHaveValue('least_played');
    expect(dialog.getByRole('combobox', { name: 'Period' })).toHaveValue('90');
    expect(dialog.getByRole('spinbutton', { name: 'Maximum songs (1–200)' })).toHaveValue(25);

    fireEvent.change(dialog.getByRole('spinbutton', { name: 'Maximum songs (1–200)' }), { target: { value: '40' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save the rule' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith('Notte', { ...EDIT_RULE, limit: 40 }); // the name is passed along but never changed
  });

  it('the dialog title carries the playlist name', () => {
    renderDialog({ mode: 'edit', initialName: 'Notte', initialRule: EDIT_RULE });
    expect(screen.getByRole('dialog', { name: 'Rule of “Notte”' })).toBeInTheDocument();
  });
});
