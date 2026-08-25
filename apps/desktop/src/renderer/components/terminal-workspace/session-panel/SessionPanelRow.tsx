// 패널 목록의 한 줄. 히스토리와 스니펫이 같은 줄 모양·같은 세 버튼을 쓴다.
//
// 경계선을 긋지 않는다. 340px 폭에 줄마다 선을 그으면 표처럼 보여, 앱의 다른 목록(호스트
// 상세·포트)과 결이 어긋난다. 대신 hover·선택에 배경만 준다.
//
// 세 버튼(복사 / 화면에 입력 / 입력 후 엔터)은 hover·포커스에서 나타나되 **자리는 늘 잡아
// 둔다.** 없을 때 접히면 마우스를 올릴 때마다 글자가 밀려 목록이 흔들린다.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../../lib/cn';
import { Check, Copy, Pencil, Play, TextCursorInput } from '../../../ui/icons';
import { Tooltip } from '../../../ui';
import type { SessionPanelActions } from '../../../lib/session-panel';
import { useTranslation } from 'react-i18next';

interface SessionPanelRowProps {
  /** 명령 또는 스니펫 텍스트. 여러 줄이면 여러 줄로 보인다. */
  text: string;
  /**
   * 명령 오른쪽, 버튼 앞에 놓이는 작은 표시(반복 횟수 등).
   *
   * hover 로 나타나는 버튼과 자리를 다투지 않는다 — 버튼은 늘 자리를 잡고 있으므로 이 값이
   * 있어도 줄이 밀리지 않는다.
   */
  trailing?: ReactNode;
  /**
   * 한 줄짜리 목록을 촘촘하게. 위아래 여백과 버튼을 한 단계 줄인다.
   *
   * 이전 명령처럼 딸린 정보가 없는(작업 디렉터리도, 종료 코드도 없는) 목록에 쓴다 — 짧은 명령
   * 한 줄에 40px 을 쓰면 화면에 스무 줄밖에 안 들어가 목록을 훑는 데 계속 스크롤해야 한다.
   */
  dense?: boolean;
  /** 두 번째 줄 왼쪽(작업 디렉터리·키워드). */
  meta?: ReactNode;
  /**
   * 두 번째 줄 오른쪽(시각·소요·종료 코드).
   *
   * 왼쪽 문구와 한 문자열로 이으면 줄마다 길이가 달라 숫자가 세로로 맞지 않는다. 오른쪽에
   * 붙여 두면 목록 전체에서 같은 자리에 온다.
   */
  metaTrailing?: ReactNode;
  actions: SessionPanelActions;
  /** 잠긴 버튼에 붙이는 이유(툴팁). 줄 안에 딱지로 늘어놓지 않는다. */
  blockedHint?: string | null;
  onCopy: () => void;
  onInsert: () => void;
  onRun: () => void;
  /**
   * 편집(스니펫). 주는 쪽만 버튼이 생긴다 — 히스토리 줄에는 고칠 것이 없다.
   *
   * **보내기 버튼 뒤에 붙인다.** 앞에 끼우면 복사·입력·실행이 전부 오른쪽으로 밀려, 손이 기억한
   * 자리가 바뀐다.
   *
   * 삭제는 여기 없다. 줄의 가장 바깥에 두었더니 마우스가 오른쪽에서 들어올 때 제일 먼저 닿았고,
   * 다섯 버튼이 좁은 패널의 명령 텍스트를 그만큼 잘라 먹었다. 편집 폼 안으로 옮겼다
   * (SnippetEditDialog 의 onRemove 주석).
   */
  onEdit?: () => void;
  /** 줄 자체를 누르면 하는 일(히스토리: 스크롤백의 그 위치로 이동). */
  onActivate?: () => void;
  activateLabel?: string;
}

function RowAction({
  label,
  hint,
  disabled,
  dense,
  subtle,
  onClick,
  children,
}: {
  label: string;
  hint?: string | null;
  disabled: boolean;
  dense?: boolean;
  /** 쉬는 상태의 색을 한 단계 낮춘다(주 동작이 아닌 버튼). hover 하면 같아진다. */
  subtle?: boolean;
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
        className={cn(
          'grid place-items-center rounded-[7px] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-30',
          subtle ? 'text-[var(--text-muted)]' : 'text-[var(--text-soft)]',
          // 줄 높이를 정하는 것은 글자가 아니라 이 버튼이다 — 촘촘한 목록에서는 이것도 줄여야
          // 여백만 줄인 것보다 실제로 짧아진다.
          dense ? 'h-5 w-5' : 'h-6 w-6',
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** 버튼 안 아이콘 크기. 촘촘한 줄에서는 버튼과 함께 한 단계 줄인다. */
function iconClass(dense?: boolean): string {
  return dense ? 'h-3 w-3' : 'h-3.5 w-3.5';
}

/**
 * 복사 버튼. 누르면 잠깐 체크로 바뀐다 — 클립보드는 눈에 보이는 변화가 없어서, 반응이 없으면
 * 복사가 됐는지 알 수 없다(AI 패널의 코드블록 복사와 같은 방식).
 */
function CopyRowAction({
  disabled,
  dense,
  onCopy,
}: {
  disabled: boolean;
  dense?: boolean;
  onCopy: () => void;
}) {
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
      dense={dense}
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
        <Check
          className={cn(iconClass(dense), 'text-[var(--success-text)]')}
          aria-hidden
        />
      ) : (
        <Copy className={iconClass(dense)} aria-hidden />
      )}
    </RowAction>
  );
}

export function SessionPanelRow({
  text,
  trailing,
  dense,
  meta,
  metaTrailing,
  actions,
  blockedHint,
  onCopy,
  onInsert,
  onRun,
  onEdit,
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
        'group rounded-[9px] px-2.5 transition-colors',
        dense ? 'py-1' : 'py-2',
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
        {trailing ? (
          <span
            className={cn(
              'shrink-0 tabular-nums text-[0.68rem] text-[var(--text-muted)]',
              dense ? 'mt-[0.1rem]' : 'mt-[0.2rem]',
            )}
          >
            {trailing}
          </span>
        ) : null}
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-focus-visible:opacity-100 group-hover:opacity-100">
          <CopyRowAction disabled={!actions.canCopy} dense={dense} onCopy={onCopy} />
          <RowAction
            label={translate('sessionPanel.insert')}
            hint={blockedHint}
            disabled={!actions.canInsert}
            dense={dense}
            onClick={onInsert}
          >
            <TextCursorInput className={iconClass(dense)} aria-hidden />
          </RowAction>
          <RowAction
            label={translate('sessionPanel.run')}
            hint={blockedHint}
            disabled={!actions.canRun}
            dense={dense}
            onClick={onRun}
          >
            <Play className={iconClass(dense)} aria-hidden />
          </RowAction>
          {onEdit ? (
            <>
              {/* 보내기와 관리 사이 구분선. 한 덩어리로 붙으면 목적이 다른 버튼이 같은 무리로
                  보인다. */}
              <span
                aria-hidden
                className={cn(
                  'mx-0.5 w-px bg-[var(--border)]',
                  dense ? 'h-3' : 'h-3.5',
                )}
              />
              <RowAction
                label={translate('sessionPanel.snippets.edit')}
                disabled={false}
                dense={dense}
                // 관리 동작은 한 단계 옅게. 보내기와 같은 색이면 넷이 같은 무게로 보여 주
                // 동작이 드러나지 않는다(hover 하면 또렷해진다).
                subtle
                onClick={onEdit}
              >
                <Pencil className={iconClass(dense)} aria-hidden />
              </RowAction>
            </>
          ) : null}
        </div>
      </div>
      {meta || metaTrailing ? (
        <div className="mt-0.5 flex items-baseline gap-2 text-[0.7rem] leading-[1.4] text-[var(--text-soft)]">
          <span className="min-w-0 flex-1 truncate">{meta}</span>
          {metaTrailing ? (
            <span className="shrink-0 tabular-nums">{metaTrailing}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
