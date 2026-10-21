import { forwardRef, useEffect, useState, type InputHTMLAttributes } from 'react';
import { Input } from './Input';

type NumberInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: number;
  /** 친 글자가 숫자일 때만 부른다. 비었거나 숫자가 아닌 동안은 부르지 않는다. */
  onValueChange: (value: number) => void;
};

/**
 * 숫자 칸 — 고치는 동안 친 글자(빈 값 포함)를 이 칸이 들고 있는다.
 *
 * 값을 바로 숫자로 바꾸며 빈 값을 기본값으로 채우면(`Number(v) || 22`) 지우는 순간 칸이 기본값으로 돌아가고,
 * 이어 친 숫자가 그 뒤에 붙는다 — 80 을 치면 2280 이 되고, 범위 안이라 막히지도 않는다. 그래서 글자가 숫자일
 * 때만 값을 올리고, 비운 채 칸을 떠나면 마지막 값으로 되돌린다.
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, onValueChange, onBlur, ...props },
  ref,
) {
  const [text, setText] = useState(() => String(value));

  // 밖에서 값이 바뀌면(다른 호스트를 고름 등) 따라간다. 친 글자가 이미 그 수면 그대로 둔다.
  useEffect(() => {
    setText((current) => (isNumberText(current) && Number(current) === value ? current : String(value)));
  }, [value]);

  return (
    <Input
      ref={ref}
      type="number"
      {...props}
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (isNumberText(next)) {
          onValueChange(Number(next));
        }
      }}
      onBlur={(event) => {
        if (!isNumberText(text)) {
          setText(String(value));
        }
        onBlur?.(event);
      }}
    />
  );
});

function isNumberText(text: string): boolean {
  return text.trim() !== '' && Number.isFinite(Number(text));
}
