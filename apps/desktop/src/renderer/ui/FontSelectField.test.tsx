import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FontSelectField } from './FontSelectField';

const options = [
  { id: 'sf-mono', title: 'SF Mono', stack: '"SF Mono", monospace' },
  { id: 'menlo', title: 'Menlo', stack: 'Menlo, monospace' },
  { id: 'fira-code', title: 'Fira Code', stack: '"Fira Code", monospace' },
];

function renderField(value: string, onChange = vi.fn()) {
  render(
    <FontSelectField ariaLabel="Font" value={value} options={options} onChange={onChange} />,
  );
  return { onChange, trigger: screen.getByRole('combobox', { name: 'Font' }) };
}

describe('FontSelectField', () => {
  it('shows the selected font on the trigger and stays closed initially', () => {
    const { trigger } = renderField('menlo');
    expect(trigger).toHaveTextContent('Menlo');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens on click and previews each option in its own font-family', () => {
    const { trigger } = renderField('menlo');
    fireEvent.click(trigger);

    const listbox = screen.getByRole('listbox', { name: 'Font' });
    expect(within(listbox).getAllByRole('option')).toHaveLength(3);

    const sfMono = within(listbox).getByRole('option', { name: 'SF Mono' });
    expect(within(sfMono).getByText('SF Mono').style.fontFamily).toContain('SF Mono');
    const fira = within(listbox).getByRole('option', { name: 'Fira Code' });
    expect(within(fira).getByText('Fira Code').style.fontFamily).toContain('Fira Code');
  });

  it('marks the current value as selected', () => {
    const { trigger } = renderField('menlo');
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: 'Menlo' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('option', { name: 'SF Mono' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('selects an option on click, fires onChange, and closes', () => {
    const { trigger, onChange } = renderField('menlo');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'Fira Code' }));
    expect(onChange).toHaveBeenCalledWith('fira-code');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens and navigates with arrow keys + Enter', () => {
    const { trigger, onChange } = renderField('sf-mono');
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // opens, highlights current (sf-mono)
    const listbox = screen.getByRole('listbox', { name: 'Font' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' }); // → Menlo
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('menlo');
  });

  it('supports type-ahead by first letter', () => {
    const { trigger, onChange } = renderField('sf-mono');
    fireEvent.click(trigger);
    const listbox = screen.getByRole('listbox', { name: 'Font' });
    fireEvent.keyDown(listbox, { key: 'f' }); // jumps to Fira Code
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('fira-code');
  });

  it('closes on Escape without selecting', () => {
    const { trigger, onChange } = renderField('menlo');
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Font' }), { key: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('commits + closes on pointer down even inside a wrapping label', () => {
    // FieldGroup renders a <label>; committing on pointer-down (not click) closes
    // the list before the label can forward the click back to the trigger.
    const onChange = vi.fn();
    render(
      <label>
        <span>Font</span>
        <FontSelectField ariaLabel="Font" value="menlo" options={options} onChange={onChange} />
      </label>,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Font' }));
    fireEvent.pointerDown(screen.getByRole('option', { name: 'Fira Code' }));
    expect(onChange).toHaveBeenCalledWith('fira-code');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
