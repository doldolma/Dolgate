// 셸 통합으로 인식한 "명령 블록" 위에 얹히는 오버레이.
//
// 터미널 렌더링은 건드리지 않고 hover 한 블록만 아주 옅게 강조하고, 우측 상단에 상태 칩과
// 액션 툴바를 띄운다. 루트는 pointer-events:none 이어서 터미널 텍스트 선택/드래그를 막지
// 않는다 — 툴바만 pointer-events 를 되살린다.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BLOCK_TOOLBAR_ATTRIBUTE } from '../../controllers/useTerminalBlockOverlay';
import type { TerminalBlockOverlayState } from '../../controllers/useTerminalBlockOverlay';
import { cn } from '../../lib/cn';
import { formatBlockDuration } from './blockFormat';
import { Check, ClipboardList, Copy, Play, Sparkles } from '../../ui/icons';
import { Tooltip } from '../../ui';
import { useTranslation } from 'react-i18next';

interface TerminalBlockOverlayProps {
  overlay: TerminalBlockOverlayState;
  /** 실행 중이면 재실행을 막는다 — 실행 중인 프로그램에 그대로 타이핑돼 버린다. */
  onCopyOutput: () => void;
  onCopyCommand: () => void;
  onRerun: () => void;
  /** 세션이 연결돼 있지 않으면 재실행이 아무 일도 못 한다 — 버튼을 눌리지 않게 한다. */
  rerunEnabled: boolean;
  onAskAi: () => void;
  aiEnabled: boolean;
  /**
   * 스티키 헤더와 겹칠 때 툴바를 그만큼 아래로 민다. 겹치지 않으면 0 이라 평소에는 블록
   * 상단에 붙는다(무조건 내리면 짧은 블록에서 영역 밖으로 나간다).
   */
  toolbarTopOffset: number;
}

export function TerminalBlockOverlay({
  overlay,
  onCopyOutput,
  onCopyCommand,
  onRerun,
  rerunEnabled,
  onAskAi,
  aiEnabled,
  toolbarTopOffset,
}: TerminalBlockOverlayProps) {
  const { t: translate } = useTranslation();
  const running = overlay.state === 'running';
  const failed = overlay.state === 'failed';
  const duration = formatBlockDuration(overlay.durationMs);
  const TOOLBAR_BASE_TOP_PX = 4;
  const TOOLBAR_HEIGHT_PX = 22;
  // 블록 안에 머물도록 상한을 둔다 — 블록이 짧으면 밀 수 있는 여지도 그만큼 줄어든다.
  const toolbarTop =
    TOOLBAR_BASE_TOP_PX +
    Math.max(
      0,
      Math.min(
        toolbarTopOffset,
        overlay.height - TOOLBAR_HEIGHT_PX - TOOLBAR_BASE_TOP_PX,
      ),
    );

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-[5]"
      style={{ top: overlay.top, height: overlay.height }}
      aria-hidden="true"
    >
      {/* 블록 영역 강조 — 글자 가독성을 해치지 않도록 아주 옅게만. */}
      <div
        className={cn(
          'absolute inset-0 rounded-[4px] border-l-2',
          failed
            ? 'border-l-[#ef6f6c] bg-[rgba(239,111,108,0.06)]'
            : running
              ? 'border-l-[#7aa2ff] bg-[rgba(122,162,255,0.06)]'
              : 'border-l-[rgba(122,200,160,0.5)] bg-[rgba(255,255,255,0.035)]',
        )}
      />

      {/* 하나의 바로 묶는다. 버튼마다 테두리를 주면 동그란 조각이 흩어져 떠 있는 것으로 보이고,
          앱의 라운드(8~12px)와도 어긋난다. 대비는 바 하나가 책임진다 — 터미널 배경은 테마마다
          다르므로 불투명이어야 한다(반투명이면 라이트 테마에서 거의 안 보인다). */}
      <div
        className="pointer-events-auto absolute right-2 flex items-center overflow-hidden rounded-[8px] border border-[rgba(255,255,255,0.14)] bg-[rgba(20,28,44,0.94)] shadow-[var(--shadow-soft)]"
        style={{ top: toolbarTop }}
        {...{ [BLOCK_TOOLBAR_ATTRIBUTE]: 'true' }}
      >
        {duration || failed ? (
          <span
            className={cn(
              'border-r border-[rgba(255,255,255,0.1)] px-2 text-[0.7rem] font-semibold tabular-nums leading-[22px]',
              failed ? 'text-[#ffb1b1]' : 'text-[rgba(232,239,255,0.95)]',
            )}
          >
            {failed && overlay.exitCode !== null
              ? `exit ${overlay.exitCode}${duration ? ` · ${duration}` : ''}`
              : duration}
          </span>
        ) : null}

        {/* 글자 대신 아이콘. 툴바가 짧아져 터미널을 덜 가린다 — 무엇인지는 툴팁이 말한다. */}
        <BlockCopyAction
          label={translate('blockOverlay.copyOutput')}
          onClick={onCopyOutput}
          icon={<ClipboardList className="h-3.5 w-3.5" aria-hidden />}
        />
        <BlockCopyAction
          label={translate('blockOverlay.copyCommand')}
          onClick={onCopyCommand}
          disabled={!overlay.command}
          icon={<Copy className="h-3.5 w-3.5" aria-hidden />}
        />
        <BlockAction
          label={translate('blockOverlay.rerun')}
          onClick={onRerun}
          disabled={
            running || !rerunEnabled || !overlay.command || overlay.commandUnreliable
          }
          title={
            running
              ? translate('blockOverlay.commandRunning')
              : !rerunEnabled
                ? translate('blockOverlay.sessionDisconnected')
                : overlay.commandUnreliable
                  ? translate('blockOverlay.rerunBlocked')
                  : undefined
          }
          icon={<Play className="h-3.5 w-3.5" aria-hidden />}
        />
        {aiEnabled ? (
          <BlockAction
            label={translate('blockOverlay.askAi')}
            onClick={onAskAi}
            icon={<Sparkles className="h-3.5 w-3.5" aria-hidden />}
          />
        ) : null}
      </div>
    </div>
  );
}

function BlockAction({
  label,
  onClick,
  disabled,
  title,
  icon,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  icon: ReactNode;
}) {
  return (
    // 글자를 뺐으니 이름은 툴팁이 말한다. 브라우저 기본 title 은 지연이 있어 아이콘 두 개를
    // 가르기엔 늦다 — 앱의 Tooltip 은 즉시 뜨고, 잠긴 버튼에서도 이유를 보여 준다.
    <Tooltip label={title ?? label}>
      <button
        type="button"
        // 터미널 배경(테마마다 다름) 위에 얹히므로 불투명 배경으로 대비를 확보한다.
        // 버튼 자체는 테두리·배경 없이 바 안의 칸으로만 존재한다.
        className="grid h-[22px] w-[24px] place-items-center text-[rgba(226,234,255,0.85)] transition-colors duration-150 hover:bg-[rgba(255,255,255,0.1)] hover:text-white disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        // 터미널이 포커스를 잃지 않도록 mousedown 기본동작(포커스 이동)을 막는다.
        onMouseDown={(event) => event.preventDefault()}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

/**
 * 복사 버튼. 누르면 잠깐 체크로 바뀐다 — 클립보드는 눈에 보이는 변화가 없어서, 반응이 없으면
 * 복사가 됐는지 알 수 없다(세션 패널·AI 패널의 복사와 같은 방식).
 */
function BlockCopyAction({
  label,
  onClick,
  disabled,
  icon,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon: ReactNode;
}) {
  const { t: translate } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  return (
    <BlockAction
      label={copied ? translate('blockOverlay.copied') : label}
      disabled={disabled}
      onClick={() => {
        onClick();
        setCopied(true);
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => setCopied(false), 1200);
      }}
      icon={
        copied ? <Check className="h-3.5 w-3.5 text-[#7ac8a0]" aria-hidden /> : icon
      }
    />
  );
}
