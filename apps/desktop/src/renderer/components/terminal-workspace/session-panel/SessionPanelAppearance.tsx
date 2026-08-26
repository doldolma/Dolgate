// 터미널 글꼴·크기·행간·자간·최소 대비. 설정 화면에도 같은 항목이 있지만, 여기서 만지면 터미널을
// 보면서 맞출 수 있다.
//
// 라벨은 설정 화면(General → Terminal)과 **같은 영어 단어**를 쓴다. 같은 값을 만지는 두 화면이
// 한쪽은 "크기", 다른 쪽은 "Font Size" 면 같은 것인지 알 수 없다. 설명 문장은 한국어 그대로다 —
// 설정 화면도 라벨은 영어, 힌트는 번역이다.
//
// 값은 전역 설정 하나다(AppSettings). 배관은 이미 있다 — useTerminalSessionViewController 가
// appearance 변화마다 runtime.setAppearance() + 리사이즈를 부르므로 열린 터미널에 바로 반영된다.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TerminalFontFamilyId } from '@shared';
import { useAppStore } from '../../../store/appStore';
import { visibleTerminalFontOptions } from '../../../lib/terminal-presets';
import { FontSelectField } from '../../../ui';
import { ChevronDown, ChevronRight, Minus, Plus, Type } from '../../../ui/icons';

/**
 * 값의 범위와 기본값. main/database.ts 의 clamp 와 같아야 한다 — 여기서 넘겨도 저장 쪽이
 * 잘라내므로, 어긋나면 화면의 숫자와 실제 값이 달라진다.
 */
const RANGES = {
  fontSize: { min: 11, max: 18, step: 1, digits: 0, defaultValue: 13 },
  lineHeight: { min: 1, max: 2, step: 0.05, digits: 2, defaultValue: 1 },
  letterSpacing: { min: 0, max: 2, step: 1, digits: 0, defaultValue: 0 },
  contrast: { min: 1, max: 21, step: 0.5, digits: 1, defaultValue: 1 },
} as const;

const DEFAULT_CONTRAST = RANGES.contrast.defaultValue;

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function SessionPanelAppearance() {
  const { t: translate } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  // 한 번 맞춰 놓으면 다시 만질 일이 드문 값들이다. 펼쳐 둔 채로 두면 테마 목록이 화면 밖으로
  // 밀려난다 — 접어 두고, 지금 값은 머리글에 요약해서 열지 않고도 보이게 한다.
  const [expanded, setExpanded] = useState(false);

  if (!settings) {
    return null;
  }

  const fontOptions = visibleTerminalFontOptions(
    document.documentElement.dataset.platform,
  );
  // 저장된 설정에 항목이 없을 수 있다(예전 버전에서 올라온 저장소). 없으면 기본값으로 읽는다 —
  // undefined 를 그대로 쓰면 화면이 터진다.
  const fontSize = settings.terminalFontSize ?? RANGES.fontSize.defaultValue;
  const lineHeight = settings.terminalLineHeight ?? RANGES.lineHeight.defaultValue;
  const letterSpacing = settings.terminalLetterSpacing ?? RANGES.letterSpacing.defaultValue;
  const contrast = settings.terminalMinimumContrastRatio ?? DEFAULT_CONTRAST;

  const isDefault =
    fontSize === RANGES.fontSize.defaultValue &&
    lineHeight === RANGES.lineHeight.defaultValue &&
    letterSpacing === RANGES.letterSpacing.defaultValue &&
    contrast === DEFAULT_CONTRAST;

  const fontTitle =
    fontOptions.find((option) => option.id === settings.terminalFontFamily)?.title ??
    fontOptions[0].title;

  return (
    <div className="px-2 pb-2.5 pt-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((previous) => !previous)}
        className="flex w-full items-center gap-2.5 rounded-[10px] p-1.5 text-left transition-colors hover:bg-[var(--surface-muted)]"
      >
        <Type className="ml-1 h-4 w-4 shrink-0 text-[var(--text-soft)]" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.82rem] text-[var(--text)]">
            {translate('sessionPanel.appearance.font')}
          </span>
          {/* 접혀 있어도 지금 무엇으로 보고 있는지는 알아야 한다. */}
          <span className="block truncate text-[0.72rem] text-[var(--text-muted)]">
            {translate('sessionPanel.appearance.summary', {
              font: fontTitle,
              size: fontSize,
            })}
          </span>
        </span>
        {expanded ? (
          <ChevronDown className="mr-1 h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
        ) : (
          <ChevronRight className="mr-1 h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
        )}
      </button>

      {expanded ? (
        <div className="grid gap-2.5 px-2 pb-1 pt-3">
          <FontSelectField
            ariaLabel={translate('sessionPanel.appearance.font')}
            value={settings.terminalFontFamily ?? fontOptions[0].id}
            options={fontOptions}
            size="sm"
            onChange={(id) =>
              void updateSettings({ terminalFontFamily: id as TerminalFontFamilyId })
            }
          />

          <Stepper
            label={translate('sessionPanel.appearance.fontSize')}
            value={fontSize}
            range={RANGES.fontSize}
            format={(value) => `${value}px`}
            onChange={(terminalFontSize) => void updateSettings({ terminalFontSize })}
          />
          <Stepper
            label={translate('sessionPanel.appearance.lineHeight')}
            value={lineHeight}
            range={RANGES.lineHeight}
            format={(value) => value.toFixed(2)}
            onChange={(terminalLineHeight) => void updateSettings({ terminalLineHeight })}
          />
          <Stepper
            label={translate('sessionPanel.appearance.letterSpacing')}
            value={letterSpacing}
            range={RANGES.letterSpacing}
            format={(value) => String(value)}
            onChange={(terminalLetterSpacing) =>
              void updateSettings({ terminalLetterSpacing })
            }
          />

          <Stepper
            label={translate('sessionPanel.appearance.contrast')}
            value={contrast}
            range={RANGES.contrast}
            // 1 은 끈 상태다. 숫자로만 보이면 "1" 이 무슨 뜻인지 알 수 없다.
            format={(value) =>
              value === DEFAULT_CONTRAST
                ? translate('sessionPanel.appearance.contrastOff')
                : value.toFixed(1)
            }
            onChange={(terminalMinimumContrastRatio) =>
              void updateSettings({ terminalMinimumContrastRatio })
            }
          />
          <p className="-mt-1 text-[0.68rem] leading-[1.45] text-[var(--text-muted)]">
            {translate('settings.preferences.contrastHint')}
          </p>

          {/* 전역 값을 즉석에서 만지는 화면이라 되돌릴 길이 없으면 아예 안 만지게 된다. */}
          <div className="flex justify-end">
            <button
              type="button"
              disabled={isDefault}
              onClick={() =>
                void updateSettings({
                  terminalFontSize: RANGES.fontSize.defaultValue,
                  terminalLineHeight: RANGES.lineHeight.defaultValue,
                  terminalLetterSpacing: RANGES.letterSpacing.defaultValue,
                  terminalMinimumContrastRatio: RANGES.contrast.defaultValue,
                })
              }
              className="rounded-[6px] px-1.5 py-0.5 text-[0.68rem] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-35"
            >
              {translate('sessionPanel.appearance.reset')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface StepperRange {
  min: number;
  max: number;
  step: number;
  digits: number;
}

/**
 * `− 값 +`.
 *
 * 숫자 입력이 아닌 이유가 둘이다: 340px 패널에서 클릭 타겟이 너무 작고, 키 반복으로 값이 튀면
 * updateSettings 가 그만큼 디스크에 쓴다(클릭당 한 번이면 그 문제가 없다).
 */
function Stepper({
  label,
  value,
  range,
  format,
  onChange,
}: {
  label: string;
  value: number;
  range: StepperRange;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const { t: translate } = useTranslation();
  const step = (direction: -1 | 1) => {
    const next = round(value + direction * range.step, range.digits);
    if (next < range.min || next > range.max) {
      return;
    }
    onChange(next);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-[0.72rem] text-[var(--text-soft)]">
        {label}
      </span>
      <span className="flex shrink-0 items-center overflow-hidden rounded-[7px] shadow-[inset_0_0_0_1px_var(--border)]">
        <StepButton
          label={translate('sessionPanel.appearance.decrease', { label })}
          disabled={round(value - range.step, range.digits) < range.min}
          onClick={() => step(-1)}
        >
          <Minus className="h-3 w-3" aria-hidden />
        </StepButton>
        <span className="min-w-[2.6rem] text-center text-[0.72rem] tabular-nums text-[var(--text)]">
          {format(value)}
        </span>
        <StepButton
          label={translate('sessionPanel.appearance.increase', { label })}
          disabled={round(value + range.step, range.digits) > range.max}
          onClick={() => step(1)}
        >
          <Plus className="h-3 w-3" aria-hidden />
        </StepButton>
      </span>
    </div>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-6 w-6 place-items-center text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
