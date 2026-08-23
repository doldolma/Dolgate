// 패널 목록의 한 줄. 히스토리와 스니펫이 같은 줄 모양·같은 세 버튼을 쓴다.
//
// 경계선을 긋지 않는다. 340px 폭에 줄마다 선을 그으면 표처럼 보여, 앱의 다른 목록(호스트
// 상세·포트)과 결이 어긋난다. 대신 hover·선택에 배경만 준다.
//
// 세 버튼(복사 / 화면에 입력 / 입력 후 엔터)은 hover·포커스에서 나타나되 **자리는 늘 잡아
// 둔다.** 없을 때 접히면 마우스를 올릴 때마다 글자가 밀려 목록이 흔들린다.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../../lib/cn';
import { Check, Copy, Play, TextCursorInput } from '../../../ui/icons';
import { Tooltip } from '../../../ui';
import type { SessionPanelActions } from '../../../lib/session-panel';
import { useTranslation } from 'react-i18next';

interface SessionPanelRowProps {
  /** 명령 또는 스니펫 텍스트. 여러 줄이면 여러 줄로 보인다. */
  text: string;
  /** 두 번째 줄(작업 디렉터리·시각·종료 코드·키워드). */
  meta?: ReactNode;
  actions: SessionPanelActions;
  /** 잠긴 버튼에 붙이는 이유(툴팁). 줄 안에 딱지로 늘어놓지 않는다. */
  blockedHint?: string | null;
  onCopy: () => void;
  onInsert: () => void;
  onRun: () => void;
  /** 줄 자체를 누르면 하는 일(히스토리: 스크롤백의 그 위치로 이동). */
  onActivate?: () => void;
  activateLabel?: string;
}

function RowAction({
  label,
  hint,
  disabled,
  onClick,
  children,
}: {
  label: string;
  hint?: string | null;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label={disabled ? (hint ?? label) : label}>
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        onClick={(event) => {
          // 줄 전체가 "이 명령으로 이동" 이므로 버튼 클릭이 그것까지 발동하지 않게 막는다.
          event.stopPropagation();
          onClick();
        }}
        className="grid h-6 w-6 place-items-center rounded-[7px] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-30"
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * 복사 버튼. 누르면 잠깐 체크로 바뀐다 — 클립보드는 눈에 보이는 변화가 없어서, 반응이 없으면
 * 복사가 됐는지 알 수 없다(AI 패널의 코드블록 복사와 같은 방식).
 */
function CopyRowAction({ disabled, onCopy }: { disabled: boolean; onCopy: () => void }) {
  const { t: translate } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 언마운트 뒤에 타이머가 남아 setState 를 부르면 테스트가 경고를 낸다(예전에 CI 를 흔든 그것).
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  return (
    <RowAction
      label={copied ? translate('sessionPanel.copied') : translate('sessionPanel.copy')}
      disabled={disabled}
      onClick={() => {
        onCopy();
        setCopied(true);
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-[var(--success-text)]" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
    </RowAction>
  );
}

export function SessionPanelRow({
  text,
  meta,
  actions,
  blockedHint,
  onCopy,
  onInsert,
  onRun,
  onActivate,
  activateLabel,
}: SessionPanelRowProps) {
  const { t: translate } = useTranslation();
  const lines = text.split('\n');

  return (
    <div
      role={onActivate ? 'button' : undefined}
      tabIndex={onActivate ? 0 : undefined}
      aria-label={onActivate ? activateLabel : undefined}
      onClick={onActivate}
      onKeyDown={
        onActivate
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onActivate();
              }
            }
          : undefined
      }
      className={cn(
        'group rounded-[9px] px-2.5 py-2 transition-colors',
        onActivate && 'cursor-pointer',
        'hover:bg-[var(--surface-muted)] focus-visible:bg-[var(--surface-muted)] focus-visible:outline-none',
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {/* 여러 줄은 여러 줄로 보여 준다. 한 줄로 접으면 실행할 수 없는 문자열이 평범한
              한 줄 명령처럼 보인다(리플레이 패널에서 겪은 그것). */}
          {lines.map((line, index) => (
            <p
              key={index}
              className={cn(
                'truncate font-mono text-[0.78rem] leading-[1.45]',
                index === 0 ? 'text-[var(--text)]' : 'text-[var(--text-soft)]',
              )}
            >
              {line}
            </p>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-focus-visible:opacity-100 group-hover:opacity-100">
          <CopyRowAction disabled={!actions.canCopy} onCopy={onCopy} />
          <RowAction
            label={translate('sessionPanel.insert')}
            hint={blockedHint}
            disabled={!actions.canInsert}
            onClick={onInsert}
          >
            <TextCursorInput className="h-3.5 w-3.5" aria-hidden />
          </RowAction>
          <RowAction
            label={translate('sessionPanel.run')}
            hint={blockedHint}
            disabled={!actions.canRun}
            onClick={onRun}
          >
            <Play className="h-3.5 w-3.5" aria-hidden />
          </RowAction>
        </div>
      </div>
      {meta ? (
        <p className="mt-0.5 truncate text-[0.7rem] leading-[1.4] text-[var(--text-soft)]">
          {meta}
        </p>
      ) : null}
    </div>
  );
}
