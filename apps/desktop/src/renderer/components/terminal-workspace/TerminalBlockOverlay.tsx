// 셸 통합으로 인식한 "명령 블록" 위에 얹히는 오버레이.
//
// 터미널 렌더링은 건드리지 않고 hover 한 블록만 아주 옅게 강조하고, 우측 상단에 상태 칩과
// 액션 툴바를 띄운다. 루트는 pointer-events:none 이어서 터미널 텍스트 선택/드래그를 막지
// 않는다 — 툴바만 pointer-events 를 되살린다.

import { BLOCK_TOOLBAR_ATTRIBUTE } from '../../controllers/useTerminalBlockOverlay';
import type { TerminalBlockOverlayState } from '../../controllers/useTerminalBlockOverlay';
import { cn } from '../../lib/cn';
import { formatBlockDuration } from './blockFormat';
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

      <div
        className="pointer-events-auto absolute right-2 flex items-center gap-1.5"
        style={{ top: toolbarTop }}
        {...{ [BLOCK_TOOLBAR_ATTRIBUTE]: 'true' }}
      >
        {duration || failed ? (
          <span
            className={cn(
              // 터미널 배경(테마마다 다름) 위에 얹히므로 불투명 배경으로 대비를 확보한다.
              // 반투명이면 배경이 비쳐 라이트 테마에서 거의 안 보인다.
              'rounded-full border px-2 py-0.5 text-[0.7rem] font-semibold tabular-nums shadow-[var(--shadow-soft)]',
              failed
                ? 'border-[rgba(239,111,108,0.45)] bg-[rgba(58,22,24,0.95)] text-[#ffb1b1]'
                : 'border-[rgba(255,255,255,0.12)] bg-[rgba(20,28,44,0.92)] text-[rgba(232,239,255,0.95)]',
            )}
          >
            {failed && overlay.exitCode !== null
              ? `exit ${overlay.exitCode}${duration ? ` · ${duration}` : ''}`
              : duration}
          </span>
        ) : null}

        <BlockAction label={translate('blockOverlay.copyOutput')} onClick={onCopyOutput} />
        <BlockAction
          label={translate('blockOverlay.copyCommand')}
          onClick={onCopyCommand}
          disabled={!overlay.command}
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
        />
        {aiEnabled ? <BlockAction label="AI" onClick={onAskAi} /> : null}
      </div>
    </div>
  );
}

function BlockAction({
  label,
  onClick,
  disabled,
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="rounded-full border border-[rgba(255,255,255,0.12)] bg-[rgba(20,28,44,0.9)] px-2 py-0.5 text-[0.7rem] font-semibold text-[rgba(226,234,255,0.9)] shadow-[var(--shadow-soft)] transition-colors duration-150 hover:bg-[rgba(40,52,78,0.95)] disabled:cursor-not-allowed disabled:opacity-40"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      // 터미널이 포커스를 잃지 않도록 mousedown 기본동작(포커스 이동)을 막는다.
      onMouseDown={(event) => event.preventDefault()}
    >
      {label}
    </button>
  );
}
