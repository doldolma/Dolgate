import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NumberInput } from './NumberInput';

function Harness({ initial, onValue }: { initial: number; onValue: (value: number) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <NumberInput
        aria-label="Port"
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onValue(next);
        }}
      />
      <button type="button" onClick={() => setValue(5432)}>
        outside
      </button>
    </>
  );
}

describe('NumberInput', () => {
  it('keeps the field empty while typing over it — the typed number is not appended to the old value', () => {
    const onValue = vi.fn();
    render(<Harness initial={22} onValue={onValue} />);
    const input = screen.getByLabelText('Port') as HTMLInputElement;

    // 백스페이스로 다 지우고 80 을 친다.
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.change(input, { target: { value: '80' } });

    expect(input.value).toBe('80');
    expect(onValue.mock.calls.map(([value]) => value)).toEqual([2, 8, 80]);
  });

  it('restores the last value when the field is left empty', () => {
    const onValue = vi.fn();
    render(<Harness initial={22} onValue={onValue} />);
    const input = screen.getByLabelText('Port') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(input.value).toBe('22');
    expect(onValue).not.toHaveBeenCalled();
  });

  it('follows a value changed from outside', () => {
    render(<Harness initial={22} onValue={vi.fn()} />);
    const input = screen.getByLabelText('Port') as HTMLInputElement;

    fireEvent.click(screen.getByRole('button', { name: 'outside' }));

    expect(input.value).toBe('5432');
  });
});
